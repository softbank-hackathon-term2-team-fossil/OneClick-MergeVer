import "server-only";

import { rollbackCloudRunService } from "@/lib/deploy/cloud-run-target";
import { serviceNameFor } from "@/lib/deploy/helpers";
import { beginDeployment, completeDeployment, failDeployment, listDeployments, resolveRollback } from "@/lib/deployment-history";
import { getDeploymentConnection } from "@/lib/deployment-store";
import { assertDockerHubArtifact, dockerHubPullCredential, dockerHubTag } from "@/lib/dockerhub";
import { getAppEnv } from "@/lib/env-store";
import { httpCheck, isSameServer, MonitorRegistry, type MonitorConfig } from "@/lib/health-monitor";
import { deployToOnPremise } from "@/lib/on-premise-deployment";

// Restores the newest earlier successful on-premises deployment of a fixed commit.
async function rollbackOnPremise(installationId: number, repository: string): Promise<string> {
  const records = await listDeployments(installationId, repository, 30);
  const current = records.find((record) => record.target === "ONPREM" && record.status === "SUCCESS" && record.current);
  const previous = records.find((record) => record.canRollback && record.imageTag !== current?.imageTag);
  if (!previous) throw new Error("되돌아갈 이전 성공 배포가 없습니다.");

  const connection = await getDeploymentConnection(installationId, repository);
  if (!connection) throw new Error("저장된 배포 서버가 없습니다.");
  // Never roll back onto a server other than the one that served the failing deployment.
  if (current && !isSameServer(current.destination, connection.host, connection.hostPort)) {
    throw new Error(
      `저장된 서버(${connection.host}:${connection.hostPort})가 장애 배포의 서버(${current.destination ?? "알 수 없음"})와 달라 자동 롤백을 중단했습니다.`,
    );
  }

  const rollback = await resolveRollback(installationId, repository, previous.id);
  await assertDockerHubArtifact(repository, rollback.imageTag);
  const credential = dockerHubPullCredential();
  const image = dockerHubTag(repository, rollback.imageTag);
  const record = await beginDeployment({
    installationId,
    repository,
    target: "ONPREM",
    imageTag: rollback.imageTag,
    image,
    destination: `${connection.host}:${connection.hostPort}`,
    rollbackOf: rollback.id,
  });
  try {
    const { publicUrl } = await deployToOnPremise({
      ...connection,
      image,
      registry: credential.registry,
      registryUsername: credential.username,
      registryPassword: credential.password,
      env: await getAppEnv(installationId, repository),
    });
    const localUrl = `http://${connection.host.includes(":") ? `[${connection.host}]` : connection.host}:${connection.hostPort}`;
    await completeDeployment(record.id, { url: publicUrl || localUrl });
    return `#${current?.number ?? "?"} → #${rollback.number} (${rollback.imageTag.slice(0, 7)})`;
  } catch (error) {
    await failDeployment(record.id, error);
    throw error;
  }
}

async function rollback(config: MonitorConfig): Promise<string> {
  if (config.target === "CLOUD_RUN") return rollbackCloudRunService(serviceNameFor(config.repository));
  if (config.target === "ONPREM") {
    if (config.installationId === undefined) throw new Error("설치 정보가 없어 롤백할 수 없습니다.");
    return rollbackOnPremise(config.installationId, config.repository);
  }
  throw new Error(`${config.target} 대상은 자동 롤백을 지원하지 않습니다.`);
}

type Holder = { __sbsbMonitors?: MonitorRegistry };

// One registry per server process; globalThis keeps it across hot reloads in development.
export function monitorRegistry(): MonitorRegistry {
  const holder = globalThis as Holder;
  holder.__sbsbMonitors ??= new MonitorRegistry({ check: (url) => httpCheck(url), rollback });
  return holder.__sbsbMonitors;
}
