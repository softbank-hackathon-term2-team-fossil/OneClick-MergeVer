import { z } from "zod";
import type { AnalyzedFile } from "@/lib/types";
import { defaultSpec, infraSpecSchema, type Cloud, type InfraSpec } from "./spec";

type Generate = (request: { instructions: string; input: string; maxOutputTokens: number }) => Promise<string>;

export type SpecDraft = {
  spec: InfraSpec;
  // Why each value was chosen, and what the person should double-check.
  reasons: string[];
  questions: string[];
  warnings: string[];
  source: "ai" | "rules";
};

function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 응답에 JSON이 없습니다.");
  return JSON.parse(text.slice(start, end + 1));
}

const strings = z.array(z.string().max(400)).max(6).catch([]);

const draftSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  healthPath: z.string().optional(),
  database: z.enum(["none", "postgres", "mysql"]).optional(),
  minInstances: z.number().int().optional(),
  maxInstances: z.number().int().optional(),
  env: z.record(z.string(), z.string()).optional(),
  secretNames: z.array(z.string()).optional(),
  reasons: strings,
  questions: strings,
  warnings: strings,
});

// Keeps only the parts of an AI answer that pass the spec's own rules, one field at a time,
// so one bad value does not discard the rest.
function mergeDraft(base: InfraSpec, draft: Partial<InfraSpec>): InfraSpec {
  let spec = base;
  for (const [field, value] of Object.entries(draft)) {
    // The app's name and how it is run are chosen by a person, never by the model.
    if (value === undefined || field === "appName" || field === "compute") continue;
    const candidate = infraSpecSchema.safeParse({ ...spec, [field]: value });
    if (candidate.success) spec = candidate.data;
  }
  return spec;
}

// What can be read without a model. Used when the model is unavailable, and as the starting
// point the model's answer is merged onto.
export function ruleBasedDraft(repository: string, files: AnalyzedFile[], dockerfilePort: number | null): SpecDraft {
  const spec = defaultSpec(repository);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const all = files.map((file) => file.content).join("\n");
  if (dockerfilePort) {
    spec.port = dockerfilePort;
    reasons.push(`포트 ${dockerfilePort}: Dockerfile의 EXPOSE 값`);
  }
  if (/postgres|psycopg|\bpg\b|asyncpg/i.test(all)) {
    spec.database = "postgres";
    reasons.push("DB PostgreSQL: 의존성에서 PostgreSQL 드라이버를 찾음");
  } else if (/mysql|mariadb|pymysql/i.test(all)) {
    spec.database = "mysql";
    reasons.push("DB MySQL: 의존성에서 MySQL 드라이버를 찾음");
  }
  if (/sqlite/i.test(all)) {
    warnings.push("SQLite 파일 DB를 쓰는 것으로 보입니다. 컨테이너 안의 파일은 재배포하거나 개수가 줄어들 때 사라집니다. 데이터를 유지하려면 앱이 DATABASE_URL을 읽도록 바꾸고 DB를 선택하세요.");
  }
  return { spec, reasons, questions: [], warnings, source: "rules" };
}

export async function inferSpec(repository: string, files: AnalyzedFile[], dockerfilePort: number | null, generate: Generate): Promise<SpecDraft> {
  const base = ruleBasedDraft(repository, files, dockerfilePort);
  const text = await generate({
    instructions: [
      "You read a web application's build and configuration files and fill in a deployment spec. You do not write infrastructure code.",
      "Answer with one JSON object and nothing else, using these keys:",
      "port (number the app listens on), healthPath (a GET path that returns 2xx/3xx without login, '/' if unsure),",
      "database ('none' | 'postgres' | 'mysql': the external database the code connects to; a SQLite file or in-memory store is 'none'),",
      "minInstances (0, 1 or 2), maxInstances (1 to 5),",
      "env (object of non-secret environment variables the app needs with sensible values; never include DATABASE_URL or DB_* because the platform sets them),",
      "secretNames (array of names of secret environment variables the app reads, such as API keys; names only, never values),",
      "reasons (array, one short Korean sentence per decision citing the file it came from),",
      "questions (array of at most 3 short Korean questions for things the files cannot answer, e.g. whether data must survive restarts or how much traffic is expected),",
      "warnings (array of short Korean sentences about things that will break in a stateless container platform, e.g. a SQLite file or local uploads).",
      "Use only evidence from the supplied files. If the Dockerfile port is given, use it as port.",
    ].join(" "),
    input: JSON.stringify({
      dockerfilePort,
      files: files.map((file) => ({ path: file.path, content: file.content.slice(0, 6_000) })),
    }).slice(0, 60_000),
    maxOutputTokens: 1_500,
  });
  const draft = draftSchema.parse(parseJson(text));
  const { reasons, questions, warnings, ...fields } = draft;
  return {
    spec: mergeDraft(base.spec, fields),
    reasons: reasons.length ? reasons : base.reasons,
    questions,
    // The rule-based SQLite warning is only added when the model did not already raise it.
    warnings: [...warnings, ...base.warnings.filter(() => !warnings.some((warning) => /sqlite/i.test(warning)))].slice(0, 4),
    source: "ai",
  };
}

export type Diagnosis = {
  cause: string;
  // What a person must do when the spec cannot fix it (credentials, quota, region, app code).
  action: string;
  // A change to the spec that would fix it, already validated. Null when the spec is not the problem.
  patch: Partial<InfraSpec> | null;
};

const diagnosisSchema = z.object({
  cause: z.string().max(600),
  action: z.string().max(600).catch(""),
  patch: z.record(z.string(), z.unknown()).nullable().catch(null),
});

// The verifier's feedback loop: a failed validate / plan / apply is explained, and when the
// spec is at fault the correction is expressed as a spec change, never as Terraform code.
export async function diagnose(
  input: { cloud: Cloud; stage: "plan" | "policy" | "apply" | "health"; spec: InfraSpec; error: string },
  generate: Generate,
): Promise<Diagnosis> {
  const text = await generate({
    instructions: [
      "A deployment built from a fixed Terraform template failed. You cannot edit the template; you can only change the spec.",
      "Answer with one JSON object: cause (one or two Korean sentences in plain words), action (Korean: what a person must do if the spec cannot fix it, else empty string),",
      "patch (object with only the spec fields to change, or null).",
      "Spec fields: port (1-65535), healthPath (starts with /), minInstances (0-2), maxInstances (1-5), database ('none'|'postgres'|'mysql'), env (object), secretNames (array).",
      "Propose a patch only when the error clearly points at one of these values (wrong port, wrong health path, a reserved or invalid environment variable name, instance counts).",
      "Credential, permission, quota, billing, region or application-code problems are not fixable by the spec: set patch to null and explain the action.",
      "Never suggest removing the database to make an error go away.",
    ].join(" "),
    input: JSON.stringify({ cloud: input.cloud, stage: input.stage, spec: input.spec, error: input.error.slice(-5_000) }),
    maxOutputTokens: 800,
  });
  const parsed = diagnosisSchema.parse(parseJson(text));
  let patch: Partial<InfraSpec> | null = null;
  if (parsed.patch) {
    const { appName: _ignored, ...fields } = parsed.patch as Partial<InfraSpec>;
    const dropsDatabase = input.spec.database !== "none" && fields.database === "none";
    const merged = dropsDatabase ? input.spec : mergeDraft(input.spec, fields);
    const changed = Object.fromEntries(Object.entries(merged).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(input.spec[field as keyof InfraSpec])));
    patch = Object.keys(changed).length ? (changed as Partial<InfraSpec>) : null;
  }
  return { cause: parsed.cause, action: parsed.action, patch };
}
