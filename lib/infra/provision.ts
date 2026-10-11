import "server-only";

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { beginDeployment, completeDeployment, failDeployment, type DeployTarget } from "@/lib/deployment-history";
import { generateText } from "@/lib/llm";
import { diagnose, type Diagnosis } from "./ai";
import { ADAPTERS } from "./clouds";
import { checkPolicy, summarizePlan, type PlanSummary } from "./plan-summary";
import { capabilityNotes, infraSpecSchema, type CapabilityNote, type Cloud, type InfraSpec } from "./spec";
import { errorText, loadSecretEnv, prepareWorkspace, readJson, removeFile, saveSecretEnv, terraform, workspaceDir, writeJson } from "./terraform";

const HISTORY_TARGET: Record<Cloud, DeployTarget> = { gcp: "CLOUD_RUN", azure: "AZURE", aws: "AWS" };
const MAX_REPAIR_ROUNDS = 2;
const PLAN_TTL_MS = 30 * 60_000;

export class InfraError extends Error {
  constructor(message: string, readonly status = 400, readonly detail?: unknown) {
    super(message);
  }
}

// One pass of the verifier that did not go through, and what the AI changed in response.
export type RepairRound = { stage: "validate" | "plan" | "policy"; error: string; cause: string; patch: Partial<InfraSpec> | null };

export type SavedPlan = {
  id: string;
  cloud: Cloud;
  destroy: boolean;
  spec: InfraSpec;
  image: string;
  imageTag: string;
  region: string;
  summary: PlanSummary;
  notes: CapabilityNote[];
  rounds: RepairRound[];
  createdAt: string;
};

export type Job = {
  id: string;
  kind: "apply" | "destroy";
  status: "RUNNING" | "SUCCESS" | "FAILED";
  phase: "terraform" | "health" | "done";
  startedAt: string;
  finishedAt: string | null;
  pid: number | null;
  url: string | null;
  error: string | null;
  diagnosis: Diagnosis | null;
};

export type Deployed = { spec: InfraSpec; image: string; imageTag: string; url: string; service: string; database: string; region: string; deployedAt: string };

type Scope = { installationId: number; repository: string; cloud: Cloud };

// Jobs this server process is still driving. Kept on globalThis so a dev-mode reload does not forget them.
const active: Set<string> = ((globalThis as { __sbsbInfraJobs?: Set<string> }).__sbsbInfraJobs ??= new Set());

const files = (dir: string) => ({
  plan: path.join(dir, "plan.json"),
  planBinary: path.join(dir, "tfplan"),
  job: path.join(dir, "job.json"),
  log: path.join(dir, "job.log"),
  deployed: path.join(dir, "deployed.json"),
});

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function currentJob(dir: string): Promise<Job | null> {
  const job = await readJson<Job>(files(dir).job);
  if (!job || job.status !== "RUNNING" || active.has(dir) || alive(job.pid)) return job;
  // The server restarted while Terraform was running. What exists in the cloud is still recorded
  // in the state file, so the next plan picks up from wherever it stopped.
  const failed: Job = { ...job, status: "FAILED", phase: "done", finishedAt: new Date().toISOString(), error: "서버가 재시작되어 작업 결과를 확인하지 못했습니다. 계획을 다시 만들면 클라우드의 현재 상태와 맞춰집니다." };
  await writeJson(files(dir).job, failed);
  return failed;
}

function requireConfigured(cloud: Cloud): void {
  const missing = ADAPTERS[cloud].missing();
  if (missing.length) throw new InfraError(`.env.local에 다음 값이 필요합니다: ${missing.join(", ")}`);
}

async function tryDiagnose(input: Parameters<typeof diagnose>[0]): Promise<Diagnosis | null> {
  try {
    return await diagnose(input, generateText);
  } catch {
    // The diagnosis is a convenience. The raw error is still shown when the model is unavailable.
    return null;
  }
}

