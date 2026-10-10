"use client";

import { useState } from "react";

type Instance = { id: string; name: string; state: string; shape: string; publicAddress: string | null };
type Props = { repository: string; imageTag: string; containerPort: number | "" };
type Result = { url: string; image: string };

// Same flow as "existing EC2": list the VMs of the OCI compartment, pick one and deploy the image to it.
// The VM is reached with SSH, so the key SBSB generates for the repository must be in its authorized_keys.
export function OciExistingPanel({ repository, imageTag, containerPort }: Props) {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [instanceId, setInstanceId] = useState("");
  const [username, setUsername] = useState("ubuntu");
  const [sshPort, setSshPort] = useState(22);
  const [hostPort, setHostPort] = useState(8100);
  const [setupCommand, setSetupCommand] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const selected = instances.find((item) => item.id === instanceId);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/oci/instances", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "OCI VM 목록을 불러오지 못했습니다.");
      setInstances(data.instances);
      setInstanceId(data.instances.find((item: Instance) => item.state === "RUNNING")?.id || data.instances[0]?.id || "");
      const key = await fetch(`/api/deploy/ssh-key?${new URLSearchParams({ repository })}`, { cache: "no-store" });
      const keyData = await key.json();
      if (key.ok) setSetupCommand(keyData.setupCommand);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "OCI VM 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const deploy = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (!selected?.publicAddress) throw new Error("공인 IP가 있는 VM을 선택하세요.");
      const response = await fetch("/api/deploy/on-premise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repository,
          host: selected.publicAddress,
          sshPort,
          username,
          hostPort,
          containerPort: containerPort || 8000,
          imageTag,
          saveConnection: true,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `배포 실패 (${response.status})`);
      setResult({ url: data.deployment.url, image: data.deployment.image });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "배포에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-group">
      <label className="form-label">기존 OCI VM 선택</label>
      <button type="button" className="btn btn-secondary" disabled={loading || busy} onClick={() => void load()}>
        {loading ? "VM 목록 확인 중…" : "OCI VM 목록 불러오기"}
      </button>
      {instances.length === 0 && !loading && <p className="field-note">사용 중인 OCI 구획의 VM 목록을 불러와 선택합니다.</p>}
      {instances.length > 0 && (
        <>
          <select className="form-select" style={{ marginTop: 10 }} value={instanceId} onChange={(event) => setInstanceId(event.target.value)}>
            {instances.map((item) => (
              <option key={item.id} value={item.id}>{item.name} · {item.state}{item.publicAddress ? ` · ${item.publicAddress}` : " · 공인 IP 없음"}</option>
            ))}
          </select>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 10 }}>
            <input className="form-input" value={username} placeholder="SSH 사용자(ubuntu, opc)" onChange={(event) => setUsername(event.target.value)} />
            <input className="form-input" type="number" value={sshPort} placeholder="SSH 포트" onChange={(event) => setSshPort(Number(event.target.value) || 22)} />
            <input className="form-input" type="number" value={hostPort} placeholder="외부 포트" onChange={(event) => setHostPort(Number(event.target.value) || 8100)} />
          </div>
          {setupCommand && (
            <details className="log-accordion" style={{ marginTop: 10 }}>
              <summary>VM에 인증키 등록 명령어 (처음 한 번)</summary>
              <pre className="log-content">{setupCommand}</pre>
            </details>
          )}
          <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={busy || !imageTag || !selected?.publicAddress} onClick={() => void deploy()}>
            {busy ? "배포 진행 중…" : "이 OCI VM에 배포하기"}
          </button>
          {!imageTag && <p className="field-note">위에서 배포할 이미지 버전을 먼저 불러오세요.</p>}
        </>
      )}
      {error && <div className="alert-banner error" style={{ marginTop: 16 }}>⚠️ {error}</div>}
      {result && (
        <div className="result-box">
          <div className="result-title">배포 완료</div>
          <div className="url-card">
            <div className="url-label">접속 주소 · OCI {selected?.name}</div>
            <a className="url-link" href={result.url} target="_blank" rel="noreferrer">{result.url}</a>
          </div>
        </div>
      )}
    </div>
  );
}
