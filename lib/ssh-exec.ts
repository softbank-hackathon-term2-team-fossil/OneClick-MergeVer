import "server-only";

import { Client } from "ssh2";

export type SshTarget = {
  host: string;
  sshPort: number;
  username: string;
  password?: string;
  privateKey?: string;
};

export type SshResult = { stdout: string; stderr: string; code: number };

// Runs a shell script on a server over SSH (script text goes through stdin of `bash -s`).
export function runSshScript(target: SshTarget, script: string, timeoutMs = 300_000): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error("서버 명령이 시간 안에 끝나지 않았습니다."));
    }, timeoutMs);
    client.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.once("ready", () => {
      client.exec("bash -s", (error, stream) => {
        if (error) {
          clearTimeout(timer);
          client.end();
          return reject(error);
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        stream.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          client.end();
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 });
        });
        stream.end(script);
      });
    });
    client.connect({
      host: target.host,
      port: target.sshPort,
      username: target.username,
      readyTimeout: 20_000,
      ...(target.privateKey ? { privateKey: target.privateKey } : { password: target.password }),
    });
  });
}