// validate → plan → policy. When one of them fails and the AI can express the fix as a spec
// change, the corrected spec goes through the same three checks again.
export async function createPlan(scope: Scope, input: { spec: InfraSpec; image: string; imageTag: string; secretEnv: Record<string, string>; destroy?: boolean }): Promise<SavedPlan> {
  requireConfigured(scope.cloud);
  const dir = workspaceDir(scope.installationId, scope.repository, scope.cloud);
  const paths = files(dir);
  if ((await currentJob(dir))?.status === "RUNNING") throw new InfraError("이 클라우드에서 진행 중인 작업이 있습니다. 끝난 뒤 다시 시도하세요.", 409);

  let spec = infraSpecSchema.parse(input.spec);
  const rounds: RepairRound[] = [];
  const destroy = Boolean(input.destroy);

  for (let attempt = 0; ; attempt += 1) {
    await prepareWorkspace(dir, scope.cloud, spec, input.image);
    const stored = await loadSecretEnv(dir);
    const secretEnv = Object.fromEntries(spec.secretNames.map((name) => [name, input.secretEnv[name] || stored[name] || ""]));
    const empty = Object.keys(secretEnv).filter((name) => !secretEnv[name]);
    if (empty.length && !destroy) throw new InfraError(`비밀 환경변수의 값을 입력하세요: ${empty.join(", ")}`);
    await saveSecretEnv(dir, secretEnv);

    let failure: { stage: RepairRound["stage"]; error: string } | null = null;
    let summary: PlanSummary | null = null;

    const init = await terraform(scope.cloud, dir, ["init", "-input=false", "-no-color"], { timeoutMs: 600_000 });
    if (init.code !== 0) throw new InfraError(`Terraform 초기화에 실패했습니다.\n${errorText(init)}`, 500);

    const validate = await terraform(scope.cloud, dir, ["validate", "-no-color"], { secretEnv });
    if (validate.code !== 0) failure = { stage: "validate", error: errorText(validate) };

    if (!failure) {
      await removeFile(paths.planBinary);
      const plan = await terraform(scope.cloud, dir, ["plan", "-input=false", "-no-color", "-lock-timeout=20s", "-out=tfplan", ...(destroy ? ["-destroy"] : [])], { secretEnv, timeoutMs: 600_000 });
      if (plan.code !== 0) failure = { stage: "plan", error: errorText(plan) };
    }

    if (!failure) {
      const show = await terraform(scope.cloud, dir, ["show", "-json", "tfplan"], { secretEnv });
      if (show.code !== 0) throw new InfraError(`계획을 읽지 못했습니다.\n${errorText(show)}`, 500);
      const json = JSON.parse(show.stdout);
      summary = summarizePlan(scope.cloud, json);
      const violations = checkPolicy(scope.cloud, json, { destroy });
      if (violations.length) failure = { stage: "policy", error: violations.join("\n") };
    }

    if (!failure && summary) {
      const saved: SavedPlan = {
        id: randomUUID(), cloud: scope.cloud, destroy, spec, image: input.image, imageTag: input.imageTag,
        region: ADAPTERS[scope.cloud].region(), summary, notes: capabilityNotes(scope.cloud, spec), rounds, createdAt: new Date().toISOString(),
      };
      await writeJson(paths.plan, saved);
      return saved;
    }

    await removeFile(paths.planBinary);
    await removeFile(paths.plan);
    const diagnosis = destroy ? null : await tryDiagnose({ cloud: scope.cloud, stage: failure!.stage === "policy" ? "policy" : "plan", spec, error: failure!.error });
    rounds.push({ stage: failure!.stage, error: failure!.error.slice(0, 1_500), cause: diagnosis?.cause ?? "", patch: diagnosis?.patch ?? null });
    if (!diagnosis?.patch || attempt >= MAX_REPAIR_ROUNDS) {
      throw new InfraError(failure!.stage === "policy" ? "정책 검사에서 거부된 계획입니다." : "Terraform 검증을 통과하지 못했습니다.", 422, { rounds, action: diagnosis?.action ?? "" });
    }
    spec = infraSpecSchema.parse({ ...spec, ...diagnosis.patch });
  }
}

