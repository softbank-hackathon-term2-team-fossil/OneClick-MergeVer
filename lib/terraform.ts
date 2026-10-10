import "server-only";

import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "@/lib/process";

export type TerraformProvider = "gcp" | "oci";
export type TerraformAction = "plan" | "apply" | "destroy";
export type TerraformResult = { log: string; outputs: Record<string, unknown> };

const SOURCE_ROOT = join(process.cwd(), "infra", "terraform");
// State lives next to the site server so a later destroy knows what apply created.
const STATE_ROOT = join(process.cwd(), ".sbsb-terraform");
const LOG_LIMIT = 6_000;

let running = false;

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function required(names: string[]): Record<string, string> {
  const missing = names.filter((name) => !env(name));
  if (missing.length) throw new Error(`서버 환경변수가 설정되지 않았습니다: ${missing.join(", ")}`);
  return Object.fromEntries(names.map((name) => [name, env(name) as string]));
}

async function variablesFor(provider: TerraformProvider, image: string, port: number): Promise<Record<string, string | number>> {
  const shared = { container_image: image, container_port: port };
  if (provider === "gcp") {
    const values = required(["GCP_PROJECT_ID"]);
    const region = env("GCP_LOCATION") ?? "us-central1";
    return {
      ...shared,
      project_id: values.GCP_PROJECT_ID,
      credentials_file: env("GOOGLE_APPLICATION_CREDENTIALS") ?? "",
      region,
      zone: `${region}-a`,
    };
  }
  const values = required(["OCI_TENANCY_OCID", "OCI_USER_OCID", "OCI_FINGERPRINT", "OCI_PRIVATE_KEY_PATH", "OCI_REGION", "OCI_SSH_PUBLIC_KEY_FILE"]);
  const sshPublicKey = (await readFile(values.OCI_SSH_PUBLIC_KEY_FILE, "utf8")).trim();
  return {
    ...shared,
    tenancy_ocid: values.OCI_TENANCY_OCID,
    user_ocid: values.OCI_USER_OCID,
    fingerprint: values.OCI_FINGERPRINT,
    private_key_path: values.OCI_PRIVATE_KEY_PATH,
    region: values.OCI_REGION,
    compartment_ocid: env("OCI_COMPARTMENT_OCID") ?? "",
    ssh_public_key: sshPublicKey,
  };
}

async function prepareWorkspace(provider: TerraformProvider, variables: Record<string, string | number>): Promise<string> {
  const source = join(SOURCE_ROOT, provider);
  const workspace = join(STATE_ROOT, provider);
  await mkdir(workspace, { recursive: true });
  for (const name of await readdir(source)) {
    if (name.endsWith(".tf")) await copyFile(join(source, name), join(workspace, name));
  }
  await writeFile(join(workspace, "terraform.tfvars.json"), JSON.stringify(variables), { mode: 0o600 });
  return workspace;
}

export async function runTerraform(
  provider: TerraformProvider,
  action: TerraformAction,
  input: { image: string; port: number },
): Promise<TerraformResult> {
  if (running) throw new Error("다른 Terraform 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.");
  running = true;
  try {
    const bin = env("TERRAFORM_BIN") ?? "terraform";
    const workspace = await prepareWorkspace(provider, await variablesFor(provider, input.image, input.port));
    const common = ["-input=false", "-no-color"];
    await run(bin, ["init", ...common], { cwd: workspace, timeoutMs: 300_000 });
    const args = action === "plan" ? ["plan", ...common] : [action, "-auto-approve", ...common];
    const log = await run(bin, args, { cwd: workspace, timeoutMs: 1_800_000 });
    let outputs: Record<string, unknown> = {};
    if (action === "apply") {
      const raw = await run(bin, ["output", "-json", "-no-color"], { cwd: workspace, timeoutMs: 60_000 });
      const parsed = JSON.parse(raw || "{}") as Record<string, { value: unknown; sensitive?: boolean }>;
      // The database password is written to state only; it is never sent to the browser.
      outputs = Object.fromEntries(Object.entries(parsed).filter(([, item]) => !item.sensitive).map(([key, item]) => [key, item.value]));
    }
    return { log: log.slice(-LOG_LIMIT), outputs };
  } finally {
    running = false;
  }
}
