"use client";

import { useState } from "react";

type Props = {
  repository: string;
  pullNumber: number;
  htmlUrl: string;
  onMerged: () => void;
};

// Merges the SBSB setup pull request from the site, but only after the person confirmed the change.
// The server checks again (lib/pull-request-guard.ts): only SBSB's own Dockerfile + workflow pull request is accepted.
export function PrMergeConfirm({ repository, pullNumber, htmlUrl, onMerged }: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const merge = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/github/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository, pullNumber }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `머지 실패 (${response.status})`);
      onMerged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "머지에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12 }}>
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>
          <a href={`${htmlUrl}/files`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
            변경된 파일(Dockerfile, 워크플로우)
          </a>
          을 확인했고, 머지하면 첫 이미지 빌드가 시작되는 것에 동의합니다.
        </span>
      </label>
      <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }} disabled={!confirmed || busy} onClick={() => void merge()}>
        {busy ? "머지 중…" : `PR #${pullNumber} 머지하고 빌드 시작`}
      </button>
      {error && <div className="alert-banner error" style={{ marginTop: 8 }}>⚠️ {error}</div>}
    </div>
  );
}
