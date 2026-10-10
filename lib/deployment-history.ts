import "server-only";

import { db } from "@/lib/db";
import { ensureProject, findProject } from "@/lib/projects";
import type { DeploymentRecord } from "@/lib/types";

export type DeployTarget = DeploymentRecord["target"];

// A status the route layer turns into an HTTP status (409 for a deployment already in progress).
export class DeploymentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const COMMIT_SHA = /^[a-f0-9]{40}$/i;

type BeginInput = {
  installationId: number;
  repository: string;
  target: DeployTarget;
  imageTag: string;
  image: string;
  destination?: string;
  rollbackOf?: string;
  /** On-premises: managed databases running alongside this deployment */
  databases?: string[];
};

// Records a deployment as RUNNING before any remote work starts.
// The project row is locked so two requests cannot both start a deployment to the same target.
export async function beginDeployment(input: BeginInput): Promise<{ id: string; number: number }> {
  // The project is created before the transaction so that the transaction only has to lock it.
  const project = await ensureProject(input.installationId, input.repository);
  return db().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${project.id} FOR UPDATE`;

    const active = await tx.deployment.findFirst({
      where: { projectId: project.id, target: input.target, status: "RUNNING" },
      select: { number: true },
    });
    if (active) throw new DeploymentError(`이미 진행 중인 배포(#${active.number})가 있습니다. 끝난 뒤 다시 시도해 주세요.`, 409);

    const last = await tx.deployment.findFirst({
      where: { projectId: project.id },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    return tx.deployment.create({
      data: {
        projectId: project.id,
        number: (last?.number ?? 0) + 1,
        target: input.target,
        trigger: input.rollbackOf ? "ROLLBACK" : "MANUAL",
        sourceDeploymentId: input.rollbackOf ?? null,
        imageTag: input.imageTag,
        image: input.image,
        destination: input.destination ?? null,
        databases: input.databases ?? [],
      },
      select: { id: true, number: true },
    });
  });
}

export async function completeDeployment(id: string, result: { url: string; destination?: string }): Promise<void> {
  await db().deployment.update({
    where: { id },
    data: {
      status: "SUCCESS",
      url: result.url,
      finishedAt: new Date(),
      ...(result.destination ? { destination: result.destination } : {}),
    },
  });
}

export async function failDeployment(id: string, error: unknown): Promise<void> {
  const failureReason = (error instanceof Error ? error.message : "알 수 없는 오류").slice(0, 2_000);
  await db().deployment.update({ where: { id }, data: { status: "FAILED", failureReason, finishedAt: new Date() } });
}

export async function listDeployments(installationId: number, repository: string, take = 20): Promise<DeploymentRecord[]> {
  const project = await findProject(installationId, repository);
  if (!project) return [];
  const rows = await db().deployment.findMany({ where: { projectId: project.id }, orderBy: { number: "desc" }, take });
  const current = new Set<string>();
  const seenTargets = new Set<string>();
  for (const row of rows) {
    if (row.status !== "SUCCESS" || seenTargets.has(row.target)) continue;
    seenTargets.add(row.target);
    current.add(row.id);
  }
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    target: row.target,
    trigger: row.trigger,
    imageTag: row.imageTag,
    image: row.image,
    destination: row.destination,
    status: row.status,
    failureReason: row.failureReason,
    url: row.url,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    current: current.has(row.id),
    canRollback: row.target === "ONPREM" && row.status === "SUCCESS" && !current.has(row.id) && COMMIT_SHA.test(row.imageTag),
  }));
}

// Returns the image tag to restore. Only a successful on-premises deployment of a fixed commit
// qualifies: "latest" moves with every push, so restoring it would not bring the old version back.
export async function resolveRollback(installationId: number, repository: string, deploymentId: string): Promise<{ id: string; imageTag: string; number: number }> {
  const project = await findProject(installationId, repository);
  const source = project ? await db().deployment.findFirst({ where: { id: deploymentId, projectId: project.id } }) : null;
  if (!source) throw new DeploymentError("되돌릴 배포를 찾을 수 없습니다.", 404);
  if (source.target !== "ONPREM") throw new DeploymentError("온프레미스 배포만 되돌릴 수 있습니다. 클라우드는 버전을 선택해 다시 배포하세요.", 400);
  if (source.status !== "SUCCESS") throw new DeploymentError("성공한 배포만 되돌릴 수 있습니다.", 400);
  if (!COMMIT_SHA.test(source.imageTag)) throw new DeploymentError("커밋이 고정되지 않은 배포(latest)는 되돌릴 수 없습니다.", 400);
  return { id: source.id, imageTag: source.imageTag, number: source.number };
}

// Called once when the server starts: a deployment still marked RUNNING cannot be progressing any more.
export async function failInterruptedDeployments(): Promise<number> {
  const { count } = await db().deployment.updateMany({
    where: { status: "RUNNING" },
    data: { status: "FAILED", failureReason: "서버가 재시작되어 배포가 중단되었습니다.", finishedAt: new Date() },
  });
  return count;
}
