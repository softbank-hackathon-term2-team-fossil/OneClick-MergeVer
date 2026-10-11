import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// AES-256-GCM with a key derived from SBSB_CREDENTIAL_ENCRYPTION_KEY.
// Used for everything SBSB keeps secret at rest: SSH credentials, database passwords, app variables.
export type EncryptedValue = {
  iv: string;
  tag: string;
  data: string;
};

function encryptionKey(): Buffer {
  const secret = process.env.SBSB_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("SBSB_CREDENTIAL_ENCRYPTION_KEY must contain at least 32 characters.");
  }
  return createHash("sha256").update(secret).digest();
}

export function encrypt(value: object): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: data.toString("base64url"),
  };
}

export function decrypt<T>(value: EncryptedValue): T {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(value.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  const data = Buffer.concat([
    decipher.update(Buffer.from(value.data, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(data.toString("utf8")) as T;
}
