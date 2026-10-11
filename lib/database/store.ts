import "server-only";

import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { ensureProject, findProject } from "@/lib/projects";
import { decrypt, encrypt } from "@/lib/secret-box";
import { DATABASE_KINDS, type DatabaseKind } from "./detect";
import { type DatabaseSpec, TEMPLATES } from "./stack";

type DatabaseRow = {
  id: string;
  kind: string;
  image: string;
  active: boolean;
  encryptedPassword: string;
  iv: string;
  authTag: string;
};

const byDisplayOrder = (a: { kind: string }, b: { kind: string }) =>
  DATABASE_KINDS.indexOf(a.kind as DatabaseKind) - DATABASE_KINDS.indexOf(b.kind as DatabaseKind);

type Secrets = { password: string; rootPassword?: string };

function readSecrets(row: DatabaseRow): Secrets {
  return decrypt<Secrets>({ iv: row.iv, tag: row.authTag, data: row.encryptedPassword });
}

const randomPassword = () => randomBytes(24).toString("base64url");

function newSecrets(kind: DatabaseKind) {
  // Redis runs without a password inside the app's private network.
  // MySQL also gets a root password of ours, or it would print a generated one to its log.
  const secrets: Secrets = {
    password: kind === "redis" ? "" : randomPassword(),
    ...(kind === "mysql" ? { rootPassword: randomPassword() } : {}),
  };
  const sealed = encrypt(secrets);
  return { encryptedPassword: sealed.data, iv: sealed.iv, authTag: sealed.tag };
}

/**
 * Records the databases found at repository analysis. A database seen for the first time gets a
 * random password; one no longer detected is only deactivated, because its data volume on the
 * server still expects the original password if it comes back.
 */
export async function syncDetectedDatabases(installationId: number, repository: string, kinds: DatabaseKind[]) {
  const project = await ensureProject(installationId, repository);
  const rows: DatabaseRow[] = await db().projectDatabase.findMany({ where: { projectId: project.id } });
  const detected = new Set<string>(kinds);
  // upsert, not find-then-create: two analyses of a new repository can run at the same time.
  // An existing row keeps its password and image; only the active flag is set.
  for (const kind of kinds) {
    await db().projectDatabase.upsert({
      where: { projectId_kind: { projectId: project.id, kind } },
      create: { projectId: project.id, kind, image: TEMPLATES[kind].image, active: true, ...newSecrets(kind) },
      update: { active: true },
    });
  }
  for (const row of rows) {
    if (row.active && !detected.has(row.kind)) {
      await db().projectDatabase.update({ where: { id: row.id }, data: { active: false } });
    }
  }
}

async function activeRows(projectId: string): Promise<DatabaseRow[]> {
  const rows: DatabaseRow[] = await db().projectDatabase.findMany({ where: { projectId, active: true } });
  return rows.filter((row) => DATABASE_KINDS.includes(row.kind as DatabaseKind)).sort(byDisplayOrder);
}

export async function listDatabases(installationId: number, repository: string): Promise<{ kind: DatabaseKind; image: string }[]> {
  const project = await findProject(installationId, repository);
  if (!project) return [];
  return (await activeRows(project.id)).map((row) => ({ kind: row.kind as DatabaseKind, image: row.image }));
}

export async function revealDatabasePassword(installationId: number, repository: string, kind: DatabaseKind): Promise<string> {
  const project = await findProject(installationId, repository);
  const row = project ? (await activeRows(project.id)).find((item) => item.kind === kind) : undefined;
  if (!row) throw new Error("이 저장소에서 사용하는 데이터베이스가 아닙니다.");
  return readSecrets(row).password;
}

export async function databasesForDeploy(projectId: string): Promise<DatabaseSpec[]> {
  return (await activeRows(projectId)).map((row) => {
    const { password, rootPassword } = readSecrets(row);
    return { kind: row.kind as DatabaseKind, image: row.image, password, ...(rootPassword ? { rootPassword } : {}) };
  });
}
