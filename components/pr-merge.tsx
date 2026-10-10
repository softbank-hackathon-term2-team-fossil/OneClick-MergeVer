"use client";

import { useState } from "react";
import { classifyDiffLine } from "@/lib/analysis/diff";
import type { PullRequestReviewResult } from "@/lib/types";

type Props = {
  repository: string;
  pullNumber: number;
  htmlUrl: string;
  onMerged: () => void;
};

const RISK = {
  low: { label: "위험 낮음", color: "#099268", background: "#e6fcf5" },
  medium: { label: "주의", color: "#d9480f", background: "#fff4e6" },
  high: { label: "위험 높음", color: "#c92a2a", background: "#fff5f5" },
} as const;

const DIFF_COLOR = { add: "#2b8a3e", del: "#c92a2a", hunk: "#1971c2", context: "inherit" } as const;

// Shows what the setup pull request changes (diff + AI explanation) and merges it from the site only
// after the person confirmed. The server checks again (lib/pull-request-guard.ts): only SBSB's own
// Dockerfile + workflow pull request is accepted.
export function PrMergeConfirm({ repository, pullNumber, htmlUrl, onMerged }: Props) {
  const [result, setResult] = useState<PullRequestReviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadReview = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/github/pull-request/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository, pullNumber }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `변경 내용을 불러오지 못했습니다 (${response.status})`);
      setResult(data.result as PullRequestReviewResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "변경 내용을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

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
    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      {!result && (
        <button type="button" className="btn btn-secondary" style={{ width: "auto" }} disabled={loading} onClick={() => void loadReview()}>
          {loading ? "변경 내용을 불러오고 AI가 설명을 만드는 중…" : "변경 내용 확인하기 (diff + AI 설명)"}
        </button>
      )}

      {result && (
        <div style={{ border: "1px solid var(--border, #dee2e6)", borderRadius: 8, padding: 12, fontSize: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontWeight: 700 }}>
            파일 {result.facts.fileCount}개 · +{result.facts.additions} −{result.facts.deletions}
            {result.facts.allowedFilesOnly ? " · Dockerfile과 SBSB 워크플로우만 변경됨 ✓" : ""}
          </div>
          {result.reviewError && <div style={{ color: "#d9480f" }}>AI 설명을 만들지 못했습니다. 아래 변경 내용(diff)을 직접 확인해 주세요.</div>}
          {result.review && (
            <>
              <div>{result.review.overview}</div>
              {result.review.concerns.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 18, color: "#c92a2a" }}>
                  {result.review.concerns.map((concern) => <li key={concern}>{concern}</li>)}
                </ul>
              ) : (
                <div style={{ color: "#868e96" }}>AI가 특별히 주의할 점을 찾지 못했습니다. 설명은 참고용이고, 최종 판단은 사람이 합니다.</div>
              )}
            </>
          )}
          {result.files.map((file) => {
            const info = result.review?.changes.find((change) => change.file === file.filename);
            return (
              <details key={file.filename} open={file.filename === "Dockerfile"}>
                <summary style={{ cursor: "pointer", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <code>{file.filename}</code>
                  {info && (
                    <span style={{ color: RISK[info.risk].color, background: RISK[info.risk].background, borderRadius: 4, padding: "0 6px" }}>
                      {RISK[info.risk].label}
                    </span>
                  )}
                  <span>+{file.additions} −{file.deletions}</span>
                  {info && <b>{info.title}</b>}
                </summary>
                {info && <p style={{ margin: "6px 0" }}>{info.explanation}</p>}
                <pre style={{ margin: 0, padding: 8, background: "#f8f9fa", borderRadius: 6, overflowX: "auto", fontSize: 11 }}>
                  {file.patch
                    ? file.patch.split("\n").map((line, index) => (
                        <span key={index} style={{ display: "block", color: DIFF_COLOR[classifyDiffLine(line)] }}>{line || " "}</span>
                      ))
                    : "표시할 변경 내용이 없습니다."}
                </pre>
              </details>
            );
          })}
        </div>
      )}

      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12 }}>
        <input type="checkbox" checked={confirmed} disabled={!result} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>
          변경 내용을 확인했고, 머지하면 첫 이미지 빌드가 시작되는 것에 동의합니다.{" "}
          <a href={`${htmlUrl}/files`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>GitHub에서 보기 ↗</a>
        </span>
      </label>
      <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={!confirmed || !result || busy} onClick={() => void merge()}>
        {busy ? "머지 중…" : `PR #${pullNumber} 머지하고 빌드 시작`}
      </button>
      {error && <div className="alert-banner error">⚠️ {error}</div>}
    </div>
  );
}
