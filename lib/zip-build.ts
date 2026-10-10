import "server-only";

import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, lstat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { run } from "@/lib/process";
import { detectFramework, detectPackageManager, isAllowedPath } from "@/lib/repository-analysis";
import { generateDockerfile } from "@/lib/dockerfile-generator";
import type { AnalyzedFile, RepositoryAnalysis } from "@/lib/types";

export async function prepareZip(file: File): Promise<{ root: string; folder: string; dockerfile: string; tag: string; analysis: RepositoryAnalysis }> {
  if (!file.name.toLowerCase().endsWith(".zip")) throw new Error("ZIP 파일만 업로드할 수 있습니다.");
  if (file.size === 0 || file.size > 25 * 1024 * 1024) throw new Error("ZIP 크기는 25MB 이하여야 합니다.");
  const folder = await mkdtemp(join(tmpdir(), "sbsb-"));
  try {
  const archive = join(folder, "source.zip");
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(archive, bytes, { mode: 0o600 });
  const root = join(folder, "source");
  await run("python3", [join(process.cwd(), "scripts", "extract_zip.py"), archive, root], { timeoutMs: 30_000 });
  const initial = await readdir(root, { withFileTypes: true });
  const project = initial.length === 1 && initial[0].isDirectory() ? join(root, initial[0].name) : root;
  const files: AnalyzedFile[] = [];
  let totalBytes = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("심볼릭 링크가 포함된 ZIP은 사용할 수 없습니다.");
      if (stat.isDirectory()) { await walk(path); continue; }
      if (!stat.isFile()) throw new Error("일반 파일이 아닌 항목이 포함되었습니다.");
      totalBytes += stat.size;
      if (totalBytes > 100 * 1024 * 1024) throw new Error("압축을 푼 크기는 100MB 이하여야 합니다.");
      const name = relative(project, path).replaceAll("\\", "/");
      if (isAllowedPath(name) && files.length < 18) {
        const content = await readFile(path, "utf8");
        files.push({ path: name, content: content.slice(0, 14_000), truncated: content.length > 14_000 });
      }
    }
  }
  await walk(project);
  if (!files.length) throw new Error("빌드 설정 파일을 찾지 못했습니다. package.json, requirements.txt 등의 파일이 필요합니다.");
  const analysis: RepositoryAnalysis = {
    repository: file.name, branch: "zip", framework: detectFramework(files), packageManager: detectPackageManager(files),
    files, ignoredFileCount: 0, warnings: [],
  };
  const dockerfile = await generateDockerfile(analysis);
  await writeFile(join(project, "Dockerfile"), dockerfile);
  await writeFile(join(project, ".dockerignore"), [
    ".git", ".github", "node_modules", "dist", "build", "*.pem", "*.key", "*.p12", "*.pfx", ".env", ".env.*", "*secret*", "*credential*",
  ].join("\n") + "\n");
  const tag = `zip-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}-${randomUUID().slice(0, 8)}`;
  return { root: project, folder, dockerfile, tag, analysis };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
