import "server-only";

import { db } from "@/lib/db";

// A project is one repository as seen by one GitHub App installation.
// Repository names are stored lower-cased because GitHub treats them case-insensitively.
export function projectKey(installationId: number, repository: string) {
  return { installationId: BigInt(installationId), repository: repository.toLowerCase() };
}

export function findProject(installationId: number, repository: string) {
  return db().project.findUnique({ where: { installationId_repository: projectKey(installationId, repository) } });
}

// Two requests for a repository seen for the first time can both try to insert the project row.
// The loser gets a unique-constraint error (P2002); the row exists by then, so it is simply read.
export async function ensureProject(installationId: number, repository: string) {
  const key = projectKey(installationId, repository);
  try {
    return await db().project.upsert({ where: { installationId_repository: key }, create: key, update: {} });
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    return db().project.findUniqueOrThrow({ where: { installationId_repository: key } });
  }
}
