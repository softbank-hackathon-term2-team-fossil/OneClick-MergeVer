import { describe, expect, it, vi } from "vitest";
import { decide, HealthMonitor, httpCheck, MonitorRegistry, type CheckResult, type MonitorConfig } from "../lib/health-monitor";

const ok: CheckResult = { ok: true, status: 200, latencyMs: 12, error: null };
const down: CheckResult = { ok: false, status: 502, latencyMs: 30, error: "HTTP 502" };
const config: MonitorConfig = {
  key: "o/r#ONPREM",
  repository: "o/r",
  target: "ONPREM",
  url: "https://app.example.com",
  intervalSec: 30,
  threshold: 3,
  autoRollback: true,
  installationId: 42,
};

describe("decide", () => {
  it("stays healthy while checks pass and resets the failure count", () => {
    expect(decide({ failures: 2, state: "degraded" }, true, 3, true)).toEqual({ failures: 0, state: "healthy", rollback: false });
  });

  it("rolls back only when the threshold is reached with auto rollback on", () => {
    expect(decide({ failures: 0, state: "healthy" }, false, 3, true)).toEqual({ failures: 1, state: "degraded", rollback: false });
    expect(decide({ failures: 1, state: "degraded" }, false, 3, true)).toEqual({ failures: 2, state: "degraded", rollback: false });
    expect(decide({ failures: 2, state: "degraded" }, false, 3, true)).toEqual({ failures: 3, state: "degraded", rollback: true });
    expect(decide({ failures: 2, state: "degraded" }, false, 3, false).rollback).toBe(false);
  });

  it("does not roll back again after a rollback (no flapping)", () => {
    expect(decide({ failures: 0, state: "rolled-back" }, false, 1, true).rollback).toBe(false);
    expect(decide({ failures: 0, state: "rollback-failed" }, false, 1, true).rollback).toBe(false);
  });
});

describe("httpCheck", () => {
  it("treats responses below 500 as alive and 5xx or network errors as failures", async () => {
    expect((await httpCheck("http://x", async () => new Response("", { status: 404 }))).ok).toBe(true);
    expect((await httpCheck("http://x", async () => new Response("", { status: 503 }))).ok).toBe(false);
    const failed = await httpCheck("http://x", async () => { throw new Error("connect ECONNREFUSED"); });
    expect(failed).toMatchObject({ ok: false, status: null });
    expect(failed.error).toContain("ECONNREFUSED");
  });
});

describe("HealthMonitor", () => {
  it("rolls back after three consecutive failures and then stays quiet", async () => {
    const results = [ok, down, down, down, down, down];
    const check = vi.fn(async () => results.shift() ?? down);
    const rollback = vi.fn(async () => "#3 → #2");
    const monitor = new HealthMonitor(config, { check, rollback });

    await monitor.tick(); // ok
    await monitor.tick(); // 1
    await monitor.tick(); // 2
    expect(rollback).not.toHaveBeenCalled();
    const snapshot = await monitor.tick(); // 3 -> rollback
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledWith(expect.objectContaining({ installationId: 42, target: "ONPREM" }));
    expect(snapshot.state).toBe("rolled-back");
    expect(snapshot.events[0].message).toContain("자동 롤백 완료");

    await monitor.tick();
    await monitor.tick();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it("recovers without rollback when the app answers again", async () => {
    const results = [down, down, ok];
    const rollback = vi.fn(async () => "");
    const monitor = new HealthMonitor(config, { check: async () => results.shift() ?? ok, rollback });
    await monitor.tick();
    await monitor.tick();
    expect((await monitor.tick()).state).toBe("healthy");
    expect(rollback).not.toHaveBeenCalled();
  });

  it("records a failed rollback", async () => {
    const monitor = new HealthMonitor({ ...config, threshold: 1 }, { check: async () => down, rollback: async () => { throw new Error("no previous deployment"); } });
    const snapshot = await monitor.tick();
    expect(snapshot.state).toBe("rollback-failed");
    expect(snapshot.events[0].message).toContain("no previous deployment");
  });

  it("only reports (no rollback) when auto rollback is off", async () => {
    const rollback = vi.fn(async () => "");
    const monitor = new HealthMonitor({ ...config, threshold: 2, autoRollback: false }, { check: async () => down, rollback });
    await monitor.tick();
    const snapshot = await monitor.tick();
    expect(rollback).not.toHaveBeenCalled();
    expect(snapshot.state).toBe("degraded");
  });

  it("does not expose the installation id in snapshots", async () => {
    const monitor = new HealthMonitor(config, { check: async () => ok, rollback: async () => "" });
    expect(JSON.stringify(await monitor.tick())).not.toContain("installationId");
  });
});

describe("MonitorRegistry", () => {
  it("lists monitors per repository and replaces a running monitor on start", async () => {
    vi.useFakeTimers();
    const registry = new MonitorRegistry({ check: async () => ok, rollback: async () => "" });
    registry.start(config);
    registry.start({ ...config, key: "other#ONPREM", repository: "other" });
    expect(registry.list("o/r")).toHaveLength(1);
    registry.start({ ...config, threshold: 5 });
    expect(registry.list("o/r")).toHaveLength(1);
    expect(registry.list("o/r")[0].threshold).toBe(5);
    expect(registry.stop(config.key)?.state).toBe("stopped");
    vi.useRealTimers();
  });
});
