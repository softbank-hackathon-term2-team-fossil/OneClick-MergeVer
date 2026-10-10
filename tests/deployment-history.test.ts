import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: () => state.db }));

import {
  beginDeployment,
  completeDeployment,
  failDeployment,
  failInterruptedDeployments,
  listDeployments,
  resolveRollback,
} from "../lib/deployment-history";

const installationId = 4242;
const repository = "acme/shop";
const sha = (digit: string) => digit.repeat(40);
const begin = (overrides: Record<string, unknown> = {}) => beginDeployment({
  installationId, repository, target: "ONPREM", imageTag: sha("a"), image: `sbsb/images:acme-shop-${sha("a")}`, destination: "10.0.0.5:8000", ...overrides,
});
const succeed = async (overrides: Record<string, unknown> = {}) => {
  const record = await begin(overrides);
  await completeDeployment(record.id, { url: "https://example.trycloudflare.com" });
  return record;
};

beforeEach(() => { state.db = createFakeDb(); });

describe("deployment history", () => {
  it("numbers deployments per project and lists the newest first", async () => {
    await succeed();
    await succeed({ imageTag: sha("b") });
    const other = await beginDeployment({ installationId, repository: "acme/blog", target: "ONPREM", imageTag: sha("c"), image: "x" });
    expect(other.number).toBe(1);
    expect((await listDeployments(installationId, repository)).map((item) => item.number)).toEqual([2, 1]);
  });

  it("refuses a second deployment to the same target while one is running", async () => {
    await begin();
    await expect(begin({ imageTag: sha("b") })).rejects.toMatchObject({ status: 409 });
  });

  it("lets a different target deploy at the same time", async () => {
    await begin();
    await expect(begin({ target: "AWS" })).resolves.toMatchObject({ number: 2 });
  });

  it("records a failure with its reason and frees the target", async () => {
    const record = await begin();
    await failDeployment(record.id, new Error("SSH connection refused"));
    const [listed] = await listDeployments(installationId, repository);
    expect(listed).toMatchObject({ status: "FAILED", failureReason: "SSH connection refused", current: false, canRollback: false });
    await expect(begin()).resolves.toMatchObject({ number: 2 });
  });

  it("marks only the latest success per target as serving, and older ones as restorable", async () => {
    await succeed();
    await succeed({ imageTag: sha("b") });
    await succeed({ target: "AWS", imageTag: sha("c"), destination: "i-0abc" });
    const byNumber = Object.fromEntries((await listDeployments(installationId, repository)).map((item) => [item.number, item]));
    expect(byNumber[1]).toMatchObject({ current: false, canRollback: true });
    expect(byNumber[2]).toMatchObject({ current: true, canRollback: false });
    expect(byNumber[3]).toMatchObject({ target: "AWS", current: true, canRollback: false });
  });

  it("keeps the previous version serving when a newer deployment fails", async () => {
    await succeed();
    await failDeployment((await begin({ imageTag: sha("b") })).id, new Error("boom"));
    const byNumber = Object.fromEntries((await listDeployments(installationId, repository)).map((item) => [item.number, item]));
    expect(byNumber[1].current).toBe(true);
  });

  it("returns nothing for a repository that was never deployed", async () => {
    expect(await listDeployments(installationId, "acme/unknown")).toEqual([]);
  });
});

describe("rollback", () => {
  it("resolves the commit of a past successful on-premises deployment", async () => {
    const first = await succeed();
    await succeed({ imageTag: sha("b") });
    await expect(resolveRollback(installationId, repository, first.id)).resolves.toMatchObject({ imageTag: sha("a"), number: 1 });
  });

  it("records a rollback as its own deployment pointing at the restored one", async () => {
    const first = await succeed();
    await succeed({ imageTag: sha("b") });
    await succeed({ imageTag: sha("a"), rollbackOf: first.id });
    const [latest] = await listDeployments(installationId, repository);
    expect(latest).toMatchObject({ number: 3, trigger: "ROLLBACK", imageTag: sha("a"), current: true });
  });

  it("rejects a deployment of another project, a failed one, a cloud one, or a moving tag", async () => {
    const foreign = await beginDeployment({ installationId: 1, repository, target: "ONPREM", imageTag: sha("a"), image: "x" });
    const failed = await begin();
    await failDeployment(failed.id, new Error("boom"));
    const cloud = await succeed({ target: "AWS" });
    const moving = await succeed({ imageTag: "latest" });
    await expect(resolveRollback(installationId, repository, foreign.id)).rejects.toMatchObject({ status: 404 });
    await expect(resolveRollback(installationId, repository, failed.id)).rejects.toThrow("성공한 배포");
    await expect(resolveRollback(installationId, repository, cloud.id)).rejects.toThrow("온프레미스");
    await expect(resolveRollback(installationId, repository, moving.id)).rejects.toThrow("latest");
  });
});

describe("server restart", () => {
  it("fails deployments left running and leaves finished ones alone", async () => {
    await succeed();
    await begin({ imageTag: sha("b") });
    expect(await failInterruptedDeployments()).toBe(1);
    const [interrupted, finished] = await listDeployments(installationId, repository);
    expect(interrupted).toMatchObject({ status: "FAILED", failureReason: expect.stringContaining("재시작") });
    expect(finished.status).toBe("SUCCESS");
  });
});
