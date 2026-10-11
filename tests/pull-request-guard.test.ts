import { describe, expect, it } from "vitest";
import { assertMergeableSetupPullRequest, type SetupPullRequestFacts } from "../lib/pull-request-guard";
import { WORKFLOW_PATH } from "../lib/workflow-template";

const valid: SetupPullRequestFacts = {
  state: "open",
  merged: false,
  headRef: "sbsb/setup-abc123-1a2b3c4",
  headRepo: "owner/app",
  baseRepo: "owner/app",
  authorType: "Bot",
  files: ["Dockerfile", WORKFLOW_PATH],
};

describe("assertMergeableSetupPullRequest", () => {
  it("accepts an open SBSB setup pull request that only touches its own files", () => {
    expect(() => assertMergeableSetupPullRequest(valid)).not.toThrow();
    expect(() => assertMergeableSetupPullRequest({ ...valid, files: ["Dockerfile"] })).not.toThrow();
  });

  it("rejects closed or already merged pull requests", () => {
    expect(() => assertMergeableSetupPullRequest({ ...valid, state: "closed" })).toThrow(/이미 닫혔거나/);
    expect(() => assertMergeableSetupPullRequest({ ...valid, merged: true })).toThrow(/이미 닫혔거나/);
  });

  it("rejects branches that SBSB did not create, including forks", () => {
    expect(() => assertMergeableSetupPullRequest({ ...valid, headRef: "feature/login" })).toThrow(/SBSB가 만든/);
    expect(() => assertMergeableSetupPullRequest({ ...valid, headRepo: "attacker/app" })).toThrow(/SBSB가 만든/);
    expect(() => assertMergeableSetupPullRequest({ ...valid, headRepo: null })).toThrow(/SBSB가 만든/);
  });

  it("rejects pull requests authored by a human", () => {
    expect(() => assertMergeableSetupPullRequest({ ...valid, authorType: "User" })).toThrow(/GitHub App/);
    expect(() => assertMergeableSetupPullRequest({ ...valid, authorType: null })).toThrow(/GitHub App/);
  });

  it("rejects pull requests that change anything beyond the Dockerfile and workflow", () => {
    expect(() => assertMergeableSetupPullRequest({ ...valid, files: ["Dockerfile", "src/secret.ts"] })).toThrow(/외의 파일/);
    expect(() => assertMergeableSetupPullRequest({ ...valid, files: [".github/workflows/other.yml"] })).toThrow(/외의 파일/);
    expect(() => assertMergeableSetupPullRequest({ ...valid, files: [] })).toThrow(/외의 파일/);
  });
});
