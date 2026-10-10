// Health monitoring with automatic rollback. The decision logic is pure and the registry takes its
// side effects (HTTP check, rollback) as functions, so everything is unit tested without a network.

export type MonitorState = "healthy" | "degraded" | "rolled-back" | "rollback-failed" | "stopped";

export type MonitorEvent = { at: string; message: string };

export type MonitorSnapshot = {
  key: string;
  repository: string;
  target: string;
  url: string;
  intervalSec: number;
  threshold: number;
  autoRollback: boolean;
  state: MonitorState;
  consecutiveFailures: number;
  checks: number;
  lastCheckedAt: string | null;
  lastStatus: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  events: MonitorEvent[];
};

export type CheckResult = { ok: boolean; status: number | null; latencyMs: number; error: string | null };

export type Decision = { failures: number; state: MonitorState; rollback: boolean };

// healthy -> degraded after the first failure -> rollback once `threshold` failures happen in a row.
// After a rollback the monitor stays in "rolled-back" (no flapping) until it is started again.
export function decide(previous: { failures: number; state: MonitorState }, ok: boolean, threshold: number, autoRollback: boolean): Decision {
  if (previous.state === "rolled-back" || previous.state === "rollback-failed") {
    return { failures: ok ? 0 : previous.failures + 1, state: previous.state, rollback: false };
  }
  if (ok) return { failures: 0, state: "healthy", rollback: false };
  const failures = previous.failures + 1;
  if (failures >= threshold) return { failures, state: "degraded", rollback: autoRollback };
  return { failures, state: "degraded", rollback: false };
}

export async function httpCheck(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): Promise<CheckResult> {
  const started = Date.now();
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store", redirect: "manual" });
    // Anything below 500 means the app answered; a 404 on "/" is still a live app.
    return { ok: response.status < 500, status: response.status, latencyMs: Date.now() - started, error: response.status < 500 ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, status: null, latencyMs: Date.now() - started, error: error instanceof Error ? error.message.slice(0, 160) : "요청 실패" };
  }
}

export type MonitorConfig = {
  key: string;
  repository: string;
  target: string;
  url: string;
  intervalSec: number;
  threshold: number;
  autoRollback: boolean;
  // Kept on the server: needed to act on the repository, never part of a snapshot.
  installationId?: number;
};

type Dependencies = {
  check: (url: string) => Promise<CheckResult>;
  rollback: (config: MonitorConfig) => Promise<string>;
  now?: () => Date;
};

const MAX_EVENTS = 20;

export class HealthMonitor {
  private snapshotValue: MonitorSnapshot;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    readonly config: MonitorConfig,
    private readonly dependencies: Dependencies,
  ) {
    const { installationId: _installationId, ...visible } = config;
    this.snapshotValue = {
      ...visible,
      state: "healthy",
      consecutiveFailures: 0,
      checks: 0,
      lastCheckedAt: null,
      lastStatus: null,
      lastLatencyMs: null,
      lastError: null,
      events: [],
    };
  }

  get snapshot(): MonitorSnapshot {
    return { ...this.snapshotValue, events: [...this.snapshotValue.events] };
  }

  private log(message: string): void {
    const at = (this.dependencies.now?.() ?? new Date()).toISOString();
    this.snapshotValue.events = [{ at, message }, ...this.snapshotValue.events].slice(0, MAX_EVENTS);
  }

  // Runs one check and, when the threshold is reached, the rollback. Safe to call while a tick is running.
  async tick(): Promise<MonitorSnapshot> {
    if (this.busy || this.snapshotValue.state === "stopped") return this.snapshot;
    this.busy = true;
    try {
      const result = await this.dependencies.check(this.config.url);
      const previous = { failures: this.snapshotValue.consecutiveFailures, state: this.snapshotValue.state };
      const decision = decide(previous, result.ok, this.config.threshold, this.config.autoRollback);

      this.snapshotValue.checks += 1;
      this.snapshotValue.lastCheckedAt = (this.dependencies.now?.() ?? new Date()).toISOString();
      this.snapshotValue.lastStatus = result.status;
      this.snapshotValue.lastLatencyMs = result.latencyMs;
      this.snapshotValue.lastError = result.error;
      this.snapshotValue.consecutiveFailures = decision.failures;

      if (previous.state === "healthy" && decision.state === "degraded") this.log(`응답 이상 감지: ${result.error ?? "알 수 없음"}`);
      if (previous.state === "degraded" && decision.state === "healthy") this.log("응답이 정상으로 돌아왔습니다.");
      this.snapshotValue.state = decision.state;

      if (decision.rollback) {
        this.log(`연속 ${decision.failures}회 실패 — 이전 버전으로 자동 롤백을 시작합니다.`);
        try {
          const detail = await this.dependencies.rollback(this.config);
          this.snapshotValue.state = "rolled-back";
          this.snapshotValue.consecutiveFailures = 0;
          this.log(`자동 롤백 완료: ${detail}`);
        } catch (error) {
          this.snapshotValue.state = "rollback-failed";
          this.log(`자동 롤백 실패: ${error instanceof Error ? error.message.slice(0, 200) : "알 수 없는 오류"}`);
        }
      } else if (decision.failures >= this.config.threshold && !this.config.autoRollback && previous.failures < this.config.threshold) {
        this.log(`연속 ${decision.failures}회 실패 (자동 롤백 꺼짐)`);
      }
      return this.snapshot;
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.log("모니터링을 시작했습니다.");
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalSec * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.snapshotValue.state = "stopped";
    this.log("모니터링을 중지했습니다.");
  }
}

export class MonitorRegistry {
  private readonly monitors = new Map<string, HealthMonitor>();

  constructor(private readonly dependencies: Dependencies) {}

  start(config: MonitorConfig): MonitorSnapshot {
    this.monitors.get(config.key)?.stop();
    const monitor = new HealthMonitor(config, this.dependencies);
    this.monitors.set(config.key, monitor);
    monitor.start();
    return monitor.snapshot;
  }

  stop(key: string): MonitorSnapshot | null {
    const monitor = this.monitors.get(key);
    if (!monitor) return null;
    monitor.stop();
    return monitor.snapshot;
  }

  async checkNow(key: string): Promise<MonitorSnapshot | null> {
    return (await this.monitors.get(key)?.tick()) ?? null;
  }

  list(repository: string): MonitorSnapshot[] {
    return [...this.monitors.values()].map((monitor) => monitor.snapshot).filter((snapshot) => snapshot.repository === repository);
  }
}
