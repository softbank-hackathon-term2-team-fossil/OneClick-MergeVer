"use client";

import { useState } from "react";

type Target = "oci" | "gcp";
type Action = "plan" | "apply" | "destroy";
type Result = { log: string; outputs: Record<string, unknown> };
type Props = { image: string; containerPort: number | "" };

const LABEL = { oci: "OCI · VM + PostgreSQL", gcp: "GCP · VM + Cloud SQL" } as const;
const ACTION_LABEL = { plan: "계획 보기", apply: "생성", destroy: "삭제" } as const;

// Terraform-driven provisioning: one VM running the selected image plus a managed PostgreSQL.
export function TerraformPanel({ image, containerPort }: Props) {
  const [target, setTarget] = useState<Target>("oci");
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<(Result & { action: Action }) | null>(null);
  const appUrl = typeof result?.outputs.app_url === "string" ? result.outputs.app_url : "";

  const execute = async (action: Action) => {
    if (action === "destroy" && !window.confirm("만든 VM과 데이터베이스를 모두 삭제합니다. 계속할까요?")) return;
    setBusy(action);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/terraform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: target, action, image, port: containerPort || 8000 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `요청 실패 (${response.status})`);
      setResult({ ...(data as Result), action });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Terraform 실행에 실패했습니다.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="form-group">
      <label className="form-label">Terraform으로 서버와 데이터베이스 만들기</label>
      <div className="seg-row" role="tablist" aria-label="Terraform 대상">
        {(Object.keys(LABEL) as Target[]).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={target === key} className={`seg-btn ${target === key ? "active" : ""}`} disabled={Boolean(busy)} onClick={() => { setTarget(key); setResult(null); setError(""); }}>
            {LABEL[key]}
          </button>
        ))}
      </div>
      <p className="field-note">
        {image ? <>선택한 이미지를 VM에서 실행하고 <code>DATABASE_URL</code>로 DB를 연결합니다. <span className="mono">{image}</span></> : "이미지를 고르지 않으면 VM과 DB만 만듭니다."}
        {" "}클라우드 요금이 발생하며, 생성에는 수 분~십수 분이 걸립니다.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        {(Object.keys(ACTION_LABEL) as Action[]).map((action) => (
          <button key={action} type="button" className={action === "apply" ? "btn btn-primary" : "btn btn-secondary"} disabled={Boolean(busy)} onClick={() => void execute(action)}>
            {busy === action ? `${ACTION_LABEL[action]} 진행 중…` : ACTION_LABEL[action]}
          </button>
        ))}
      </div>

      {error && <div className="alert-banner error" style={{ marginTop: 16 }}>⚠️ {error}</div>}

      {result && (
        <div className="result-box">
          <div className="result-title">Terraform {ACTION_LABEL[result.action]} 완료</div>
          {appUrl && (
            <div className="url-card">
              <div className="url-label">접속 주소</div>
              <a className="url-link" href={appUrl} target="_blank" rel="noreferrer">{appUrl}</a>
            </div>
          )}
          {Object.keys(result.outputs).length > 0 && (
            <pre className="log-content">{JSON.stringify(result.outputs, null, 2)}</pre>
          )}
          <details className="log-accordion">
            <summary>실행 로그</summary>
            <pre className="log-content">{result.log}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
