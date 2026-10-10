export function inferContainerPort(dockerfile: string): number | null {
  for (const line of dockerfile.split(/\r?\n/)) {
    const match = /^\s*EXPOSE\s+(.+)$/i.exec(line);
    if (!match) continue;
    for (const token of match[1].trim().split(/\s+/)) {
      const port = /^(\d{1,5})(\/(tcp|udp))?$/i.exec(token);
      if (!port) continue;
      const value = Number(port[1]);
      if (value >= 1 && value <= 65535) return value;
    }
  }
  return null;
}

export function serviceNameFor(repository: string): string {
  const repo = repository.split("/").pop() ?? "";
  let name = repo
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!name) name = "app";
  if (!/^[a-z]/.test(name)) name = `app-${name}`;
  return name.slice(0, 41).replace(/-+$/, "");
}

const locks = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}
