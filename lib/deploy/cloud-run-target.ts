import "server-only";

import { createCloudRunDeployer, loadServiceAccountKey } from "./cloud-run";
import { withLock } from "./helpers";
import type { DeployLogger, DeployRequest, DeployResult } from "./types";

// The Cloud Run target is configured once on the site server (like the AWS account and Azure
// subscription), not entered by the person deploying.
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export type CloudRunTarget = { projectId: string; location: string };

export function cloudRunTarget(): CloudRunTarget | null {
  const projectId = env("GCP_PROJECT_ID");
  if (!projectId || !env("GOOGLE_APPLICATION_CREDENTIALS")) return null;
  return { projectId, location: env("GCP_LOCATION") ?? "us-central1" };
}

export async function deployToCloudRun(request: DeployRequest, log: DeployLogger = () => undefined): Promise<DeployResult> {
  const target = cloudRunTarget();
  if (!target) throw new Error("Cloud Run 대상이 서버에 설정되지 않았습니다. GCP_PROJECT_ID와 GOOGLE_APPLICATION_CREDENTIALS를 확인하세요.");
  const key = await loadServiceAccountKey(env("GOOGLE_APPLICATION_CREDENTIALS") as string);
  const deployer = createCloudRunDeployer(
    {
      proxy: { ...target, repository: env("GCP_PROXY_REPOSITORY") ?? "dockerhub-proxy" },
      maxInstances: Number(env("GCP_MAX_INSTANCES") ?? "2"),
      publicAccess: env("GCP_PUBLIC_ACCESS") !== "false",
    },
    key,
  );
  // One deployment at a time per service: two overlapping updates would race on the serving revision.
  return withLock(`cloud-run:${request.serviceName}`, () => deployer.deploy(request, log));
}
