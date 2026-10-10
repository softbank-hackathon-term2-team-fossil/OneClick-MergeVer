export function dockerfilePort(dockerfile: string): number | null {
  const exposed = [...dockerfile.matchAll(/^\s*EXPOSE\s+(\d+)(?:\/tcp)?(?:\s|$)/gim)];
  const port = Number(exposed.at(-1)?.[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}
