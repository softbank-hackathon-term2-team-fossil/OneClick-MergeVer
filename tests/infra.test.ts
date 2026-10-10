import { describe, expect, it } from "vitest";
import { diagnose, inferSpec, ruleBasedDraft } from "@/lib/infra/ai";
import { checkPolicy, summarizePlan } from "@/lib/infra/plan-summary";
import { appNameFor, capabilityNotes, defaultSpec, infraSpecSchema, servicesFor, templateFor } from "@/lib/infra/spec";

const change = (type: string, actions: string[], mode = "managed") => ({ address: `${type}.x`, type, name: "x", mode, change: { actions } });
const file = (path: string, content: string) => ({ path, content, truncated: false });
const answer = (value: unknown) => async () => JSON.stringify(value);

describe("infra spec", () => {
  it("derives a name every cloud accepts", () => {
    expect(appNameFor("won2eu/attendance-check")).toBe("attendance-check");
    expect(appNameFor("o/123_App.Name-That-Is-Far-Too-Long-For-Clouds")).toMatch(/^[a-z][a-z0-9-]{1,19}[a-z0-9]$/);
    expect(infraSpecSchema.safeParse(defaultSpec("o/x")).success).toBe(true);
  });

  it("rejects values outside the template's range", () => {
    const base = defaultSpec("o/app");
    expect(infraSpecSchema.safeParse({ ...base, database: "oracle" }).success).toBe(false);
    expect(infraSpecSchema.safeParse({ ...base, maxInstances: 50 }).success).toBe(false);
    expect(infraSpecSchema.safeParse({ ...base, minInstances: 2, maxInstances: 1 }).success).toBe(false);
    expect(infraSpecSchema.safeParse({ ...base, env: { DATABASE_URL: "x" } }).success).toBe(false);
    expect(infraSpecSchema.safeParse({ ...base, healthPath: "health" }).success).toBe(false);
  });

  it("states where a cloud cannot honour the spec", () => {
    const spec = { ...defaultSpec("o/app"), database: "postgres" as const };
    expect(capabilityNotes("aws", spec).some((note) => note.level === "adjusted" && note.text.includes("Fargate"))).toBe(true);
    expect(capabilityNotes("gcp", spec).every((note) => note.level === "applied")).toBe(true);
    expect(capabilityNotes("azure", spec).some((note) => note.level === "adjusted" && note.text.includes("방화벽"))).toBe(true);
  });
});

describe("run mode", () => {
  const vm = { ...defaultSpec("o/app"), compute: "vm" as const };

  it("picks the EC2 template on AWS and stays serverless where no VM template exists", () => {
    expect(templateFor("aws", vm)).toBe("aws-vm");
    expect(templateFor("aws", defaultSpec("o/app"))).toBe("aws");
    expect(templateFor("gcp", vm)).toBe("gcp");
    expect(servicesFor("aws", vm).web).toContain("EC2");
  });

  it("says what a single server gives up, and when a VM request falls back", () => {
    const aws = capabilityNotes("aws", vm).filter((note) => note.level === "adjusted").map((note) => note.text).join("\n");
    expect(aws).toContain("1대 고정");
    expect(aws).toContain("수 초 끊김");
    expect(capabilityNotes("azure", vm)[0]).toMatchObject({ level: "adjusted" });
  });

  it("treats a spec saved before the field existed as serverless", () => {
    const { compute: _dropped, ...old } = defaultSpec("o/app");
    expect(infraSpecSchema.parse(old).compute).toBe("serverless");
  });

  it("never lets the model change it", async () => {
    const draft = await inferSpec("o/app", [], null, answer({ compute: "vm", port: 3000, reasons: [], questions: [], warnings: [] }));
    expect(draft.spec).toMatchObject({ compute: "serverless", port: 3000 });
  });

  it("allows the server to be replaced on a redeploy but still protects the database", () => {
    expect(checkPolicy("aws", { resource_changes: [change("aws_instance", ["create", "delete"]), change("terraform_data", ["delete", "create"]), change("aws_eip", ["update"])] })).toEqual([]);
    expect(checkPolicy("aws", { resource_changes: [change("aws_instance", ["create", "delete"]), change("aws_db_instance", ["delete"])] })).toHaveLength(1);
  });
});

