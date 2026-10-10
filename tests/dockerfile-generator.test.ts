import { describe, expect, it } from "vitest";
import { validateDockerfile } from "../lib/dockerfile-validation";

describe("validateDockerfile", () => {
  it("accepts and normalizes a runnable Dockerfile", () => {
    const result = validateDockerfile(`FROM python:3.13-slim
WORKDIR /app
COPY . .
CMD ["python", "main.py"]`);
    expect(result).toMatch(/^FROM python:3\.13-slim/);
    expect(result.endsWith("\n")).toBe(true);
  });

  it("removes an accidental Markdown fence", () => {
    const result = validateDockerfile(
      "```dockerfile\nFROM node:22-slim\nCMD [\"node\", \"index.js\"]\n```",
    );
    expect(result).not.toContain("```");
  });

  it("upgrades obsolete Debian bullseye runtime tags", () => {
    const result = validateDockerfile(
      'FROM python:3.11-slim-bullseye\nCMD ["python", "main.py"]',
    );
    expect(result).toContain("FROM python:3.11-slim-bookworm");
    expect(result).not.toContain("bullseye");
  });

  it("rejects Dockerfiles without a runtime command", () => {
    expect(() => validateDockerfile("FROM alpine:3.21\nRUN echo ok")).toThrow(
      /CMD or ENTRYPOINT/,
    );
  });

  it("rejects embedded credentials", () => {
    expect(() =>
      validateDockerfile(
        "FROM alpine:3.21\nENV TOKEN=AKIAABCDEFGHIJKLMNOP\nCMD [\"sh\"]",
      ),
    ).toThrow(/unsafe/);
  });
});
