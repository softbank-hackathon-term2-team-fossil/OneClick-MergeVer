"use client";

import { useState } from "react";

type Result = { domain: string; httpUrl: string; httpsUrl: string | null; certificate: "issued" | "failed"; note: string | null };

// Connects a custom domain (nginx + HTTPS) to the app on the saved server.
export function DomainConnect({ repository }: { repository: string }) {
  const [domain, setDomain] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const connect = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/deploy/domain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository, domain, email: email || undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `도메인 연결 실패 (${response.status})`);
      setResult(data as Result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "도메인 연결에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="log-accordion" style={{ marginTop: 12 }}>
      <summary>내 도메인 연결 (nginx + HTTPS)</summary>
      <div className="form-group" style={{ marginTop: 10 }}>
        <p className="field-note">도메인의 A 레코드를 서버 IP로 지정한 뒤 입력하세요. 서버에 nginx와 Let&apos;s Encrypt 인증서를 설정합니다.</p>
        <input className="form-input" type="text" value={domain} placeholder="app.example.com" onChange={(event) => setDomain(event.target.value)} />
        <input className="form-input" style={{ marginTop: 8 }} type="email" value={email} placeholder="인증서 알림 이메일 (선택)" onChange={(event) => setEmail(event.target.value)} />
        <button type="button" className="btn btn-secondary" style={{ marginTop: 10, width: "auto" }} disabled={busy || domain.trim().length < 3} onClick={() => void connect()}>
          {busy ? "도메인 연결 중… (수 분)" : "도메인 연결하기"}
        </button>
        {error && <div className="alert-banner error" style={{ marginTop: 12 }}>⚠️ {error}</div>}
        {result && (
          <div className="result-box">
            <div className="result-title">{result.httpsUrl ? "도메인 연결 완료" : "HTTP 연결 완료 (인증서 실패)"}</div>
            <div className="url-card">
              <a className="url-link" href={result.httpsUrl ?? result.httpUrl} target="_blank" rel="noreferrer">{result.httpsUrl ?? result.httpUrl}</a>
            </div>
            {result.note && <p className="field-note">{result.note}</p>}
          </div>
        )}
      </div>
    </details>
  );
}
