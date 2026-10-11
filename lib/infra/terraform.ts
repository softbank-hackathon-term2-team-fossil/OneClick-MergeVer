import "server-only";

import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dockerHubPullCredential } from "@/lib/dockerhub";
import { ADAPTERS } from "./clouds";
import { templateFor, type Cloud, type InfraSpec } from "./spec";

const DATA_ROOT = path.join(process.cwd(), ".sbsb-data", "terraform");
const TEMPLATE_ROOT = path.join(process.cwd(), "infra", "templates");

// One folder per repository and cloud. It holds the copied template, the values, the Terraform
// state (what exists in the cloud) and the saved plan, so it must survive between deployments.
export function workspaceDir(installationId: number, repository: string, cloud: Cloud): string {
  const safe = repository.toLowerCase().replace(/[^a-z0-9._-]+/g, "__");
  return path.join(DATA_ROOT, "apps", String(installationId), safe, cloud);
}

function binary(): string {
  return process.env.TERRAFORM_BIN?.trim() || "terraform";
}

export type TerraformResult = { code: number; stdout: string; stderr: string };

export async function terraform(
  cloud: Cloud,
  cwd: string,
  args: string[],
  options: { secretEnv?: Record<string, string>; logFile?: string; timeoutMs?: number; onStart?: (pid: number) => void } = {},
): Promise<TerraformResult> {
  await mkdir(path.join(DATA_ROOT, "plugin-cache"), { recursive: true });
  const hub = dockerHubPullCredential();
  const log = options.logFile ? createWriteStream(options.logFile, { flags: "a", mode: 0o600 }) : null;
  return new Promise((resolve, reject) => {
    const child = spawn(binary(), args, {
      cwd,
      // Secrets reach Terraform through the environment, never through a file or the command line.
      env: {
        ...process.env,
        ...ADAPTERS[cloud].processEnv(),
        TF_IN_AUTOMATION: "1",
        TF_INPUT: "0",
        TF_PLUGIN_CACHE_DIR: path.join(DATA_ROOT, "plugin-cache"),
        TF_VAR_dockerhub_username: hub.username,
        TF_VAR_dockerhub_token: hub.password,
        TF_VAR_secret_env: JSON.stringify(options.secretEnv ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 300_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); log?.write(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); log?.write(chunk); });
    child.on("spawn", () => { if (child.pid) options.onStart?.(child.pid); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      log?.end();
      reject(error.code === "ENOENT" ? new Error("Terraform 실행 파일을 찾을 수 없습니다. .env.local의 TERRAFORM_BIN을 확인하세요.") : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      log?.end();
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function terraformVersion(): Promise<string | null> {
  try {
    const result = await terraform("gcp", process.cwd(), ["version", "-json"], { timeoutMs: 15_000 });
    return result.code === 0 ? (JSON.parse(result.stdout) as { terraform_version: string }).terraform_version : null;
  } catch {
    return null;
  }
}

// Copies the fixed template into the workspace and writes the values derived from the spec.
// The template is copied on every plan so that a template fix reaches existing deployments.
export async function prepareWorkspace(dir: string, cloud: Cloud, spec: InfraSpec, image: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await copyFile(path.join(TEMPLATE_ROOT, templateFor(cloud, spec), "main.tf"), path.join(dir, "main.tf"));
  await copyFile(path.join(TEMPLATE_ROOT, "variables.common.tf"), path.join(dir, "variables.common.tf"));
  const variables = {
    app_name: spec.appName,
    image,
    port: spec.port,
    health_path: spec.healthPath,
    min_instances: spec.minInstances,
    max_instances: spec.maxInstances,
    db_engine: spec.database,
    compute: spec.compute,
    env: spec.env,
    region: ADAPTERS[cloud].region(),
    ...ADAPTERS[cloud].variables(),
  };
  await writeFile(path.join(dir, "sbsb.auto.tfvars.json"), `${JSON.stringify(variables, null, 2)}\n`, { mode: 0o600 });
}

// Terraform prints errors as boxed text; keep the part a person (or the AI) can act on.
export function errorText(result: TerraformResult): string {
  // eslint-disable-next-line no-control-regex
  const text = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const first = text.indexOf("Error:");
  return (first >= 0 ? text.slice(first) : text).replace(/[│╷╵]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6_000);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true });
}

// Secret environment values typed by the user are kept encrypted between deployments so a
// redeploy does not ask for them again.
function key(): Buffer {
  const secret = process.env.SBSB_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) throw new Error("SBSB_CREDENTIAL_ENCRYPTION_KEY must contain at least 32 characters.");
  return createHash("sha256").update(secret).digest();
}

export async function saveSecretEnv(dir: string, values: Record<string, string>): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
  await writeJson(path.join(dir, "secrets.enc.json"), { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}

export async function loadSecretEnv(dir: string): Promise<Record<string, string>> {
  const stored = await readJson<{ iv: string; tag: string; data: string }>(path.join(dir, "secrets.enc.json"));
  if (!stored) return {};
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(stored.iv, "base64"));
  decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.data, "base64")), decipher.final()]).toString("utf8")) as Record<string, string>;
}
