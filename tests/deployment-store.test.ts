import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";

const state = vi.hoisted(() => ({ db: null as unknown, files: new Map<string, string>() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: () => state.db }));
// The legacy JSON store is the only file this module touches.
vi.mock("node:fs/promises", () => ({
  readFile: async (path: string) => {
    const content = state.files.get(path);
    if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return content;
  },
  writeFile: async (path: string, content: string) => { state.files.set(path, content); },
}));
process.env.SBSB_CREDENTIAL_ENCRYPTION_KEY = "test-encryption-key-with-at-least-32-chars!!";

import { createHash } from "node:crypto";
import path from "node:path";
import {
  saveDeploymentConnection,
  getSavedDeploymentTarget,
  getDeploymentConnection,
  deleteDeploymentConnection,
} from "../lib/deployment-store";

describe("deployment-store", () => {
  const installationId = 999999;
  const repository = "test-owner/test-repo";
  const connection = {
    host: "192.168.1.100",
    sshPort: 22,
    username: "deployer",
    password: "secret-password-123",
    hostPort: 8080,
    containerPort: 3000,
  };

  beforeEach(() => {
    state.db = createFakeDb();
    state.files.clear();
  });

  it("saves connection and retrieves public target metadata without secrets", async () => {
    const saved = await saveDeploymentConnection(installationId, repository, connection);
    expect(saved.host).toBe(connection.host);
    expect(saved.username).toBe(connection.username);
    expect(saved.hostPort).toBe(connection.hostPort);
    expect(saved.containerPort).toBe(connection.containerPort);
    expect(saved.authType).toBe("password");
    expect("password" in saved).toBe(false);

    const target = await getSavedDeploymentTarget(installationId, repository);
    expect(target).not.toBeNull();
    expect(target?.host).toBe(connection.host);
    expect(target?.authType).toBe("password");
  });

  it("decrypts connection credentials accurately", async () => {
    await saveDeploymentConnection(installationId, repository, connection);

    const decrypted = await getDeploymentConnection(installationId, repository);
    expect(decrypted).not.toBeNull();
    expect(decrypted?.password).toBe("secret-password-123");
    expect(decrypted?.host).toBe("192.168.1.100");
  });

  it("never stores the credential in plain text", async () => {
    await saveDeploymentConnection(installationId, repository, connection);
    const project = await (state.db as ReturnType<typeof createFakeDb>).project.findUnique({
      where: { installationId_repository: { installationId: BigInt(installationId), repository } },
    });
    const row = await (state.db as ReturnType<typeof createFakeDb>).server.findUnique({ where: { projectId: project!.id } });
    expect(JSON.stringify(row)).not.toContain("secret-password-123");
  });

  it("treats repository names case-insensitively and keeps one server per project", async () => {
    await saveDeploymentConnection(installationId, "Test-Owner/Test-Repo", connection);
    await saveDeploymentConnection(installationId, repository, { ...connection, host: "10.0.0.5", password: undefined, privateKey: "KEY" });
    const target = await getSavedDeploymentTarget(installationId, "TEST-OWNER/TEST-REPO");
    expect(target?.host).toBe("10.0.0.5");
    expect(target?.authType).toBe("private-key");
    expect((await getDeploymentConnection(installationId, repository))?.privateKey).toBe("KEY");
  });

  it("deletes deployment connection cleanly", async () => {
    await saveDeploymentConnection(installationId, repository, connection);
    expect(await getSavedDeploymentTarget(installationId, repository)).not.toBeNull();

    await deleteDeploymentConnection(installationId, repository);
    expect(await getSavedDeploymentTarget(installationId, repository)).toBeNull();
    expect(await getDeploymentConnection(installationId, repository)).toBeNull();
  });

  describe("servers saved before the database existed", () => {
    const legacyPath = path.join(process.cwd(), ".sbsb-data", "deployments.json");
    const legacyId = createHash("sha256").update(`${installationId}:${repository}`).digest("hex");

    // Produce a legacy file the way the old store did: save through the module, then move the row into the file.
    async function seedLegacyFile() {
      await saveDeploymentConnection(installationId, repository, connection);
      const fake = state.db as ReturnType<typeof createFakeDb>;
      const project = await fake.project.findUnique({ where: { installationId_repository: { installationId: BigInt(installationId), repository } } });
      const row = (await fake.server.findUnique({ where: { projectId: project!.id } }))!;
      state.files.set(legacyPath, JSON.stringify({
        [legacyId]: {
          target: { host: row.host, sshPort: row.sshPort, username: row.username, hostPort: row.hostPort, containerPort: row.containerPort, authType: "password", updatedAt: "2026-10-01T00:00:00.000Z" },
          credential: { iv: row.iv, tag: row.authTag, data: row.encryptedCredential },
        },
      }));
      state.db = createFakeDb();
    }

    it("imports the server on first read, including its credential", async () => {
      await seedLegacyFile();
      expect((await getSavedDeploymentTarget(installationId, repository))?.host).toBe(connection.host);
      expect((await getDeploymentConnection(installationId, repository))?.password).toBe("secret-password-123");
    });

    it("does not bring a deleted server back from the old file", async () => {
      await seedLegacyFile();
      await getSavedDeploymentTarget(installationId, repository);
      await deleteDeploymentConnection(installationId, repository);
      expect(await getSavedDeploymentTarget(installationId, repository)).toBeNull();
    });
  });
});
