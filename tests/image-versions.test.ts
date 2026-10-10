import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dockerhub", () => ({
  dockerHubTag: (repository: string, reference: string) => `sbsb/sbsb-images:${repository.replace("/", "-")}-${reference}`,
  existingDockerHubReferences: vi.fn(),
}));

import type { Octokit } from "octokit";
import { existingDockerHubReferences } from "@/lib/dockerhub";
import { listImageVersions } from "../lib/image-versions";
import { WORKFLOW_NAME } from "../lib/workflow-template";

const sha = (digit: string) => digit.repeat(40);
const run = (overrides: Record<string, unknown>) => ({
  name: WORKFLOW_NAME, conclusion: "success", head_branch: "main", head_sha: sha("a"),
  created_at: "2026-10-09T01:00:00Z", updated_at: "2026-10-09T01:05:00Z", html_url: "https://github.com/acme/shop/actions/runs/1",
  ...overrides,
});
const clientWith = (runs: unknown[]) => ({
  rest: { actions: { listWorkflowRunsForRepo: vi.fn().mockResolvedValue({ data: { workflow_runs: runs } }) } },
}) as unknown as Octokit;
const published = vi.mocked(existingDockerHubReferences);

beforeEach(() => published.mockReset());

describe("deployable image versions", () => {
  it("lists successful SBSB builds whose image is still in Docker Hub", async () => {
    published.mockResolvedValueOnce(new Set([sha("a")]));
    const versions = await listImageVersions(clientWith([run({}), run({ head_sha: sha("b") })]), "acme/shop", "main");
    expect(versions).toEqual([{
      tag: sha("a"), image: `sbsb/sbsb-images:acme-shop-${sha("a")}`,
      publishedAt: "2026-10-09T01:05:00Z", runUrl: "https://github.com/acme/shop/actions/runs/1",
    }]);
  });

  it("ignores failed runs, other workflows, other branches, and repeated commits", async () => {
    published.mockImplementationOnce(async (_repository, references) => new Set(references));
    const versions = await listImageVersions(clientWith([
      run({}),
      run({}),
      run({ head_sha: sha("b"), conclusion: "failure" }),
      run({ head_sha: sha("c"), name: "CI" }),
      run({ head_sha: sha("d"), head_branch: "dev" }),
    ]), "acme/shop", "main");
    expect(versions.map((version) => version.tag)).toEqual([sha("a")]);
    expect(published).toHaveBeenCalledWith("acme/shop", [sha("a")]);
  });

  it("does not query Docker Hub when no build has succeeded", async () => {
    expect(await listImageVersions(clientWith([run({ conclusion: "failure" })]), "acme/shop", "main")).toEqual([]);
    expect(published).not.toHaveBeenCalled();
  });

  it("requires a branch", async () => {
    await expect(listImageVersions(clientWith([]), "acme/shop", "")).rejects.toThrow("브랜치");
  });
});
