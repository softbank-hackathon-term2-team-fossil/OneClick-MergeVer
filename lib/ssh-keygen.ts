import "server-only";

import { generateKeyPairSync } from "node:crypto";
import { utils } from "ssh2";

export type SshKeyPair = {
  publicKey: string;
  privateKey: string;
  setupCommand: string;
};

export function generateSshKeyPair(comment = "sbsb-deploy"): SshKeyPair {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  const parsed = utils.parseKey(privateKey);
  if (!parsed || parsed instanceof Error || typeof parsed.getPublicSSH !== "function") {
    throw new Error("Failed to format SSH public key.");
  }

  const publicKey = `ssh-rsa ${parsed.getPublicSSH().toString("base64")} ${comment}`;
  const setupCommand = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "${publicKey}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;

  return {
    publicKey,
    privateKey,
    setupCommand,
  };
}
