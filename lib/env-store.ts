import "server-only";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt, recordId, type EncryptedValue } from "@/lib/deployment-store";
import { validateAppEnv, type AppEnv } from "@/lib/app-env";

// Environment variables are encrypted at rest with the same key as the saved server credentials.
// Values are never returned to the browser; only the names are.
type Store = Record<string, EncryptedValue>;

const storeDirectory = path.join(process.cwd(), ".sbsb-data");
const storePath = path.join(storeDirectory, "app-env.json");
let queue: Promise<void> = Promise.resolve();

async function readStore(): Promise<Store> {
  try {
    return JSON.parse(await readFile(storePath, "utf8")) as Store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeStore(store: Store): Promise<void> {
  await mkdir(storeDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${storePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, storePath);
}

export async function getAppEnv(installationId: number, repository: string): Promise<AppEnv> {
  await queue;
  const entry = (await readStore())[recordId(installationId, repository)];
  return entry ? decrypt<AppEnv>(entry) : {};
}

export async function setAppEnv(installationId: number, repository: string, env: AppEnv): Promise<void> {
  const valid = validateAppEnv(env);
  const id = recordId(installationId, repository);
  queue = queue.then(async () => {
    const store = await readStore();
    if (Object.keys(valid).length === 0) delete store[id];
    else store[id] = encrypt(valid);
    await writeStore(store);
  });
  await queue;
}
