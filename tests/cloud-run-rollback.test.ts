import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rollbackToRevision = vi.fn(async () => undefined);
vi.mock("../lib/deploy/cloud-run", () => ({
  loadServiceAccountKey: async () => ({ client_email: "x", private_key: "y", token_uri: "z" }),
  fetchAccessToken: async () => "token",
  createCloudRunDeployer: () => ({ rollbackToRevision }),
}));

const { rollbackCloudRunService } = await import("../lib/deploy/cloud-run-target");

const ready = [{ type: "Ready", state: "CONDITION_SUCCEEDED" }];

describe("rollbackCloudRunService", () => {
  beforeEach(() => {
    process.env.GCP_PROJECT_ID = "p";
    process.env.GCP_LOCATION = "us-central1";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "key.json";
    rollbackToRevision.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(service: object, revisions: object[]) {
    vi.stubGlobal("fetch", async (url: string) => {
      const body = url.includes("/revisions") ? { revisions } : service;
      return new Response(JSON.stringify(body), { status: 200 });
    });
  }

  it("sends traffic to the newest ready revision that is not serving", async () => {
    stubFetch(
      { trafficStatuses: [{ revision: "projects/p/locations/us-central1/services/app/revisions/app-00003", percent: 100 }] },
      [
        { name: "projects/p/locations/us-central1/services/app/revisions/app-00003", createTime: "2026-10-10T03:00:00Z", conditions: ready },
        { name: "projects/p/locations/us-central1/services/app/revisions/app-00002", createTime: "2026-10-10T02:00:00Z", conditions: ready },
        { name: "projects/p/locations/us-central1/services/app/revisions/app-00001", createTime: "2026-10-10T01:00:00Z", conditions: ready },
      ],
    );
    const detail = await rollbackCloudRunService("app");
    expect(rollbackToRevision).toHaveBeenCalledWith("app", "app-00002");
    expect(detail).toContain("app-00003 → app-00002");
  });

  it("skips revisions that never became ready", async () => {
    stubFetch(
      { latestReadyRevision: "projects/p/locations/us-central1/services/app/revisions/app-00003" },
      [
        { name: "projects/p/locations/us-central1/services/app/revisions/app-00003", createTime: "2026-10-10T03:00:00Z", conditions: ready },
        { name: "projects/p/locations/us-central1/services/app/revisions/app-00002", createTime: "2026-10-10T02:00:00Z", conditions: [{ type: "Ready", state: "CONDITION_FAILED" }] },
        { name: "projects/p/locations/us-central1/services/app/revisions/app-00001", createTime: "2026-10-10T01:00:00Z", conditions: ready },
      ],
    );
    await rollbackCloudRunService("app");
    expect(rollbackToRevision).toHaveBeenCalledWith("app", "app-00001");
  });

  it("fails clearly when there is nothing to go back to", async () => {
    stubFetch(
      { latestReadyRevision: "projects/p/locations/us-central1/services/app/revisions/app-00001" },
      [{ name: "projects/p/locations/us-central1/services/app/revisions/app-00001", createTime: "2026-10-10T01:00:00Z", conditions: ready }],
    );
    await expect(rollbackCloudRunService("app")).rejects.toThrow(/이전 리비전이 없습니다/);
    expect(rollbackToRevision).not.toHaveBeenCalled();
  });
});
