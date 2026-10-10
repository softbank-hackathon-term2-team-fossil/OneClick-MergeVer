"use client";

import { useEffect, useState } from "react";
import { FailureAnalysisPanel } from "@/components/failure-analysis";
import { TerraformPanel } from "@/components/terraform-panel";
import type { ImageVersion } from "@/lib/types";

type Instance = { id: string; name: string; state: string; publicAddress: string | null };
type Event = { phase: string; message: string; image?: string; url?: string; instanceId?: string; dockerfile?: string };
type Props = { repository: string; branch: string; onDeployed?: () => void };

type Provider = "aws" | "azure" | "cloud-run" | "oci";
const PROVIDER_LABEL = { aws: "AWS", azure: "Azure", "cloud-run": "Cloud Run", oci: "OCI" } as const;
const SERVER_LABEL = { aws: "EC2", azure: "VM", "cloud-run": "서비스", oci: "VM" } as const;
const DEFAULT_REGION = { aws: "ap-northeast-2", azure: "koreacentral", "cloud-run": "", oci: "" } as const;

// Cloud deployment panel: GitHub build or ZIP upload → Docker Hub → AWS EC2, Azure VM, or Cloud Run.
export function Deployment({ repository, branch, onDeployed }: Props) {
  const [provider, setProvider] = useState<Provider>("aws");
  const [source, setSource] = useState<"github" | "zip">("github");
  const [target, setTarget] = useState<"new" | "existing">("existing");
  const [file, setFile] = useState<File | null>(null);
  const [versions, setVersions] = useState<ImageVersion[]>([]);
  const [imageTag, setImageTag] = useState("");
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [instanceId, setInstanceId] = useState("");
  const [region, setRegion] = useState("ap-northeast-2");
  const [verifiedRegion, setVerifiedRegion] = useState("");
  const [azureVmSize, setAzureVmSize] = useState("Standard_B2ls_v2");
  const [checkingCloud, setCheckingCloud] = useState(true);
  const [cloudError, setCloudError] = useState("");
  const [containerPort, setContainerPort] = useState<number | "">("");
  const [healthPath, setHealthPath] = useState("/");
  const [events, setEvents] = useState<Event[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const complete = [...events].reverse().find((event) => event.phase === "complete");
  const dockerfile = [...events].reverse().find((event) => event.dockerfile)?.dockerfile;
  const deployed = [...events].reverse().find((event) => event.phase === "deploy" && event.instanceId);
  const selectedVersion = versions.find((version) => version.tag === imageTag);
  const verifyInstanceId = target === "existing" ? instanceId : deployed?.instanceId || "";
  const noAzureVms = provider === "azure" && target === "existing" && verifiedRegion === region && instances.length === 0;
  const cloud = PROVIDER_LABEL[provider];
  const server = SERVER_LABEL[provider];
  // Cloud Run is serverless: there is no machine to choose and its region is fixed on the site server.
  const serverless = provider === "cloud-run";

  const changeProvider = (next: Provider) => {
    setProvider(next);
    setRegion(DEFAULT_REGION[next]);
    setVerifiedRegion("");
    setInstances([]);
    setInstanceId("");
    setEvents([]);
    setError("");
  };

  useEffect(() => {
    setVersions([]);
    setImageTag("");
  }, [repository, branch]);

  useEffect(() => {
    const controller = new AbortController();
    setCloudError("");
    setVerifiedRegion("");
    setInstances([]);
    setInstanceId("");
    // OCI is provisioned with Terraform on the site server, so there is no instance list to check.
    if (provider === "oci") {
      setCheckingCloud(false);
      return;
    }
    setCheckingCloud(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ region });
        const response = await fetch(`/api/${provider}/instances?${params}`, { signal: controller.signal, cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "클라우드를 사용할 수 없습니다.");
        setInstances(data.instances);
        setInstanceId(data.instances[0]?.id || "");
        setVerifiedRegion(data.region);
        if (provider === "cloud-run") setRegion(data.region);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setCloudError(caught instanceof Error ? caught.message : "클라우드를 사용할 수 없습니다.");
      } finally {
        if (!controller.signal.aborted) setCheckingCloud(false);
      }
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [provider, region]);

  const loadVersions = async () => {
    setVersionsLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ repository, branch });
      const response = await fetch(`/api/github/image-versions?${query}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "이미지 버전을 불러오지 못했습니다.");
      setVersions(data.versions);
      setImageTag(data.versions[0]?.tag || "");
    } catch (caught) {
      setVersions([]);
      setImageTag("");
      setError(caught instanceof Error ? caught.message : "이미지 버전을 불러오지 못했습니다.");
    } finally {
      setVersionsLoading(false);
    }
  };

  const deploy = async () => {
    setBusy(true);
    setError("");
    setEvents([]);
    try {
      if (source === "github" && !containerPort) throw new Error("앱이 사용하는 컨테이너 내부 포트를 입력하세요.");
      const headers: Record<string, string> = {};
      let body: BodyInit;
      if (source === "zip") {
        if (!file) throw new Error("ZIP 파일을 선택하세요.");
        const form = new FormData();
        form.set("source", "zip");
        if (serverless) {
          form.set("healthPath", healthPath);
        } else {
          form.set("region", region);
          if (provider === "azure" && target === "new") form.set("vmSize", azureVmSize);
          form.set("mode", target);
          form.set("instanceId", instanceId);
        }
        if (containerPort) form.set("containerPort", String(containerPort));
        form.set("file", file);
        body = form;
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(serverless
          ? { source: "github", repository, branch, imageTag, containerPort, healthPath }
          : { source: "github", repository, branch, imageTag, region, mode: target, instanceId, containerPort, ...(provider === "azure" && target === "new" ? { vmSize: azureVmSize } : {}) });
      }
      const response = await fetch(`/api/${provider}/deploy`, { method: "POST", headers, body });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `배포 요청 실패 (${response.status})`);
      }
      if (!response.body) throw new Error("배포 진행 상태를 받을 수 없습니다.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line) as Event;
          setEvents((current) => [...current, event]);
          if (event.phase === "error") setError(event.message);
        }
        if (done) break;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "배포에 실패했습니다.");
    } finally {
      setBusy(false);
      onDeployed?.();
    }
  };

  const verifyDeployment = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/${provider}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region, instanceId: verifyInstanceId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "접속 확인에 실패했습니다.");
      setEvents((current) => [
        ...current.filter((event) => event.phase !== "error"),
        { phase: "complete", message: `접속 확인 완료 (HTTP ${data.status})`, url: data.url, instanceId: data.instanceId },
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "접속 확인에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const cloudStatus = checkingCloud
    ? `${cloud} 사용 가능 여부 확인 중…`
    : verifiedRegion === region
      ? `${cloud} 사용 가능 · ${region}`
      : `${cloud} 사용 불가${cloudError ? ` · ${cloudError}` : ""}`;
  const steps = events.filter((event) => event.phase !== "error");
  const canDeploy = !busy && !checkingCloud && verifiedRegion === region
    && (serverless || target === "new" || Boolean(instanceId))
    && (source === "zip" ? Boolean(file) : Boolean(repository && branch && imageTag && containerPort));

  return (
    <div className="card">
      <h3 className="card-title">클라우드 서버에 배포하기</h3>
      <p className="card-desc">Docker Hub의 같은 이미지를 AWS EC2, Azure VM, Cloud Run에 배포하고, OCI는 Terraform으로 서버와 DB를 만듭니다.</p>

      <div className="form-group">
        <label className="form-label">배포할 소스</label>
        <div className="seg-row" role="tablist" aria-label="배포 소스">
          <button type="button" role="tab" aria-selected={source === "github"} className={`seg-btn ${source === "github" ? "active" : ""}`} onClick={() => setSource("github")}>GitHub 빌드</button>
          <button type="button" role="tab" aria-selected={source === "zip"} className={`seg-btn ${source === "zip" ? "active" : ""}`} onClick={() => setSource("zip")}>ZIP 업로드</button>
        </div>
      </div>

      {source === "github" ? (
        <div className="form-group">
          <p className="field-note">{repository} · {branch || "브랜치 확인 중"}</p>
          <button type="button" className="btn btn-secondary" disabled={!repository || !branch || versionsLoading || busy} onClick={() => void loadVersions()}>
            {versionsLoading ? "버전 확인 중…" : "배포 가능한 버전 불러오기"}
          </button>
          {versions.length > 0 ? (
            <>
              <label className="form-label" style={{ marginTop: 12 }}>배포할 버전</label>
              <select className="form-select" value={imageTag} onChange={(event) => setImageTag(event.target.value)}>
                {versions.map((version) => (
                  <option key={version.tag} value={version.tag}>{version.tag.slice(0, 12)} · {new Date(version.publishedAt).toLocaleString("ko-KR")}</option>
                ))}
              </select>
              {selectedVersion && <p className="field-note mono">{selectedVersion.image}</p>}
            </>
          ) : (
            <p className="field-note">빌드가 성공해 Docker Hub에 이미지가 올라간 커밋만 목록에 나옵니다.</p>
          )}
        </div>
      ) : (
        <div className="form-group">
          <label className="form-label">웹앱 ZIP 파일 (최대 25MB)</label>
          <input className="form-input file-input" type="file" accept=".zip,application/zip" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          <p className="field-note">AI가 Dockerfile을 만들고, 이 서버의 Docker로 빌드해 Docker Hub에 올립니다.</p>
        </div>
      )}

      <div className="form-group">
        <label className="form-label">클라우드</label>
        <div className="seg-row" style={{ gridTemplateColumns: "repeat(4, 1fr)" }} role="tablist" aria-label="배포할 클라우드">
          <button type="button" role="tab" aria-selected={provider === "aws"} className={`seg-btn ${provider === "aws" ? "active" : ""}`} onClick={() => changeProvider("aws")}>AWS EC2</button>
          <button type="button" role="tab" aria-selected={provider === "azure"} className={`seg-btn ${provider === "azure" ? "active" : ""}`} onClick={() => changeProvider("azure")}>Azure VM</button>
          <button type="button" role="tab" aria-selected={provider === "cloud-run"} className={`seg-btn ${provider === "cloud-run" ? "active" : ""}`} onClick={() => changeProvider("cloud-run")}>Cloud Run</button>
          <button type="button" role="tab" aria-selected={provider === "oci"} className={`seg-btn ${provider === "oci" ? "active" : ""}`} onClick={() => changeProvider("oci")}>OCI</button>
        </div>
      </div>

      {provider !== "oci" && (
      <>
      <div className="form-group">
        <label className="form-label">{cloud} 리전</label>
        <input className="form-input" type="text" value={region} readOnly={serverless} placeholder={serverless ? "서버 설정에서 읽는 중" : DEFAULT_REGION[provider]}
          onChange={(event) => { setRegion(event.target.value); setVerifiedRegion(""); setInstances([]); setInstanceId(""); }} />
        <p className="field-note" role="status">{cloudStatus}</p>
      </div>

      {serverless ? (
        <div className="form-group">
          <label className="form-label">헬스체크 경로</label>
          <input className="form-input" type="text" value={healthPath} placeholder="/" onChange={(event) => setHealthPath(event.target.value)} />
          <p className="field-note">서버 없이 실행되고 요청에 따라 0~N개로 자동 확장됩니다. 새 버전이 이 경로에 응답하지 않으면 이전 버전으로 트래픽을 되돌립니다. /healthz는 Cloud Run이 가로채므로 쓸 수 없습니다.</p>
        </div>
      ) : (
      <div className="form-group">
        <label className="form-label">서버</label>
        <div className="seg-row" role="tablist" aria-label="배포 서버">
          <button type="button" role="tab" aria-selected={target === "existing"} className={`seg-btn ${target === "existing" ? "active" : ""}`} onClick={() => setTarget("existing")}>기존 {server} 선택</button>
          <button type="button" role="tab" aria-selected={target === "new"} className={`seg-btn ${target === "new" ? "active" : ""}`} onClick={() => setTarget("new")}>새 {server} 생성</button>
        </div>
        {target === "existing" ? (
          <>
            <select className="form-select" style={{ marginTop: 10 }} value={instanceId} onChange={(event) => setInstanceId(event.target.value)} disabled={!instances.length}>
              {!instances.length && <option value="">{checkingCloud ? "서버 목록을 확인하는 중" : verifiedRegion === region ? "사용 가능한 서버가 없습니다" : "클라우드를 사용할 수 없습니다"}</option>}
              {instances.map((item) => (
                <option key={item.id} value={item.id}>{item.name}{item.id !== item.name ? ` · ${item.id}` : ""} · {item.state}{item.publicAddress ? ` · ${item.publicAddress}` : ""}</option>
              ))}
            </select>
            {noAzureVms && <p className="field-note">이 리전에 사용 가능한 Linux VM이 없습니다. 새 VM 생성을 선택하세요.</p>}
          </>
        ) : provider === "azure" ? (
          <>
            <select className="form-select" style={{ marginTop: 10 }} value={azureVmSize} onChange={(event) => setAzureVmSize(event.target.value)}>
              <option value="Standard_B2ls_v2">B2ls v2 · 2 vCPU · 4GB</option>
              <option value="Standard_B2als_v2">B2als v2 · 2 vCPU · 4GB</option>
              <option value="Standard_B2s_v2">B2s v2 · 2 vCPU · 8GB</option>
              <option value="Standard_B2as_v2">B2as v2 · 2 vCPU · 8GB</option>
              <option value="Standard_B2ms">B2ms · 2 vCPU · 8GB</option>
            </select>
            <p className="field-note">Ubuntu VM을 만들고 HTTP 80 포트를 엽니다. Azure 요금이 발생합니다.</p>
          </>
        ) : (
          <p className="field-note">기본 VPC에 새 EC2를 만들고 HTTP 80 포트를 엽니다. AWS 요금이 발생합니다.</p>
        )}
      </div>
      )}
      </>
      )}

      <div className="form-group">
        <label className="form-label">컨테이너 내부 포트 (Dockerfile의 EXPOSE 값)</label>
        <input className="form-input" type="number" min="1" max="65535" value={containerPort} placeholder={source === "zip" ? "비워 두면 Dockerfile에서 읽습니다" : "예: 8000"}
          onChange={(event) => setContainerPort(event.target.value ? Number(event.target.value) : "")} />
      </div>

      {provider === "oci" ? (
        <TerraformPanel image={source === "github" ? selectedVersion?.image ?? "" : ""} containerPort={containerPort} />
      ) : (
        <>
          <button type="button" className="btn btn-primary" disabled={!canDeploy} onClick={() => void deploy()}>
            {busy ? "배포 진행 중…" : `${cloud} ${server}에 배포하기`}
          </button>
          {!serverless && (
            <button type="button" className="btn btn-secondary" style={{ marginTop: 10 }} disabled={busy || !verifyInstanceId || verifiedRegion !== region} onClick={() => void verifyDeployment()}>
              현재 {server} 접속 확인
            </button>
          )}
        </>
      )}

      {error && <div className="alert-banner error" style={{ marginTop: 16 }}>⚠️ {error}</div>}
      {error && !busy && events.length > 0 && (
        <FailureAnalysisPanel
          key={error}
          repository={repository}
          kind="deploy"
          tag={source === "github" ? imageTag : undefined}
          error={[error, ...events.filter((event) => event.phase === "log").map((event) => event.message)].join("\n").slice(0, 8_000)}
          context={{ target: cloud, port: containerPort || undefined, healthPath: serverless ? healthPath : undefined }}
        />
      )}

      {steps.length > 0 && (
        <div className="progress-steps" aria-live="polite">
          {steps.map((event, index) => (
            <div className="step-item" key={`${event.phase}-${index}`}>
              {busy && index === steps.length - 1 ? <span className="step-loading" /> : <span className="step-check">✓</span>}
              <span>{event.message}</span>
            </div>
          ))}
        </div>
      )}

      {dockerfile && (
        <details className="log-accordion">
          <summary>ZIP용으로 생성한 Dockerfile 보기</summary>
          <pre className="log-content">{dockerfile}</pre>
        </details>
      )}

      {complete?.url && (
        <div className="result-box">
          <div className="result-title">배포 완료</div>
          <div className="url-card">
            <div className="url-label">접속 주소 · {cloud} {server} {complete.instanceId}</div>
            <a className="url-link" href={complete.url} target="_blank" rel="noreferrer">{complete.url}</a>
          </div>
        </div>
      )}
    </div>
  );
}