describe("plan verification", () => {
  it("summarises managed changes and ignores data sources and no-ops", () => {
    const summary = summarizePlan("aws", { resource_changes: [
      change("aws_db_instance", ["create"]),
      change("aws_ecs_service", ["update"]),
      change("aws_vpc", ["no-op"]),
      change("aws_availability_zones", ["read"], "data"),
    ] });
    expect(summary.counts).toEqual({ create: 1, update: 1, replace: 0, delete: 0 });
    expect(summary.changes[0]).toMatchObject({ label: "RDS 인스턴스", billable: true, slow: true });
  });

  it("refuses a deployment plan that deletes or replaces a database", () => {
    expect(checkPolicy("gcp", { resource_changes: [change("google_sql_database_instance", ["delete", "create"])] })).toHaveLength(1);
    expect(checkPolicy("azure", { resource_changes: [change("azurerm_postgresql_flexible_server", ["delete"])] })).toHaveLength(1);
    expect(checkPolicy("aws", { resource_changes: [change("aws_db_instance", ["update"]), change("aws_ecs_service", ["delete", "create"])] })).toEqual([]);
  });

  it("allows the database to go only in an explicit destroy", () => {
    expect(checkPolicy("aws", { resource_changes: [change("aws_db_instance", ["delete"])] }, { destroy: true })).toEqual([]);
  });

  it("refuses resource types the templates do not contain", () => {
    expect(checkPolicy("aws", { resource_changes: [change("aws_iam_user", ["create"])] })[0]).toContain("허용 목록");
  });
});

describe("AI spec drafting", () => {
  it("reads what it can without a model", () => {
    const draft = ruleBasedDraft("o/app", [file("requirements.txt", "flask\npsycopg2-binary")], 5000);
    expect(draft.spec).toMatchObject({ port: 5000, database: "postgres" });
    expect(ruleBasedDraft("o/app", [file("build.gradle", "sqlite-jdbc")], null).warnings[0]).toContain("SQLite");
  });

  it("keeps valid fields of an answer and drops invalid ones", async () => {
    const draft = await inferSpec("o/app", [file("package.json", "{}")], 3000, answer({
      port: 3000, healthPath: "no-slash", database: "mysql", maxInstances: 99, env: { NODE_ENV: "production" },
      secretNames: ["API_KEY"], reasons: ["포트 3000: Dockerfile"], questions: [], warnings: [],
    }));
    expect(draft.spec).toMatchObject({ port: 3000, healthPath: "/", database: "mysql", maxInstances: 2, env: { NODE_ENV: "production" }, secretNames: ["API_KEY"] });
    expect(draft.source).toBe("ai");
  });

  it("never lets the model rename the app or set platform variables", async () => {
    const draft = await inferSpec("o/app", [], null, answer({ appName: "other", env: { DATABASE_URL: "postgres://x" }, reasons: [], questions: [], warnings: [] }));
    expect(draft.spec.appName).toBe("app");
    expect(draft.spec.env).toEqual({});
  });
});

describe("failure diagnosis", () => {
  const spec = { ...defaultSpec("o/app"), database: "postgres" as const };

  it("turns a fixable error into a validated spec change", async () => {
    const result = await diagnose({ cloud: "gcp", stage: "health", spec, error: "connection refused on 8080" }, answer({ cause: "앱이 3000번에서 듣습니다.", action: "", patch: { port: 3000, appName: "x" } }));
    expect(result.patch).toEqual({ port: 3000 });
  });

  it("does not drop the database or accept out-of-range values", async () => {
    expect((await diagnose({ cloud: "aws", stage: "apply", spec, error: "e" }, answer({ cause: "c", action: "a", patch: { database: "none" } }))).patch).toBeNull();
    expect((await diagnose({ cloud: "aws", stage: "apply", spec, error: "e" }, answer({ cause: "c", action: "a", patch: { maxInstances: 100 } }))).patch).toBeNull();
  });

  it("returns no patch when the spec is not at fault", async () => {
    const result = await diagnose({ cloud: "azure", stage: "plan", spec, error: "AuthorizationFailed" }, answer({ cause: "권한이 없습니다.", action: "서비스 주체에 기여자 역할을 주세요.", patch: null }));
    expect(result).toEqual({ cause: "권한이 없습니다.", action: "서비스 주체에 기여자 역할을 주세요.", patch: null });
  });
});
