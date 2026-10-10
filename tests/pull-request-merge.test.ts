import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { Octokit } from "octokit";
import { WORKFLOW_PATH } from "../lib/workflow-template";

const { loadSetupPullRequest, mergeSetupPullRequest } = await import("../lib/pull-request");

function fakeClient(options: { files?: string[]; authorType?: string; headRef?: string; mergeError?: number } = {}) {
  const merge = vi.fn(async () => {
    if (options.mergeError) throw Object.assign(new Error("blocked"), { status: options.mergeError });
    return { data: { sha: "abc123", merged: true } };
  });
  const deleteRef = vi.fn(async () => ({}));
  const listFiles = vi.fn();
  const client = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            state: "open",
            merged: false,
            head: { ref: options.headRef ?? "sbsb/setup-x-1", repo: { full_name: "o/r" } },
            base: { repo: { full_name: "o/r" } },
            user: { type: options.authorType ?? "Bot" },
          },
        }),
        listFiles,
        merge,
      },
      git: { deleteRef },
    },
    paginate: async () => (options.files ?? ["Dockerfile", WORKFLOW_PATH]).map((filename) => ({ filename })),
  } as unknown as Octokit;
  return { client, merge, deleteRef };
}

describe("mergeSetupPullRequest", () => {
  it("squash-merges a valid setup pull request and deletes its branch", async () => {
    const { client, merge, deleteRef } = fakeClient();
    await expect(mergeSetupPullRequest(client, "o/r", 7)).resolves.toEqual({ sha: "abc123" });
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 7, merge_method: "squash" }));
    expect(deleteRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "heads/sbsb/setup-x-1" }));
  });

  it("never calls merge when the pull request touches other files", async () => {
    const { client, merge } = fakeClient({ files: ["Dockerfile", "package.json"] });
    await expect(mergeSetupPullRequest(client, "o/r", 7)).rejects.toThrow(/외의 파일/);
    expect(merge).not.toHaveBeenCalled();
  });

  it("never calls merge for a branch SBSB did not create", async () => {
    const { client, merge } = fakeClient({ headRef: "feature/x" });
    await expect(mergeSetupPullRequest(client, "o/r", 7)).rejects.toThrow(/SBSB가 만든/);
    expect(merge).not.toHaveBeenCalled();
  });

  it("explains branch protection and conflicts", async () => {
    const { client } = fakeClient({ mergeError: 405 });
    await expect(mergeSetupPullRequest(client, "o/r", 7)).rejects.toThrow(/브랜치 보호 규칙/);
  });

  it("loadSetupPullRequest returns the changed files for the review screen", async () => {
    const { client } = fakeClient();
    const loaded = await loadSetupPullRequest(client, "o/r", 7);
    expect(loaded.files.map((file) => file.filename)).toEqual(["Dockerfile", WORKFLOW_PATH]);
  });
});
