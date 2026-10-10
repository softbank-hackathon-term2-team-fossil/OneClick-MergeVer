const SECRET_PATTERN = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,})/;

export function validateDockerfile(input: string): string {
  const dockerfile = input
    .trim()
    .replace(/^```(?:dockerfile)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/^(FROM\s+\S+)-bullseye(?=\s|$)/gim, "$1-bookworm")
    // The official Python image uses `slim-bookworm`, not `bookworm-slim`.
    // Normalize this common LLM-generated typo before Docker sees it.
    .replace(/^(FROM\s+python:[^\s:]+)-bookworm-slim(?=\s|$)/gim, "$1-slim-bookworm")
    .trim();

  if (!/^FROM\s+\S+/im.test(dockerfile)) {
    throw new Error("The generated Dockerfile has no FROM instruction.");
  }
  if (!/^(CMD|ENTRYPOINT)\s+/im.test(dockerfile)) {
    throw new Error("The generated Dockerfile has no CMD or ENTRYPOINT.");
  }
  if (/^ADD\s+https?:\/\//im.test(dockerfile)) {
    throw new Error("Remote URL downloads are not allowed in generated Dockerfiles.");
  }
  if (/--privileged/i.test(dockerfile) || SECRET_PATTERN.test(dockerfile)) {
    throw new Error("The generated Dockerfile contains an unsafe instruction.");
  }
  if (dockerfile.length > 12_000) {
    throw new Error("The generated Dockerfile is unexpectedly large.");
  }
  return `${dockerfile}\n`;
}
