import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: () => state.db }));
process.env.SBSB_CREDENTIAL_ENCRYPTION_KEY = "test-encryption-key-with-at-least-32-chars!!";

import { planOnPremiseApp } from "../lib/database/plan";
import { syncDetectedDatabases } from "../lib/database/store";
import { appIdentifier } from "../lib/on-premise-deployment";
import { findProject } from "../lib/projects";

const installationId = 7;
const repository = "owner/app";
const appId = appIdentifier(repository);

async function projectId() {
  return (await findProject(installationId, repository))!.id;
}

describe("planOnPremiseApp", () => {
  beforeEach(() => {
    state.db = createFakeDb();
  });

  it("has no data stack and no variables for an app without databases", async () => {
    await syncDetectedDatabases(installationId, repository, []);
    expect(await planOnPremiseApp(await projectId(), appId, { API_KEY: "k" })).toEqual({ appEnv: { API_KEY: "k" }, databases: [] });
  });

  it("runs detected databases on the app's network and hands the app their URLs", async () => {
    await syncDetectedDatabases(installationId, repository, ["postgres", "redis"]);
    const plan = await planOnPremiseApp(await projectId(), appId, {});

    expect(plan.databases).toEqual(["postgres", "redis"]);
    expect(plan.dataStack?.project).toBe(`sbsb-data-${appId}`);
    expect(JSON.parse(plan.dataStack!.compose).networks).toEqual({ [`sbsb-net-${appId}`]: { external: true } });
    expect(plan.appEnv.DATABASE_URL).toMatch(/^postgresql:\/\/app:[A-Za-z0-9_-]+@db:5432\/app$/);
    expect(plan.appEnv.REDIS_URL).toBe("redis://cache:6379");
  });

  it("leaves out a database the user connects to with their own variable, and user values win", async () => {
    await syncDetectedDatabases(installationId, repository, ["postgres", "redis"]);
    const userEnv = { DATABASE_URL: "postgresql://u:p@rds:5432/x", DB_HOST: "rds" };
    const plan = await planOnPremiseApp(await projectId(), appId, userEnv);

    expect(plan.databases).toEqual(["redis"]);
    expect(Object.keys(JSON.parse(plan.dataStack!.compose).services)).toEqual(["cache"]);
    expect(plan.appEnv).toEqual({ REDIS_URL: "redis://cache:6379", DATABASE_URL: "postgresql://u:p@rds:5432/x", DB_HOST: "rds" });
  });
});
