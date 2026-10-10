import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import {
  deleteDeploymentConnection,
  getDeploymentConnection,
  getSavedDeploymentTarget,
  saveDeploymentConnection,
  type DeploymentConnection,
} from "@/lib/deployment-store";
import {
  beginDeployment,
  completeDeployment,
  DeploymentError,
  failDeployment,
  resolveRollback,
} from "@/lib/deployment-history";
import {
  assertDockerHubArtifact,
  dockerHubPullCredential,
  dockerHubTag,
} from "@/lib/dockerhub";
import { getInstallationClient, parseRepository } from "@/lib/github";
import { deployToOnPremise, testSshConnection } from "@/lib/on-premise-deployment";
import { requireInstallationId } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 300;

const connectionSchema = z.object({
  host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9._:-]+$/),
  sshPort: z.coerce.number().int().min(1).max(65_535),
  username: z.string().trim().min(1).max(32).regex(/^[a-z_][a-z0-9_-]*[$]?$/i),
  password: z.string().max(1_024).optional(),
  privateKey: z.string().max(32_768).optional(),
  hostPort: z.coerce.number().int().min(1).max(65_535),
  containerPort: z.coerce.number().int().min(1).max(65_535),
}).refine((value) => Boolean(value.password?.length || value.privateKey?.length), {
  message: "SSH password or private key is required.",
});

const requestSchema = z.object({
  repository: z.string().min(3).max(200),
  host: z.string().optional(),
  sshPort: z.union([z.string(), z.number()]).optional(),
  username: z.string().optional(),
  password: z.string().max(1_024).optional(),
  privateKey: z.string().max(32_768).optional(),
  hostPort: z.union([z.string(), z.number()]).optional(),
  containerPort: z.union([z.string(), z.number()]).optional(),
  imageTag: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/).default("latest"),
  // Restore a past deployment: its commit is redeployed to the saved server.
  rollbackOf: z.string().min(1).max(64).optional(),
  useSavedConnection: z.boolean().default(false),
  saveConnection: z.boolean().default(true),
  saveOnly: z.boolean().default(false),
});

async function verifyRepositoryAccess(installationId: number, repository: string) {
  const { owner, repo } = parseRepository(repository);
  const client = await getInstallationClient(installationId);
  await client.rest.repos.get({ owner, repo });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const repository = request.nextUrl.searchParams.get("repository") ?? "";
    await verifyRepositoryAccess(installationId, repository);
    const target = await getSavedDeploymentTarget(installationId, repository);
    return NextResponse.json({ target });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const repository = request.nextUrl.searchParams.get("repository") ?? "";
    await verifyRepositoryAccess(installationId, repository);
    await deleteDeploymentConnection(installationId, repository);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const body = requestSchema.parse(await request.json());
    await verifyRepositoryAccess(installationId, body.repository);

    // If the user only wants to register/test the server connection without deploying yet:
    if (body.saveOnly) {
      const connection = connectionSchema.parse(body);
      await testSshConnection(connection);
      const target = await saveDeploymentConnection(installationId, body.repository, connection);
      return NextResponse.json({ target, verified: true });
    }

    const connection: DeploymentConnection = body.useSavedConnection
      ? await getDeploymentConnection(installationId, body.repository)
        ?? (() => { throw new Error("저장된 배포 서버가 없습니다. 서버 정보를 먼저 입력해 주세요."); })()
      : connectionSchema.parse(body);

    const rollback = body.rollbackOf
      ? await resolveRollback(installationId, body.repository, body.rollbackOf)
      : null;
    const imageTag = rollback?.imageTag ?? body.imageTag;
    await assertDockerHubArtifact(body.repository, imageTag);
    const credential = dockerHubPullCredential();
    const image = dockerHubTag(body.repository, imageTag);
    const record = await beginDeployment({
      installationId,
      repository: body.repository,
      target: "ONPREM",
      imageTag,
      image,
      destination: `${connection.host}:${connection.hostPort}`,
      rollbackOf: rollback?.id,
    });
    let logs: string[];
    let publicUrl: string | undefined;
    try {
      ({ logs, publicUrl } = await deployToOnPremise({
        ...connection,
        image,
        registry: credential.registry,
        registryUsername: credential.username,
        registryPassword: credential.password,
      }));
    } catch (error) {
      await failDeployment(record.id, error);
      throw error;
    }
    const target = body.useSavedConnection || !body.saveConnection
      ? {
          host: connection.host,
          sshPort: connection.sshPort,
          username: connection.username,
          hostPort: connection.hostPort,
          containerPort: connection.containerPort,
          authType: connection.privateKey ? "private-key" as const : "password" as const,
          updatedAt: new Date().toISOString(),
        }
      : await saveDeploymentConnection(installationId, body.repository, connection);

    const localUrl = `http://${connection.host.includes(":") ? `[${connection.host}]` : connection.host}:${connection.hostPort}`;
    await completeDeployment(record.id, { url: publicUrl || localUrl });

    return NextResponse.json({
      record: { id: record.id, number: record.number, imageTag },
      deployment: {
        image,
        url: publicUrl || localUrl,
        publicUrl,
        localUrl,
        logs,
        target,
      },
    });
  } catch (error) {
    return apiError(error, error instanceof DeploymentError ? error.status : 400);
  }
}


