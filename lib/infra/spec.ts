import { z } from "zod";

// The one document the AI is allowed to write. Everything Terraform does is derived from it
// through fixed templates (infra/templates/<cloud>), so a wrong answer can only produce a
// value that the validators below or `terraform plan` reject.
export const CLOUDS = ["gcp", "azure", "aws"] as const;
export type Cloud = (typeof CLOUDS)[number];

export const CLOUD_LABEL: Record<Cloud, string> = { gcp: "GCP", azure: "Azure", aws: "AWS" };

// What the same spec becomes in each cloud.
export const CLOUD_SERVICES: Record<Cloud, { web: string; database: string; secrets: string }> = {
  gcp: { web: "Cloud Run", database: "Cloud SQL", secrets: "Secret Manager" },
  azure: { web: "Container Apps", database: "Database Flexible Server", secrets: "Container Apps 비밀 저장" },
  aws: { web: "ECS Fargate + ALB", database: "RDS", secrets: "Secrets Manager" },
};

// How the container runs. "serverless" lets the cloud run and scale containers; "vm" is one
// server that runs the container itself, the same shape as an on-premises machine.
export const COMPUTES = ["serverless", "vm"] as const;
export type Compute = (typeof COMPUTES)[number];

// Clouds that have a VM template. Elsewhere a "vm" spec is deployed serverless and says so.
const VM_TEMPLATE: Partial<Record<Cloud, { folder: string; web: string }>> = {
  aws: { folder: "aws-vm", web: "EC2 + 고정 IP" },
};

export function usesVm(cloud: Cloud, spec: Pick<InfraSpec, "compute">): boolean {
  return spec.compute === "vm" && cloud in VM_TEMPLATE;
}

// The template folder under infra/templates that a spec is built from.
export function templateFor(cloud: Cloud, spec: Pick<InfraSpec, "compute">): string {
  return usesVm(cloud, spec) ? VM_TEMPLATE[cloud]!.folder : cloud;
}

export function servicesFor(cloud: Cloud, spec: Pick<InfraSpec, "compute">): { web: string; database: string; secrets: string } {
  return usesVm(cloud, spec) ? { ...CLOUD_SERVICES[cloud], web: VM_TEMPLATE[cloud]!.web } : CLOUD_SERVICES[cloud];
}

export function supportsVm(cloud: Cloud): boolean {
  return cloud in VM_TEMPLATE;
}

const RESERVED_ENV = new Set(["DATABASE_URL", "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"]);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "환경변수 이름은 영문·숫자·밑줄만 쓸 수 있습니다.")
  .refine((name) => !RESERVED_ENV.has(name), "DATABASE_URL과 DB_*는 플랫폼이 채우므로 직접 지정할 수 없습니다.");

export const infraSpecSchema = z.object({
  appName: z.string().regex(/^[a-z][a-z0-9-]{1,19}[a-z0-9]$/, "앱 이름은 소문자로 시작하는 3~21자(소문자·숫자·하이픈)여야 합니다."),
  port: z.number().int().min(1).max(65535),
  healthPath: z.string().regex(/^\/[A-Za-z0-9._~/-]{0,199}$/, "헬스 체크 경로는 /로 시작해야 합니다."),
  minInstances: z.number().int().min(0).max(2),
  maxInstances: z.number().int().min(1).max(5),
  database: z.enum(["none", "postgres", "mysql"]),
  // Specs saved before this field existed are serverless.
  compute: z.enum(["serverless", "vm"]).default("serverless"),
  env: z.record(envName, z.string().max(2_000)),
  // Names only. The values are typed by a person and never shown to the AI.
  secretNames: z.array(envName).max(20),
}).refine((spec) => spec.minInstances <= spec.maxInstances, "최소 개수가 최대 개수보다 클 수 없습니다.");

export type InfraSpec = z.infer<typeof infraSpecSchema>;

export function appNameFor(repository: string): string {
  let name = (repository.split("/").pop() ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(name)) name = `app-${name}`;
  name = name.slice(0, 21).replace(/-+$/, "");
  return name.length >= 3 ? name : "app";
}

export function defaultSpec(repository: string): InfraSpec {
  return { appName: appNameFor(repository), port: 8080, healthPath: "/", minInstances: 0, maxInstances: 2, database: "none", compute: "serverless", env: {}, secretNames: [] };
}

// Where a cloud cannot honour the spec as written, the difference is stated instead of hidden.
export type CapabilityNote = { level: "applied" | "adjusted"; text: string };

export function capabilityNotes(cloud: Cloud, spec: InfraSpec): CapabilityNote[] {
  const services = servicesFor(cloud, spec);
  const vm = usesVm(cloud, spec);
  const notes: CapabilityNote[] = [];
  if (spec.compute === "vm" && !vm) {
    notes.push({ level: "adjusted", text: `VM → ${services.web}: 이 클라우드에는 VM 템플릿이 없어 서버리스로 배포합니다.` });
  }
  if (vm) {
    notes.push({ level: "applied", text: `웹 서비스: ${services.web} · 서버 한 대에서 컨테이너를 실행` });
    notes.push({ level: "adjusted", text: `자동 확장(${spec.minInstances}~${spec.maxInstances}개) → 1대 고정: 서버 한 대라 요청이 몰려도 늘어나지 않습니다.` });
    notes.push({ level: "adjusted", text: "무중단 교체 → 수 초 끊김: 새 서버가 응답한 뒤 고정 IP를 옮기는 동안 잠깐 끊깁니다." });
  } else {
    notes.push({ level: "applied", text: `웹 서비스: ${services.web} · 최대 ${spec.maxInstances}개까지 자동 확장` });
    if (cloud === "aws" && spec.minInstances === 0) {
      notes.push({ level: "adjusted", text: "최소 0개 → 1개: Fargate는 요청이 없어도 0개로 줄일 수 없습니다." });
    } else {
      notes.push({ level: "applied", text: spec.minInstances === 0 ? "요청이 없으면 0개로 줄어듭니다." : `항상 ${spec.minInstances}개를 켜 둡니다.` });
    }
  }
  if (spec.database !== "none") {
    const engine = spec.database === "postgres" ? "PostgreSQL 16" : "MySQL 8.0";
    notes.push({ level: "applied", text: `DB: ${services.database} (${engine}) · 접속 정보는 DATABASE_URL과 DB_* 환경변수로 전달` });
    if (cloud === "azure") {
      notes.push({ level: "adjusted", text: "DB 사설망 → Azure 내부 서비스만 허용하는 방화벽 + TLS: 이 템플릿은 가상 네트워크를 만들지 않습니다." });
    } else {
      notes.push({ level: "applied", text: "DB는 사설망 안에서만 접속됩니다." });
    }
  }
  notes.push({ level: "applied", text: vm ? `비밀값: ${services.secrets}에 보관하고, 서버가 자기 권한으로 직접 읽습니다.` : `비밀값: ${services.secrets}에 보관하고 컨테이너에는 환경변수로만 전달` });
  if (cloud === "gcp" && "PORT" in spec.env) {
    notes.push({ level: "adjusted", text: "PORT 환경변수 제외: Cloud Run이 컨테이너 포트 값으로 직접 넣습니다." });
  }
  if (cloud === "aws") notes.push({ level: "adjusted", text: `HTTPS → HTTP: 도메인과 인증서가 없어 ${vm ? "서버" : "로드밸런서"} 주소는 HTTP로 열립니다.` });
  return notes;
}
