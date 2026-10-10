import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: () => state.db }));
process.env.SBSB_CREDENTIAL_ENCRYPTION_KEY = "test-encryption-key-with-at-least-32-chars!!";

import { databasesForDeploy, listDatabases, revealDatabasePassword, syncDetectedDatabases } from "../lib/database/store";
import { deleteEnvVar, listEnvVarKeys, readEnvVars, setEnvVar } from "../lib/project-env";
import { findProject } from "../lib/projects";

const installationId = 42;
const repository = "Owner/App";

describe("project databases", () => {
  beforeEach(() => {
    state.db = createFakeDb();
  });

  it("creates a database with a generated URL-safe password once", async () => {
    await syncDetectedDatabases(installationId, repository, ["postgres", "redis"]);
    expect(await listDatabases(installationId, repository)).toEqual([
      { kind: "postgres", image: "postgres:17-alpine" },
      { kind: "redis", image: "redis:7-alpine" },
    ]);

    const password = await revealDatabasePassword(installationId, repository, "postgres");
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await syncDetectedDatabases(installationId, repository, ["postgres"]);
    expect(await revealDatabasePassword(installationId, repository, "postgres")).toBe(password);
  });

  it("deactivates instead of forgetting a database that is no longer detected", async () => {
    await syncDetectedDatabases(installationId, repository, ["postgres"]);
    const password = await revealDatabasePassword(installationId, repository, "postgres");
    await syncDetectedDatabases(installationId, repository, []);
    expect(await listDatabases(installationId, repository)).toEqual([]);

    await syncDetectedDatabases(installationId, repository, ["postgres"]);
    expect(await revealDatabasePassword(installationId, repository, "postgres")).toBe(password);
  });

  it("stores passwords encrypted", async () => {
    await syncDetectedDatabases(installationId, repository, ["mysql"]);
    const password = await revealDatabasePassword(installationId, repository, "mysql");
    const project = await findProject(installationId, repository);
    const [row] = await (state.db as ReturnType<typeof createFakeDb>).projectDatabase.findMany({ where: { projectId: project!.id } });
    expect(JSON.stringify(row)).not.toContain(password);
  });

  it("gives deployments the active databases with their passwords, in display order", async () => {
    await syncDetectedDatabases(installationId, repository, ["redis", "postgres"]);
    const project = await findProject(installationId, repository);
    const specs = await databasesForDeploy(project!.id);
    expect(specs.map((spec) => spec.kind)).toEqual(["postgres", "redis"]);
    expect(specs[1].password).toBe("");
  });

  it("gives deployments the stored image and a separate MySQL root password", async () => {
    await syncDetectedDatabases(installationId, repository, ["mysql"]);
    const project = await findProject(installationId, repository);
    const [mysql] = await databasesForDeploy(project!.id);
    expect(mysql.image).toBe("mysql:8.4");
    expect(mysql.rootPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(mysql.rootPassword).not.toBe(mysql.password);
  });

  it("survives two analyses of a new repository at the same time", async () => {
    await Promise.all([
      syncDetectedDatabases(installationId, repository, ["postgres"]),
      syncDetectedDatabases(installationId, repository, ["postgres"]),
    ]);
    const project = await findProject(installationId, repository);
    expect(await (state.db as ReturnType<typeof createFakeDb>).projectDatabase.findMany({ where: { projectId: project!.id } })).toHaveLength(1);
  });

  it("refuses to reveal a database the project does not use", async () => {
    await expect(revealDatabasePassword(installationId, repository, "mongo")).rejects.toThrow();
  });
});

describe("project variables", () => {
  beforeEach(() => {
    state.db = createFakeDb();
  });

  it("stores values encrypted and lists only names", async () => {
    await setEnvVar(installationId, repository, { key: "API_KEY", value: "s3cret" });
    const keys = await listEnvVarKeys(installationId, repository);
    expect(keys.map((item) => item.key)).toEqual(["API_KEY"]);
    expect(JSON.stringify(keys)).not.toContain("s3cret");

    const project = await findProject(installationId, repository);
    expect(await readEnvVars(project!.id)).toEqual({ API_KEY: "s3cret" });
  });

  it("overwrites and deletes", async () => {
    await setEnvVar(installationId, repository, { key: "A", value: "1" });
    await setEnvVar(installationId, repository, { key: "A", value: "2" });
    const project = await findProject(installationId, repository);
    expect(await readEnvVars(project!.id)).toEqual({ A: "2" });
    await deleteEnvVar(installationId, repository, "A");
    expect(await readEnvVars(project!.id)).toEqual({});
  });

  it("rejects names and values an env file cannot carry", async () => {
    await expect(setEnvVar(installationId, repository, { key: "1BAD", value: "x" })).rejects.toThrow();
    await expect(setEnvVar(installationId, repository, { key: "BAD-NAME", value: "x" })).rejects.toThrow();
    await expect(setEnvVar(installationId, repository, { key: "OK", value: "a\nb" })).rejects.toThrow();
    await expect(setEnvVar(installationId, repository, { key: "OK", value: "x".repeat(4_097) })).rejects.toThrow();
  });
});
