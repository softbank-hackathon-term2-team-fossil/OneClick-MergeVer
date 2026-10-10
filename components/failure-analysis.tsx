"use client";

import { useState } from "react";
import type { FailureAnalysis } from "@/lib/analysis/failure";

type Props = {
  repository: string;
  kind: "build" | "deploy";
  // build: the failed GitHub Actions run. deploy: the commit that was deployed and the error shown to the user.
  runId?: number;
  tag?: string;
  error?: string;
  context?: { target?: string; port?: number; healthPath?: string };
};

// Asks the configured LLM why a build or deployment failed. Nothing is sent until the button is pressed.
export function FailureAnalysisPanel({ repository, kind, runId, tag, error, context }: Props) {
  const [analysis, setAnalysis] = useState<FailureAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  const analyze = async () => {
    setBusy(true);
    setFailure("");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository, kind, runId, tag, error, context }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "분석에 실패했습니다.");
      setAnalysis(data.analysis);
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "분석에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="analysis-box">
      {!analysis && (
        <button type="button" className="pill-btn" disabled={busy} onClick={() => void analyze()}>
          {busy ? "AI가 로그를 분석하는 중…" : "AI로 실패 원인 분석"}
        </button>
      )}
      {failure && <p className="field-note history-error">{failure}</p>}
      {analysis && (
        <>
          <strong>AI 분석</strong>
          <p>{analysis.summary}</p>
          <p><b>원인</b> {analysis.cause}</p>
          <p><b>조치</b> {analysis.suggestion}</p>
          {analysis.note && <p className="field-note">{analysis.note}</p>}
          {analysis.dockerfile && (
            <details className="log-accordion">
              <summary>AI가 제안한 Dockerfile 보기</summary>
              <pre className="log-content">{analysis.dockerfile}</pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}
