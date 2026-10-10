import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Runs against a real Postgres. Point SBSB_TEST_DATABASE_URL at a database you can wipe
// (never the one a live server is using: the restart-cleanup test fails every running deployment).
//   createdb sbsb_test && DATABASE_URL=<test url> pnpm db:deploy
//   SBSB_TEST_DATABASE_URL=<test url> pnpm test
const url = process.env.SBSB_TEST_DATABASE_URL;

vi.mock("server-only", () => ({}));
process.env.SBSB_CREDENTIAL_ENCRYPTION_KEY = "test-encryption-key-with-at-least-32-chars!!";
if (url) process.env.DATABASE_URL = url;

const installationId = 987654321;
const repository = "integration/sample";
const sha = (digit: string) => digit.repeat(40);

describe.skipIf(!url)("database integration", () => {
  const load = async () => ({
    ...(await import("../lib/db")),
    ...(await import("../lib/deployment-store")),
    ...(await import("../lib/deployment-history")),
  });

  beforeEach(async () => {
    const { db } = await load();
    await db().project.deleteMany({ where: { installationId: BigInt(installationId) } });
  });

  afterAll(async () => {
    if (!url) return;
    const { db } = await load();
    await db().project.deleteMany({ where: { installationId: BigInt(installationId) } });
    await db().$disconnect();
  });

  it("stores a server encrypted and reads it back", async () => {
    const { db, saveDeploymentConnection, getDeploymentConnection, deleteDeploymentConnection } = await load();
    await saveDeploymentConnection(installationId, "Integration/Sample", {
      host: "10.0.0.5", sshPort: 2222, username: "deployer", password: "plain-secret", hostPort: 8000, containerPort: 3000,
    });
    const stored = await db().server.findFirstOrThrow({ where: { project: { installationId: BigInt(installationId) } } });
    expect(JSON.stringify(stored)).not.toContain("plain-secret");
    expect(await getDeploymentConnection(installationId, repository)).toMatchObject({ host: "10.0.0.5", sshPort: 2222, password: "plain-secret" });

    await deleteDeploymentConnection(installationId, repository);
    expect(await getDeploymentConnection(installationId, repository)).toBeNull();
  });

  it("lets only one of two simultaneous deployments to the same target start", async () => {
    const { beginDeployment, listDeployments } = await load();
    const input = { installationId, repository, target: "ONPREM" as const, imageTag: sha("a"), image: "sbsb/images:a" };
    const results = await Promise.allSettled([beginDeployment(input), beginDeployment(input)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
    expect(await listDeployments(installationId, repository)).toHaveLength(1);
  });

  it("records history, marks the serving version, and resolves a rollback", async () => {
    const { beginDeployment, completeDeployment, failDeployment, listDeployments, resolveRollback } = await load();
    const base = { installationId, repository, target: "ONPREM" as const, image: "sbsb/images:x", destination: "10.0.0.5:8000" };
    const first = await beginDeployment({ ...base, imageTag: sha("a") });
    await completeDeployment(first.id, { url: "https://one.trycloudflare.com" });
    const second = await beginDeployment({ ...base, imageTag: sha("b") });
    await completeDeployment(second.id, { url: "https://one.trycloudflare.com" });
    const third = await beginDeployment({ ...base, imageTag: sha("c") });
    await failDeployment(third.id, new Error("container did not start"));

    const listed = await listDeployments(installationId, repository);
    expect(listed.map((item) => [item.number, item.status, item.current, item.canRollback])).toEqual([
      [3, "FAILED", false, false],
      [2, "SUCCESS", true, false],
      [1, "SUCCESS", false, true],
    ]);
    expect(listed[0].failureReason).toBe("container did not start");

    const target = await resolveRollback(installationId, repository, first.id);
    expect(target.imageTag).toBe(sha("a"));
    const restored = await beginDeployment({ ...base, imageTag: target.imageTag, rollbackOf: target.id });
    await completeDeployment(restored.id, { url: "https://one.trycloudflare.com" });
    const [latest] = await listDeployments(installationId, repository);
    expect(latest).toMatchObject({ number: 4, trigger: "ROLLBACK", imageTag: sha("a"), current: true });
  });

  it("keeps database passwords and app variables encrypted, and plans the on-premises app from them", async () => {
    const { db, beginDeployment } = await load();
    const { syncDetectedDatabases, revealDatabasePassword } = await import("../lib/database/store");
    const { setEnvVar } = await import("../lib/project-env");
    const { planOnPremiseApp } = await import("../lib/database/plan");

    await syncDetectedDatabases(installationId, repository, ["postgres", "redis"]);
    await syncDetectedDatabases(installationId, repository, ["postgres", "redis"]);
    await setEnvVar(installationId, repository, { key: "API_KEY", value: "plain-api-key" });
    const password = await revealDatabasePassword(installationId, repository, "postgres");

    const project = await db().project.findFirstOrThrow({ where: { installationId: BigInt(installationId) } });
    const rows = await db().projectDatabase.findMany({ where: { projectId: project.id } });
    const variables = await db().projectEnvVar.findMany({ where: { projectId: project.id } });
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(password);
    expect(JSON.stringify(variables)).not.toContain("plain-api-key");

    const plan = await planOnPremiseApp(project.id, "sbsb/images:x");
    expect(plan.databases).toEqual(["postgres", "redis"]);
    expect(plan.appEnv).toMatchObject({ API_KEY: "plain-api-key", DATABASE_URL: `postgresql://app:${password}@db:5432/app` });

    const record = await beginDeployment({ installationId, repository, target: "ONPREM", imageTag: sha("a"), image: "sbsb/images:x", databases: plan.databases });
    expect((await db().deployment.findUniqueOrThrow({ where: { id: record.id } })).databases).toEqual(["postgres", "redis"]);
  });

  it("fails deployments left running when the server restarts", async () => {
    const { beginDeployment, failInterruptedDeployments, listDeployments } = await load();
    await beginDeployment({ installationId, repository, target: "AWS", imageTag: sha("a"), image: "sbsb/images:a" });
    expect(await failInterruptedDeployments()).toBeGreaterThanOrEqual(1);
    expect((await listDeployments(installationId, repository))[0]).toMatchObject({ status: "FAILED" });
  });
});
