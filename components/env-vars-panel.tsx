"use client";

import { useEffect, useState } from "react";

type Variable = { key: string; updatedAt: string };

async function call(url: string, init?: RequestInit): Promise<Variable[]> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "환경변수 요청에 실패했습니다.");
  return data.variables;
}

type Props = {
  repository: string;
  // Called after a change, so views that depend on the variables (the database panel) can reload.
  onChange?: () => void;
};

// Variables for the on-premises app container. Values are write-only: only names come back.
export function EnvVarsPanel({ repository, onChange }: Props) {
  const [variables, setVariables] = useState<Variable[]>([]);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setFailure("");
    const query = new URLSearchParams({ repository });
    call(`/api/deploy/env-vars?${query}`, { signal: controller.signal })
      .then(setVariables)
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setFailure(caught instanceof Error ? caught.message : "환경변수를 불러오지 못했습니다.");
      });
    return () => controller.abort();
  }, [repository]);

  const run = async (request: () => Promise<Variable[]>) => {
    setBusy(true);
    setFailure("");
    try {
      setVariables(await request());
      onChange?.();
      return true;
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "환경변수 요청에 실패했습니다.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const saved = await run(() => call("/api/deploy/env-vars", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository, key: key.trim(), value }),
    }));
    if (saved) {
      setKey("");
      setValue("");
    }
  };

  const remove = (name: string) => {
    if (!confirm(`환경변수 ${name}을(를) 삭제하시겠습니까?`)) return;
    const query = new URLSearchParams({ repository, key: name });
    void run(() => call(`/api/deploy/env-vars?${query}`, { method: "DELETE" }));
  };

  return (
    <div style={{ marginTop: "20px", paddingTop: "16px", borderTop: "1px solid var(--border)" }}>
      <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-main)", marginBottom: "6px" }}>🔑 앱 환경변수</div>
      <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 10px" }}>
        API 키처럼 저장소에 넣으면 안 되는 값을 넣습니다. 값은 암호화해 저장하고 다시 보여 주지 않으며, 다음 배포부터 적용됩니다.
        외부 DB를 쓰려면 <code>DATABASE_URL</code>(MySQL은 <code>MYSQL_URL</code>, MongoDB는 <code>MONGODB_URI</code>, Redis는 <code>REDIS_URL</code>)을 넣으세요. 그 DB는 자동으로 만들지 않습니다.
      </p>
      {variables.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 10px", display: "grid", gap: "4px" }}>
          {variables.map((variable) => (
            <li key={variable.key} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
              <code>{variable.key}</code>
              <span style={{ color: "var(--text-sub)", fontSize: "12px" }}>••••••</span>
              <button type="button" className="btn-link danger" disabled={busy} onClick={() => remove(variable.key)}>삭제</button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-row">
        <div className="form-group">
          <input className="form-input" value={key} onChange={(event) => setKey(event.target.value)} placeholder="이름 (예: API_KEY)" />
        </div>
        <div className="form-group">
          <input className="form-input" type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder="값" autoComplete="off" />
        </div>
      </div>
      <button type="button" className="btn btn-secondary" disabled={busy || !key.trim()} onClick={() => void save()}>
        {busy ? "저장 중..." : "추가 / 덮어쓰기"}
      </button>
      {failure && <p style={{ fontSize: "12px", color: "#e03131", marginTop: "8px" }}>{failure}</p>}
    </div>
  );
}