async function waitUntilServing(url: string, healthPath: string): Promise<void> {
  const target = new URL(healthPath, url).toString();
  let last = "응답 없음";
  for (let attempt = 0; attempt < 36; attempt += 1) {
    try {
      const response = await fetch(target, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (response.status < 400) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : "응답 없음";
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`자원은 만들어졌지만 ${target} 가 응답하지 않습니다 (${last}).`);
}

// Applies exactly the plan that was shown and approved: the saved plan file, not a fresh one.
export async function startApply(scope: Scope, planId: string): Promise<Job> {
  requireConfigured(scope.cloud);
  const dir = workspaceDir(scope.installationId, scope.repository, scope.cloud);
  const paths = files(dir);
  if ((await currentJob(dir))?.status === "RUNNING") throw new InfraError("이 클라우드에서 진행 중인 작업이 있습니다.", 409);
  const plan = await readJson<SavedPlan>(paths.plan);
  if (!plan || plan.id !== planId) throw new InfraError("승인한 계획을 찾을 수 없습니다. 계획을 다시 만드세요.", 409);
  if (Date.now() - Date.parse(plan.createdAt) > PLAN_TTL_MS) throw new InfraError("계획을 만든 지 30분이 지났습니다. 다시 만들어 확인하세요.", 409);

  const recordId = plan.destroy ? null : (await beginDeployment({
    installationId: scope.installationId, repository: scope.repository, target: HISTORY_TARGET[scope.cloud],
    imageTag: plan.imageTag, image: plan.image, destination: `Terraform · sbsb-${plan.spec.appName}`,
  })).id;

  let job: Job = { id: randomUUID(), kind: plan.destroy ? "destroy" : "apply", status: "RUNNING", phase: "terraform", startedAt: new Date().toISOString(), finishedAt: null, pid: null, url: null, error: null, diagnosis: null };
  const save = (patch: Partial<Job>) => writeJson(paths.job, (job = { ...job, ...patch }));
  await removeFile(paths.log);
  await save({});
  active.add(dir);

  void (async () => {
    try {
      const secretEnv = await loadSecretEnv(dir);
      // Once a delete starts the service is going away, even if the delete stops half-way;
      // what is left is tracked by the state file, not by the "currently deployed" record.
      if (plan.destroy) await removeFile(paths.deployed);
      const applied = await terraform(scope.cloud, dir, ["apply", "-input=false", "-no-color", "-lock-timeout=20s", "tfplan"], {
        secretEnv, logFile: paths.log, timeoutMs: 45 * 60_000, onStart: (pid) => void save({ pid }),
      });
      await removeFile(paths.planBinary);
      await removeFile(paths.plan);
      if (applied.code !== 0) throw Object.assign(new Error(errorText(applied)), { stage: "apply" as const });

      if (plan.destroy) {
        await save({ status: "SUCCESS", phase: "done", finishedAt: new Date().toISOString() });
        return;
      }
      const output = await terraform(scope.cloud, dir, ["output", "-json"], { secretEnv });
      const values = output.code === 0 ? JSON.parse(output.stdout) as Record<string, { value: string }> : {};
      const url = values.url?.value;
      if (!url) throw Object.assign(new Error("Terraform이 접속 주소를 돌려주지 않았습니다."), { stage: "apply" as const });
      await save({ phase: "health", url });
      try {
        await waitUntilServing(url, plan.spec.healthPath);
      } catch (error) {
        throw Object.assign(error as Error, { stage: "health" as const });
      }
      const deployed: Deployed = { spec: plan.spec, image: plan.image, imageTag: plan.imageTag, url, service: values.service?.value ?? "", database: values.database?.value ?? "", region: plan.region, deployedAt: new Date().toISOString() };
      await writeJson(paths.deployed, deployed);
      if (recordId) await completeDeployment(recordId, { url, destination: `Terraform · ${deployed.service}${deployed.database ? ` + ${deployed.database}` : ""}` });
      await save({ status: "SUCCESS", phase: "done", finishedAt: new Date().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 오류";
      const stage = (error as { stage?: "apply" | "health" }).stage ?? "apply";
      if (recordId) await failDeployment(recordId, error).catch(() => undefined);
      await save({ status: "FAILED", phase: "done", finishedAt: new Date().toISOString(), error: message });
      const diagnosis = plan.destroy ? null : await tryDiagnose({ cloud: scope.cloud, stage, spec: plan.spec, error: message });
      if (diagnosis) await save({ diagnosis });
    } finally {
      active.delete(dir);
    }
  })();

  return job;
}

async function logTail(file: string): Promise<string> {
  try {
    const size = (await stat(file)).size;
    const text = await readFile(file, "utf8");
    return size > 6_000 ? text.slice(-6_000) : text;
  } catch {
    return "";
  }
}

// True when Terraform has created anything here, including a deployment that failed half-way.
// Those resources keep costing money, so they must stay deletable even without a successful deployment.
async function hasResources(dir: string): Promise<boolean> {
  const state = await readJson<{ resources?: { mode?: string }[] }>(path.join(dir, "terraform.tfstate"));
  return Boolean(state?.resources?.some((resource) => resource.mode !== "data"));
}

// The values of the last plan, read back from the workspace. Used to delete what a failed
// deployment left behind, when there is no successful deployment to take them from.
export async function lastPlannedInput(scope: Scope): Promise<{ spec: InfraSpec; image: string } | null> {
  const dir = workspaceDir(scope.installationId, scope.repository, scope.cloud);
  const values = await readJson<Record<string, unknown>>(path.join(dir, "sbsb.auto.tfvars.json"));
  if (!values) return null;
  const spec = infraSpecSchema.safeParse({
    appName: values.app_name, port: values.port, healthPath: values.health_path, minInstances: values.min_instances,
    maxInstances: values.max_instances, database: values.db_engine, compute: values.compute, env: values.env, secretNames: Object.keys(await loadSecretEnv(dir).catch(() => ({}))),
  });
  return spec.success && typeof values.image === "string" ? { spec: spec.data, image: values.image } : null;
}

export async function getStatus(scope: Scope) {
  const dir = workspaceDir(scope.installationId, scope.repository, scope.cloud);
  const paths = files(dir);
  const [job, plan, deployed, savedSecrets, resources] = await Promise.all([
    currentJob(dir),
    readJson<SavedPlan>(paths.plan),
    readJson<Deployed>(paths.deployed),
    loadSecretEnv(dir).catch(() => ({} as Record<string, string>)),
    hasResources(dir),
  ]);
  return {
    cloud: scope.cloud,
    region: ADAPTERS[scope.cloud].region(),
    missing: ADAPTERS[scope.cloud].missing(),
    job,
    log: job ? await logTail(paths.log) : "",
    plan: plan && Date.now() - Date.parse(plan.createdAt) <= PLAN_TTL_MS ? plan : null,
    deployed,
    hasResources: resources,
    // Names only, so the form can show which secrets are already stored.
    storedSecretNames: Object.keys(savedSecrets).filter((name) => savedSecrets[name]),
  };
}

export type InfraStatus = Awaited<ReturnType<typeof getStatus>>;
