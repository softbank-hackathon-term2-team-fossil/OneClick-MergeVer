"use client";

import { useCallback, useEffect, useState } from "react";

type Snapshot = {
  key: string;
  target: string;
  url: string;
  intervalSec: number;
  threshold: number;
  autoRollback: boolean;
  state: "healthy" | "degraded" | "rolled-back" | "rollback-failed" | "stopped";
  consecutiveFailures: number;
  checks: number;
  lastCheckedAt: string | null;
  lastStatus: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  events: { at: string; message: string }[];
};

const TARGETS = [
  { id: "ONPREM", label: "온프레미스" },
  { id: "CLOUD_RUN", label: "Cloud Run" },
] as const;

const STATE = {
  healthy: { label: "정상", color: "#099268", background: "#e6fcf5" },
  degraded: { label: "응답 이상", color: "#d9480f", background: "#fff4e6" },
  "rolled-back": { label: "자동 롤백됨", color: "#1971c2", background: "#e7f5ff" },
  "rollback-failed": { label: "롤백 실패", color: "#c92a2a", background: "#fff5f5" },
  stopped: { label: "중지됨", color: "#868e96", background: "#f1f3f5" },
} as const;

// Watches the serving deployment of a target and rolls back to the previous version when it stops answering.
export function HealthMonitor({ repository }: { repository: string }) {
  const [monitors, setMonitors] = useState<Snapshot[]>([]);
  const [intervalSec, setIntervalSec] = useState(30);
  const [threshold, setThreshold] = useState(3);
  const [autoRollback, setAutoRollback] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/monitor?${new URLSearchParams({ repository })}`, { cache: "no-store" });
      const data = await response.json();
      if (response.ok) setMonitors(data.monitors);
    } catch {
      // Keep the last known state.
    }
  }, [repository]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (target: string, action: "start" | "stop" | "check") => {
    setBusy(`${target}:${action}`);
    setError("");
    try {
      const response = await fetch("/api/monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository, target, action, intervalSec, threshold, autoRollback }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `요청 실패 (${response.status})`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "요청에 실패했습니다.");
    } finally {
      setBusy("");
    }
  };

  return (
    <details className="log-accordion" style={{ marginTop: 12 }} open={monitors.length > 0}>
      <summary>상태 모니터링 · 자동 롤백</summary>
      <div className="form-group" style={{ marginTop: 10 }}>
        <p className="field-note">현재 서비스 중인 배포의 주소를 주기적으로 확인하고, 연속으로 실패하면 이전 성공 버전으로 되돌립니다.</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <label className="field-note">확인 주기(초)
            <input className="form-input" type="number" min={5} max={600} value={intervalSec} onChange={(event) => setIntervalSec(Number(event.target.value) || 30)} />
          </label>
          <label className="field-note">연속 실패 횟수
            <input className="form-input" type="number" min={1} max={20} value={threshold} onChange={(event) => setThreshold(Number(event.target.value) || 3)} />
          </label>
        </div>
        <label className="field-note" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <input type="checkbox" checked={autoRollback} onChange={(event) => setAutoRollback(event.target.checked)} />
          장애가 확인되면 자동으로 이전 버전으로 롤백
        </label>

        {TARGETS.map((target) => {
          const monitor = monitors.find((item) => item.target === target.id);
          const running = monitor && monitor.state !== "stopped";
          return (
            <div key={target.id} style={{ marginTop: 12, border: "1px solid var(--border, #dee2e6)", borderRadius: 8, padding: 10, fontSize: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <b>{target.label}</b>
                {monitor && (
                  <span style={{ color: STATE[monitor.state].color, background: STATE[monitor.state].background, borderRadius: 4, padding: "0 6px" }}>
                    {STATE[monitor.state].label}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <button type="button" className="btn btn-secondary" style={{ width: "auto" }} disabled={Boolean(busy)} onClick={() => void act(target.id, "start")}>
                  {running ? "다시 시작" : "모니터링 시작"}
                </button>
                {running && (
                  <>
                    <button type="button" className="btn btn-secondary" style={{ width: "auto" }} disabled={Boolean(busy)} onClick={() => void act(target.id, "check")}>지금 확인</button>
                    <button type="button" className="btn btn-secondary" style={{ width: "auto" }} disabled={Boolean(busy)} onClick={() => void act(target.id, "stop")}>중지</button>
                  </>
                )}
              </div>
              {monitor && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ wordBreak: "break-all" }}>{monitor.url}</div>
                  <div style={{ color: "#868e96" }}>
                    확인 {monitor.checks}회 · 연속 실패 {monitor.consecutiveFailures}/{monitor.threshold}
                    {monitor.lastStatus !== null ? ` · HTTP ${monitor.lastStatus}` : ""}
                    {monitor.lastLatencyMs !== null ? ` · ${monitor.lastLatencyMs}ms` : ""}
                    {monitor.lastError ? ` · ${monitor.lastError}` : ""}
                  </div>
                  {monitor.events.length > 0 && (
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                      {monitor.events.slice(0, 5).map((event) => (
                        <li key={event.at + event.message}>{new Date(event.at).toLocaleTimeString("ko-KR")} · {event.message}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {error && <div className="alert-banner error" style={{ marginTop: 8 }}>⚠️ {error}</div>}
      </div>
    </details>
  );
}
