import "server-only";

import { generateKeyPairSync } from "node:crypto";
import { utils } from "ssh2";

export type SshKeyPair = {
  publicKey: string;
  privateKey: string;
  setupCommand: string;
};

export function formatSetupCommand(publicKey: string): string {
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "${publicKey}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (command -v docker >/dev/null 2>&1 || (sudo apt-get update -qq && sudo apt-get install -y -qq docker.io && sudo systemctl enable --now docker)) && sudo usermod -aG docker "$USER" 2>/dev/null && echo "✓ 서버 설정 완료: SSH 인증키 등록 및 Docker 준비가 완료되었습니다."`;
}

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
  const setupCommand = formatSetupCommand(publicKey);

  return {
    publicKey,
    privateKey,
    setupCommand,
  };
}
