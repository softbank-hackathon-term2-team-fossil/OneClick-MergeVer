import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { ensureProject, findProject } from "@/lib/projects";
import { decrypt, encrypt, type EncryptedValue } from "@/lib/secret-box";
import { formatSetupCommand, generateSshKeyPair } from "./ssh-keygen";

export type DeploymentConnection = {
  host: string;
  sshPort: number;
  username: string;
  password?: string;
  privateKey?: string;
  hostPort: number;
  containerPort: number;
};

export type SavedDeploymentTarget = Omit<DeploymentConnection, "password" | "privateKey"> & {
  authType: "password" | "private-key";
  updatedAt: string;
};

// The JSON file used before the database existed. Read once per project to carry saved servers over.
type LegacyStore = Record<string, { target: SavedDeploymentTarget; credential: EncryptedValue }>;
const legacyStorePath = path.join(process.cwd(), ".sbsb-data", "deployments.json");

export function recordId(installationId: number, repository: string): string {
  return createHash("sha256")
    .update(`${installationId}:${repository.toLowerCase()}`)
    .digest("hex");
}

type ServerRow = {
  host: string;
  sshPort: number;
  username: string;
  hostPort: number;
  containerPort: number;
  authType: "PASSWORD" | "PRIVATE_KEY";
  encryptedCredential: string;
  iv: string;
  authTag: string;
  updatedAt: Date;
};

function toTarget(row: ServerRow): SavedDeploymentTarget {
  return {
    host: row.host,
    sshPort: row.sshPort,
    username: row.username,
    hostPort: row.hostPort,
    containerPort: row.containerPort,
    authType: row.authType === "PRIVATE_KEY" ? "private-key" : "password",
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serverData(target: Omit<SavedDeploymentTarget, "updatedAt">, credential: EncryptedValue) {
  return {
    host: target.host,
    sshPort: target.sshPort,
    username: target.username,
    hostPort: target.hostPort,
    containerPort: target.containerPort,
    authType: target.authType === "private-key" ? "PRIVATE_KEY" as const : "PASSWORD" as const,
    encryptedCredential: credential.data,
    iv: credential.iv,
    authTag: credential.tag,
  };
}

async function upsertServer(
  installationId: number,
  repository: string,
  target: Omit<SavedDeploymentTarget, "updatedAt">,
  credential: EncryptedValue,
): Promise<ServerRow> {
  const project = await ensureProject(installationId, repository);
  const data = serverData(target, credential);
  return db().server.upsert({ where: { projectId: project.id }, create: { projectId: project.id, ...data }, update: data });
}

// A server saved before the database existed lives in the JSON file under a one-way hash of
// (installation, repository). It is copied into the database the first time that project asks for it.
async function importLegacyServer(installationId: number, repository: string): Promise<ServerRow | null> {
  let store: LegacyStore;
  try {
    store = JSON.parse(await readFile(legacyStorePath, "utf8")) as LegacyStore;
  } catch {
    return null;
  }
  const stored = store[recordId(installationId, repository)];
  if (!stored) return null;
  return upsertServer(installationId, repository, stored.target, stored.credential);
}

async function findServer(installationId: number, repository: string): Promise<ServerRow | null> {
  const project = await findProject(installationId, repository);
  const server = project ? await db().server.findUnique({ where: { projectId: project.id } }) : null;
  return server ?? importLegacyServer(installationId, repository);
}

export async function saveDeploymentConnection(
  installationId: number,
  repository: string,
  connection: DeploymentConnection,
): Promise<SavedDeploymentTarget> {
  const credential = encrypt({ password: connection.password, privateKey: connection.privateKey });
  const row = await upsertServer(
    installationId,
    repository,
    { ...connection, authType: connection.privateKey ? "private-key" : "password" },
    credential,
  );
  return toTarget(row);
}

export async function getSavedDeploymentTarget(
  installationId: number,
  repository: string,
): Promise<SavedDeploymentTarget | null> {
  const row = await findServer(installationId, repository);
  return row ? toTarget(row) : null;
}

export async function getDeploymentConnection(
  installationId: number,
  repository: string,
): Promise<DeploymentConnection | null> {
  const row = await findServer(installationId, repository);
  if (!row) return null;
  const credential = decrypt<Pick<DeploymentConnection, "password" | "privateKey">>({
    iv: row.iv,
    tag: row.authTag,
    data: row.encryptedCredential,
  });
  const { authType: _authType, updatedAt: _updatedAt, ...target } = toTarget(row);
  return { ...target, ...credential };
}

// Removes the saved server. Deployment history is kept; it belongs to the project, not the server.
export async function deleteDeploymentConnection(
  installationId: number,
  repository: string,
): Promise<void> {
  const project = await findProject(installationId, repository);
  if (project) await db().server.deleteMany({ where: { projectId: project.id } });
  await removeLegacyServer(installationId, repository);
}

// Without this, a deleted server would be imported again from the old file on the next read.
async function removeLegacyServer(installationId: number, repository: string): Promise<void> {
  let store: LegacyStore;
  try {
    store = JSON.parse(await readFile(legacyStorePath, "utf8")) as LegacyStore;
  } catch {
    return;
  }
  const id = recordId(installationId, repository);
  if (!(id in store)) return;
  delete store[id];
  await writeFile(legacyStorePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

type StoredSshKey = {
  publicKey: string;
  setupCommand: string;
  credential: EncryptedValue;
};

type KeyStore = Record<string, StoredSshKey>;

const storeDirectory = path.join(process.cwd(), ".sbsb-data");
const keyStorePath = path.join(storeDirectory, "ssh-keys.json");
let writeQueue: Promise<void> = Promise.resolve();

async function readKeyStore(): Promise<KeyStore> {
  try {
    return JSON.parse(await readFile(keyStorePath, "utf8")) as KeyStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeKeyStore(store: KeyStore): Promise<void> {
  await mkdir(storeDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${keyStorePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, keyStorePath);
}

export async function getOrCreateRepositorySshKey(
  installationId: number,
  repository: string,
): Promise<{ publicKey: string; setupCommand: string; privateKey: string }> {
  await writeQueue;
  const id = recordId(installationId, repository);
  const store = await readKeyStore();
  if (store[id]) {
    const credential = decrypt<{ privateKey: string }>(store[id].credential);
    return {
      publicKey: store[id].publicKey,
      setupCommand: formatSetupCommand(store[id].publicKey),
      privateKey: credential.privateKey,
    };
  }

  const generated = generateSshKeyPair(`sbsb-deploy@${repository}`);
  const credential = encrypt({ privateKey: generated.privateKey });

  writeQueue = writeQueue.then(async () => {
    const s = await readKeyStore();
    s[id] = {
      publicKey: generated.publicKey,
      setupCommand: generated.setupCommand,
      credential,
    };
    await writeKeyStore(s);
  });
  await writeQueue;

  return {
    publicKey: generated.publicKey,
    setupCommand: generated.setupCommand,
    privateKey: generated.privateKey,
  };
}
