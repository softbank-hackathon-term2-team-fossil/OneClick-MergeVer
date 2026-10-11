type FetchLike = typeof fetch;

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

// Docker Hub images named in FROM lines, as { repository: "library/python", reference: "3.13-slim" }.
// Earlier build stages, scratch, templated names and other registries are skipped: only Docker Hub
// can be checked without credentials.
export function baseImages(dockerfile: string): { image: string; repository: string; reference: string }[] {
  const stages = new Set<string>();
  const images = new Map<string, { image: string; repository: string; reference: string }>();
  for (const line of dockerfile.split(/\r?\n/)) {
    const match = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!match) continue;
    const image = match[1];
    if (match[2]) stages.add(match[2].toLowerCase());
    if (image === "scratch" || image.includes("$") || image.includes("@") || stages.has(image.toLowerCase())) continue;
    let name = image.replace(/^(index\.)?docker\.io\//, "");
    const first = name.split("/")[0];
    if (name.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")) continue;
    const colon = name.lastIndexOf(":");
    const reference = colon > 0 ? name.slice(colon + 1) : "latest";
    if (colon > 0) name = name.slice(0, colon);
    images.set(image, { image, repository: name.includes("/") ? name : `library/${name}`, reference });
  }
  return [...images.values()];
}

// Returns the FROM images that Docker Hub says do not exist. A model writes tags from memory and
// sometimes combines suffixes into one that was never published (eclipse-temurin:17-jre-slim-bookworm),
// which otherwise only surfaces minutes later as a failed build. Anything other than a clear 404
// (network trouble, rate limit) is treated as "unknown" and does not block.
export async function missingBaseImages(dockerfile: string, fetchImpl: FetchLike = fetch): Promise<string[]> {
  const missing: string[] = [];
  await Promise.all(baseImages(dockerfile).map(async ({ image, repository, reference }) => {
    try {
      const tokenResponse = await fetchImpl(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`, { signal: AbortSignal.timeout(8_000) });
      if (!tokenResponse.ok) return;
      const { token } = await tokenResponse.json() as { token?: string };
      if (!token) return;
      const manifest = await fetchImpl(`https://registry-1.docker.io/v2/${repository}/manifests/${encodeURIComponent(reference)}`, {
        method: "HEAD",
        headers: { Accept: MANIFEST_TYPES, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (manifest.status === 404) missing.push(image);
    } catch {
      // unknown, not missing
    }
  }));
  return missing.sort();
}
