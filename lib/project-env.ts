import "server-only";

import { z } from "zod";
import { db } from "@/lib/db";
import { ensureProject, findProject } from "@/lib/projects";
import { decrypt, encrypt } from "@/lib/secret-box";

// Variables the user sets for the on-premises app container: API keys, or their own DATABASE_URL
// (which switches the matching managed database off). Values are encrypted and never sent back.
const MAX_VALUE_LENGTH = 4_096;

export const envVarSchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "이름은 영문·숫자·밑줄만 쓸 수 있고 숫자로 시작할 수 없습니다."),
  value: z
    .string()
    .max(MAX_VALUE_LENGTH, `값은 ${MAX_VALUE_LENGTH.toLocaleString("en-US")}자까지입니다.`)
    // The env file passed to the container holds one variable per line.
    .refine((value) => !/[\r\n]/.test(value), "값에 줄바꿈은 넣을 수 없습니다."),
});

type EnvVarRow = { key: string; encryptedValue: string; iv: string; authTag: string; updatedAt: Date };

export async function listEnvVarKeys(installationId: number, repository: string): Promise<{ key: string; updatedAt: string }[]> {
  const project = await findProject(installationId, repository);
  if (!project) return [];
  const rows: EnvVarRow[] = await db().projectEnvVar.findMany({ where: { projectId: project.id } });
  return rows
    .map((row) => ({ key: row.key, updatedAt: row.updatedAt.toISOString() }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Adds or overwrites a variable. It applies from the next deployment. */
export async function setEnvVar(installationId: number, repository: string, input: unknown): Promise<void> {
  const parsed = envVarSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "환경변수 입력값이 올바르지 않습니다.");
  const { key, value } = parsed.data;
  const project = await ensureProject(installationId, repository);
  const sealed = encrypt({ value });
  const data = { encryptedValue: sealed.data, iv: sealed.iv, authTag: sealed.tag };
  await db().projectEnvVar.upsert({
    where: { projectId_key: { projectId: project.id, key } },
    create: { projectId: project.id, key, ...data },
    update: data,
  });
}

export async function deleteEnvVar(installationId: number, repository: string, key: string): Promise<void> {
  const project = await findProject(installationId, repository);
  if (project) await db().projectEnvVar.deleteMany({ where: { projectId: project.id, key } });
}

/** Name → plain value, for the deployment only. */
export async function readEnvVars(projectId: string): Promise<Record<string, string>> {
  const rows: EnvVarRow[] = await db().projectEnvVar.findMany({ where: { projectId } });
  return Object.fromEntries(
    rows.map((row) => [row.key, decrypt<{ value: string }>({ iv: row.iv, tag: row.authTag, data: row.encryptedValue }).value]),
  );
}
