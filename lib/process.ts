import "server-only";

import { spawn } from "node:child_process";

export async function run(command: string, args: string[], options: {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
} = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // A missing CLI otherwise surfaces as "spawn aws ENOENT", which does not tell the operator what to do.
      reject(error.code === "ENOENT" ? new Error(`사이트 서버에 ${command} 명령이 설치되어 있지 않습니다.`) : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else if (command === "docker" && args[0] === "build" && /Could not resolve|Temporary failure resolving|NameResolutionError/i.test(stderr)) {
        reject(new Error("Docker 빌드 컨테이너가 패키지 서버의 주소를 찾지 못했습니다. Docker Desktop의 인터넷/DNS 연결을 확인하고 다시 시도하세요."));
      } else reject(new Error(`${command} failed (${code}): ${stderr.trim().slice(-800)}`));
    });
    child.stdin.end(options.input);
  });
}

export async function aws<T>(region: string, service: string, action: string, args: string[] = []): Promise<T> {
  const output = await run("aws", [service, action, ...args, "--region", region, "--output", "json"], {
    timeoutMs: 120_000,
  });
  return JSON.parse(output || "{}") as T;
}
