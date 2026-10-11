"use client";

import { useCallback, useEffect, useState } from "react";

// Application environment variables (API keys, settings) saved per repository and passed to the container
// on every deployment. Values are write-only: after saving, only the names are shown.
// onChange lets the database panel re-check which databases the user now connects to themselves.
export function EnvVars({ repository, onChange }: { repository: string; onChange?: () => void }) {
  const [names, setNames] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!repository) return;
    try {
      const response = await fetch(`/api/deploy/env?${new URLSearchParams({ repository })}`, { cache: "no-store" });
      const data = await response.json();
      if (response.ok) setNames(data.names);
    } catch {
      // The panel stays usable; saving will surface a real error.
    }
  }, [repository]);

  useEffect(() => {
    setNames([]);
    void load();
  }, [load]);

  const save = async (body: { text?: string; remove?: string[] }) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/deploy/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository, ...body }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `저장 실패 (${response.status})`);
      setNames(data.names);
      setText("");
      setMessage("저장했습니다. 다음 배포부터 컨테이너에 전달됩니다.");
      onChange?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="log-accordion" style={{ marginTop: 12 }}>
      <summary>환경변수 {names.length > 0 ? `(${names.length}개 저장됨)` : ""}</summary>
      <div className="form-group" style={{ marginTop: 10 }}>
        <p className="field-note">
          한 줄에 <code>KEY=값</code> 형식으로 입력합니다. 값은 암호화해 저장하고 다시 보여 주지 않습니다.
          AWS와 Azure는 Systems Manager/Run Command 기록에 값이 남을 수 있습니다.
        </p>
        <textarea
          className="form-input"
          rows={4}
          value={text}
          placeholder={"OPENAI_API_KEY=sk-...\nNODE_ENV=production"}
          onChange={(event) => setText(event.target.value)}
          style={{ fontFamily: "monospace", fontSize: 12 }}
        />
        <button type="button" className="btn btn-secondary" style={{ marginTop: 8, width: "auto" }} disabled={busy || !text.trim()} onClick={() => void save({ text })}>
          {busy ? "저장 중…" : "저장 (추가·덮어쓰기)"}
        </button>
        {names.length > 0 && (
          <ul style={{ margin: "12px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {names.map((name) => (
              <li key={name} style={{ marginBottom: 4 }}>
                <code>{name}</code> = ••••••{" "}
                <button type="button" className="btn-link" disabled={busy} onClick={() => void save({ remove: [name] })}>삭제</button>
              </li>
            ))}
          </ul>
        )}
        {message && <p className="field-note" role="status">{message}</p>}
        {error && <div className="alert-banner error" style={{ marginTop: 8 }}>⚠️ {error}</div>}
      </div>
    </details>
  );
}
