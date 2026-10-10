"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpecDraft } from "@/lib/infra/ai";
import type { PlanAction } from "@/lib/infra/plan-summary";
import type { InfraStatus, RepairRound, SavedPlan } from "@/lib/infra/provision";
import { CLOUD_LABEL, CLOUD_SERVICES, CLOUDS, defaultSpec, servicesFor, supportsVm, type Cloud, type InfraSpec } from "@/lib/infra/spec";
import type { ImageVersion } from "@/lib/types";

type Props = { repository: string; branch: string; onDeployed?: () => void };
type Status = InfraStatus & { terraform: string | null };
type PlanFailure = { message: string; rounds: RepairRound[]; action: string };

const ACTION_LABEL: Record<PlanAction, string> = { create: "생성", update: "변경", replace: "교체", delete: "삭제" };
const SPEC_FIELD_LABEL: Record<string, string> = { port: "포트", healthPath: "헬스 체크 경로", minInstances: "최소 개수", maxInstances: "최대 개수", database: "DB", env: "환경변수", secretNames: "비밀 환경변수" };

function envToText(env: Record<string, string>): string {
  return Object.entries(env).map(([name, value]) => `${name}=${value}`).join("\n");
}

function textToEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) env[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return env;
}

function describePatch(patch: Partial<InfraSpec>): string {
  return Object.entries(patch).map(([field, value]) => `${SPEC_FIELD_LABEL[field] ?? field} → ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(", ");
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `요청 실패 (${response.status})`), { detail: data.detail });
  return data as T;
}

// Terraform-based provisioning: the AI drafts a spec, fixed templates turn it into a web
// service + managed database + secret store, and nothing is created until a person approves the plan.
export function InfraProvision({ repository, branch, onDeployed }: Props) {
  const [cloud, setCloud] = useState<Cloud>("gcp");
  const [status, setStatus] = useState<Status | null>(null);
  const [spec, setSpec] = useState<InfraSpec>(() => defaultSpec(repository));
  const [envText, setEnvText] = useState("");
  const [secretNamesText, setSecretNamesText] = useState("");
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<SpecDraft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [editing, setEditing] = useState(false);
  // The repository and branch the AI has already read, so switching clouds does not ask again.
  const draftedFor = useRef("");
  const [versions, setVersions] = useState<ImageVersion[]>([]);
  const [imageTag, setImageTag] = useState("");
  const [plan, setPlan] = useState<SavedPlan | null>(null);
  const [planFailure, setPlanFailure] = useState<PlanFailure | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const secretNames = secretNamesText.split(/[\s,]+/).filter(Boolean);
  const job = status?.job ?? null;
  const running = job?.status === "RUNNING";
  const deployed = status?.deployed ?? null;
  const services = servicesFor(cloud, spec);

  const applySpec = (next: InfraSpec) => {
    setSpec(next);
    setEnvText(envToText(next.env));
    setSecretNamesText(next.secretNames.join(", "));
  };

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ repository, cloud });
    const response = await fetch(`/api/infra/status?${query}`, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "상태를 불러오지 못했습니다.");
    setStatus(data as Status);
    return data as Status;
  }, [repository, cloud]);

  // Switching repository or cloud starts from what is already deployed there, if anything.
  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    setPlan(null);
    setPlanFailure(null);
    setError("");
    setSecretValues({});
    loadStatus(controller.signal)
      .then((data) => {
        const existing = data.deployed?.spec ?? data.plan?.spec;
        // Specs saved by an older version may lack newer fields.
        if (existing) applySpec({ ...defaultSpec(repository), ...existing });
        setPlan(data.plan);
      })
      .catch((caught) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "상태를 불러오지 못했습니다."); });
    return () => controller.abort();
  }, [repository, cloud, loadStatus]);

  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);
  const specRef = useRef(spec);
  useEffect(() => { specRef.current = spec; }, [spec]);

  const readSource = useCallback(async () => {
    setDrafting(true);
    try {
      const data = await post<{ draft: SpecDraft }>("/api/infra/spec", { repository, branch });
      setDraft(data.draft);
      return data.draft;
    } finally {
      setDrafting(false);
    }
  }, [repository, branch]);

  // The spec is written by the AI as soon as the repository is known. A person reviews it;
  // typing is only needed to correct it or to supply secret values.
  useEffect(() => {
    const key = `${repository}@${branch}`;
    if (!repository || !branch || draftedFor.current === key) return;
    draftedFor.current = key;
    setDraft(null);
    setEditing(false);
    applySpec(defaultSpec(repository));
    readSource()
      .then((result) => {
        if (draftedFor.current !== key) return;
        // What is already deployed wins over a fresh reading of the source.
        if (!statusRef.current?.deployed && !statusRef.current?.plan) applySpec({ ...result.spec, compute: specRef.current.compute });
      })
      .catch((caught) => { if (draftedFor.current === key) setError(caught instanceof Error ? caught.message : "소스를 분석하지 못했습니다."); });
  }, [repository, branch, readSource]);

  // While Terraform runs on the server, the page only watches.
  const onDeployedRef = useRef(onDeployed);
  useEffect(() => { onDeployedRef.current = onDeployed; }, [onDeployed]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      loadStatus().then((data) => { if (data.job?.status !== "RUNNING") onDeployedRef.current?.(); }).catch(() => undefined);
    }, 4_000);
    return () => clearInterval(timer);
  }, [running, loadStatus]);

  const guard = async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "요청에 실패했습니다.");
    } finally {
      setBusy("");
    }
  };

  const redraft = () => guard("spec", async () => {
    const result = await readSource();
    applySpec({ ...result.spec, appName: spec.appName, compute: spec.compute });
    setPlan(null);
  });

  const loadVersions = () => guard("versions", async () => {
    const query = new URLSearchParams({ repository, branch });
    const response = await fetch(`/api/github/image-versions?${query}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "이미지 버전을 불러오지 못했습니다.");
    setVersions(data.versions);
    setImageTag(data.versions[0]?.tag || "");
  });

  const makePlan = () => guard("plan", async () => {
    setPlan(null);
    setPlanFailure(null);
    const body = { action: "deploy", repository, branch, cloud, imageTag, spec: { ...spec, env: textToEnv(envText), secretNames }, secretEnv: secretValues };
    try {
      const data = await post<{ plan: SavedPlan }>("/api/infra/plan", body);
      setPlan(data.plan);
      // The verifier may have corrected the spec; the form shows what will actually be applied.
      applySpec(data.plan.spec);
    } catch (caught) {
      const detail = (caught as { detail?: { rounds?: RepairRound[]; action?: string } }).detail;
      if (!detail?.rounds) throw caught;
      setPlanFailure({ message: (caught as Error).message, rounds: detail.rounds, action: detail.action ?? "" });
    }
  });

  const planDestroy = () => guard("plan", async () => {
    setPlanFailure(null);
    const data = await post<{ plan: SavedPlan }>("/api/infra/plan", { action: "destroy", repository, cloud });
    setPlan(data.plan);
  });

  const approve = () => guard("apply", async () => {
    if (!plan) return;
    await post("/api/infra/apply", { repository, cloud, planId: plan.id });
    setPlan(null);
    await loadStatus();
  });

  const applyDiagnosis = () => {
    if (!job?.diagnosis?.patch) return;
    applySpec({ ...spec, ...job.diagnosis.patch });
    setPlan(null);
  };

  const ready = Boolean(status && !status.missing.length && status.terraform);
  const number = (field: "port" | "minInstances" | "maxInstances") => (event: React.ChangeEvent<HTMLInputElement>) => {
    setSpec({ ...spec, [field]: Number(event.target.value) });
    setPlan(null);
  };

  return (
    <div className="card">
      <h3 className="card-title">웹 서비스 + DB를 Terraform으로 구축하기</h3>
      <p className="card-desc">AI는 소스를 읽고 배포 명세만 작성합니다. 실제 자원은 고정된 Terraform 템플릿으로 만들고, 만들기 전에 계획을 보여 드립니다.</p>

      <div className="form-group">
        <label className="form-label">클라우드</label>
        <div className="seg-row three" role="tablist" aria-label="구축할 클라우드">
          {CLOUDS.map((item) => (
            <button key={item} type="button" role="tab" aria-selected={cloud === item} disabled={running || Boolean(busy)} className={`seg-btn ${cloud === item ? "active" : ""}`} onClick={() => setCloud(item)}>
              {CLOUD_LABEL[item]}
            </button>
          ))}
        </div>
        {supportsVm(cloud) && (
          <div className="seg-row" role="tablist" aria-label="실행 방식" style={{ marginTop: 10 }}>
            <button type="button" role="tab" aria-selected={spec.compute === "serverless"} disabled={running || Boolean(busy)} className={`seg-btn ${spec.compute === "serverless" ? "active" : ""}`}
              onClick={() => { setSpec({ ...spec, compute: "serverless" }); setPlan(null); }}>{CLOUD_SERVICES[cloud].web} (서버리스)</button>
            <button type="button" role="tab" aria-selected={spec.compute === "vm"} disabled={running || Boolean(busy)} className={`seg-btn ${spec.compute === "vm" ? "active" : ""}`}
              onClick={() => { setSpec({ ...spec, compute: "vm" }); setPlan(null); }}>EC2 (서버 한 대)</button>
          </div>
        )}
        <p className="field-note">{services.web} · {services.database} · {services.secrets}</p>
        <p className="field-note" role="status">
          {!status ? "설정 확인 중…"
            : !status.terraform ? "Terraform 실행 파일을 찾을 수 없습니다. .env.local의 TERRAFORM_BIN을 확인하세요."
            : status.missing.length ? `사용 불가 · .env.local에 필요한 값: ${status.missing.join(", ")}`
            : `사용 가능 · 리전 ${status.region} · Terraform ${status.terraform}`}
        </p>
      </div>

      {deployed && (
        <div className="result-box" style={{ marginBottom: 20 }}>
          <div className="result-title">현재 구축된 환경</div>
          <div className="url-card">
            <div className="url-label">{servicesFor(cloud, { compute: deployed.spec.compute ?? "serverless" }).web} {deployed.service}{deployed.database ? ` · ${services.database} ${deployed.database}` : ""} · 버전 {deployed.imageTag.slice(0, 12)}</div>
            <a className="url-link" href={deployed.url} target="_blank" rel="noreferrer">{deployed.url}</a>
          </div>
        </div>
      )}

      <div className="form-group">
        <label className="form-label">1. 배포 명세 {deployed ? "(현재 배포된 값)" : draft?.source === "ai" ? "(AI가 소스를 읽고 작성)" : ""}</label>
        {drafting ? (
          <p className="field-note" role="status"><span className="step-loading" /> AI가 소스를 읽고 명세를 작성하는 중…</p>
        ) : (
          <div className="log-content" style={{ whiteSpace: "normal" }}>
            <div>실행 방식: {services.web}</div>
            <div>포트 {spec.port} · 헬스 체크 {spec.healthPath} · {spec.minInstances}~{spec.maxInstances}개</div>
            <div>DB: {spec.database === "none" ? "사용 안 함" : spec.database === "postgres" ? `PostgreSQL 16 (${services.database})` : `MySQL 8.0 (${services.database})`}</div>
            <div>환경변수: {Object.keys(textToEnv(envText)).join(", ") || "없음"}</div>
            <div>비밀 환경변수: {secretNames.join(", ") || "없음"}</div>
          </div>
        )}
        {draft && (
          <div className="field-note" style={{ marginTop: 10 }}>
            {draft.reasons.map((reason) => <div key={reason}>· {reason}</div>)}
            {draft.questions.map((question) => <div key={question} style={{ marginTop: 4 }}>❓ {question}</div>)}
          </div>
        )}
        {draft?.warnings.map((warning) => <div key={warning} className="alert-banner error" style={{ marginTop: 10 }}>⚠️ {warning}</div>)}
        <div className="seg-row" style={{ marginTop: 10 }}>
          <button type="button" className="seg-btn" disabled={!repository || !branch || Boolean(busy) || drafting || running} onClick={() => void redraft()}>
            {busy === "spec" ? "다시 읽는 중…" : "AI로 다시 작성"}
          </button>
          <button type="button" className={`seg-btn ${editing ? "active" : ""}`} disabled={drafting} onClick={() => setEditing(!editing)}>
            {editing ? "수정 닫기" : "직접 수정"}
          </button>
        </div>
      </div>

      {editing && (
        <>
      <div className="form-group" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label className="form-label">컨테이너 포트</label>
          <input className="form-input" type="number" min="1" max="65535" value={spec.port} onChange={number("port")} />
        </div>
        <div>
          <label className="form-label">헬스 체크 경로</label>
          <input className="form-input" type="text" value={spec.healthPath} onChange={(event) => { setSpec({ ...spec, healthPath: event.target.value }); setPlan(null); }} />
        </div>
        <div>
          <label className="form-label">최소 개수 (0~2)</label>
          <input className="form-input" type="number" min="0" max="2" value={spec.minInstances} onChange={number("minInstances")} />
        </div>
        <div>
          <label className="form-label">최대 개수 (1~5)</label>
          <input className="form-input" type="number" min="1" max="5" value={spec.maxInstances} onChange={number("maxInstances")} />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">데이터베이스 ({services.database})</label>
        <select className="form-select" value={spec.database} onChange={(event) => { setSpec({ ...spec, database: event.target.value as InfraSpec["database"] }); setPlan(null); }}>
          <option value="none">사용 안 함</option>
          <option value="postgres">PostgreSQL 16</option>
          <option value="mysql">MySQL 8.0</option>
        </select>
        <p className="field-note">선택하면 DB를 한 번 만들고 접속 정보를 DATABASE_URL, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD 환경변수로 넣어 줍니다. 이후 재배포에서는 DB를 건드리지 않습니다.</p>
      </div>

      <div className="form-group">
        <label className="form-label">환경변수 (한 줄에 이름=값)</label>
        <textarea className="form-input" rows={3} value={envText} placeholder="NODE_ENV=production" onChange={(event) => { setEnvText(event.target.value); setPlan(null); }} />
      </div>

      <div className="form-group">
        <label className="form-label">비밀 환경변수 이름 (쉼표로 구분)</label>
        <input className="form-input" type="text" value={secretNamesText} placeholder="예: OPENAI_API_KEY" onChange={(event) => { setSecretNamesText(event.target.value); setPlan(null); }} />
      </div>
        </>
      )}

      {secretNames.length > 0 && (
        <div className="form-group">
          <label className="form-label">비밀 환경변수의 값 (직접 입력)</label>
        {secretNames.map((name) => (
          <input key={name} className="form-input" style={{ marginTop: 8 }} type="password" autoComplete="off" value={secretValues[name] ?? ""}
            placeholder={status?.storedSecretNames.includes(name) ? `${name} · 저장된 값 사용 (바꾸려면 입력)` : `${name}의 값`}
            onChange={(event) => { setSecretValues({ ...secretValues, [name]: event.target.value }); setPlan(null); }} />
        ))}
        <p className="field-note">값은 AI에 보내지 않고, {services.secrets}에만 들어갑니다.</p>
        </div>
      )}

      <div className="form-group">
        <label className="form-label">2. 배포할 버전</label>
        <button type="button" className="btn btn-secondary" disabled={!repository || !branch || Boolean(busy) || running} onClick={() => void loadVersions()}>
          {busy === "versions" ? "버전 확인 중…" : "배포 가능한 버전 불러오기"}
        </button>
        {versions.length > 0 && (
          <select className="form-select" style={{ marginTop: 10 }} value={imageTag} onChange={(event) => { setImageTag(event.target.value); setPlan(null); }}>
            {versions.map((version) => (
              <option key={version.tag} value={version.tag}>{version.tag.slice(0, 12)} · {new Date(version.publishedAt).toLocaleString("ko-KR")}</option>
            ))}
          </select>
        )}
      </div>

      <button type="button" className="btn btn-primary" disabled={!ready || !imageTag || Boolean(busy) || drafting || running} onClick={() => void makePlan()}>
        {busy === "plan" ? "검증하는 중… (validate → plan → 정책 검사)" : "3. 계획 만들기 (비용 없음)"}
      </button>
      {status?.hasResources && (
        <>
          <button type="button" className="btn btn-secondary" style={{ marginTop: 10 }} disabled={!ready || Boolean(busy) || running} onClick={() => void planDestroy()}>
            이 클라우드의 자원 전체 삭제 계획 만들기 (과금 중지)
          </button>
          {!deployed && <p className="field-note">배포가 끝까지 성공하지 않았지만 만들어진 자원이 남아 있습니다. 쓰지 않을 거라면 삭제하세요.</p>}
        </>
      )}

      {error && <div className="alert-banner error" style={{ marginTop: 16 }}>⚠️ {error}</div>}

      {planFailure && (
        <div className="alert-banner error" style={{ marginTop: 16, display: "block" }}>
          <strong>⚠️ {planFailure.message}</strong>
          {planFailure.rounds.map((round, index) => (
            <div key={index} style={{ marginTop: 8 }}>
              <div>{index + 1}차 {round.stage} 실패{round.cause ? ` · ${round.cause}` : ""}</div>
              {round.patch && <div>AI 수정: {describePatch(round.patch)}</div>}
            </div>
          ))}
          {planFailure.action && <div style={{ marginTop: 8 }}>해야 할 일: {planFailure.action}</div>}
          <details className="log-accordion"><summary>Terraform 오류 원문</summary><pre className="log-content">{planFailure.rounds.at(-1)?.error}</pre></details>
        </div>
      )}

      {plan && (
        <div className="result-box" style={{ marginTop: 16 }}>
          <div className="result-title">
            {plan.destroy ? "삭제 계획" : "구축 계획"} · {CLOUD_LABEL[plan.cloud]} {plan.region} · 생성 {plan.summary.counts.create} · 변경 {plan.summary.counts.update} · 교체 {plan.summary.counts.replace} · 삭제 {plan.summary.counts.delete}
          </div>
          {plan.rounds.map((round, index) => (
            <p key={index} className="field-note">🔁 {index + 1}차 {round.stage} 검증 실패 → AI가 명세를 고쳐 다시 통과: {round.patch ? describePatch(round.patch) : round.cause}</p>
          ))}
          {!plan.destroy && plan.notes.map((note) => (
            <p key={note.text} className="field-note">{note.level === "applied" ? "✅ 적용" : "↘️ 낮춤"} · {note.text}</p>
          ))}
          {plan.summary.changes.length === 0 && <p className="field-note">바뀌는 것이 없습니다. 클라우드가 이미 이 명세와 같은 상태입니다.</p>}
          <details className="log-accordion" open={plan.summary.changes.length <= 12}>
            <summary>자원 {plan.summary.changes.length}개 보기</summary>
            <div className="log-content" style={{ whiteSpace: "normal" }}>
              {plan.summary.changes.map((change) => (
                <div key={change.address}>
                  [{ACTION_LABEL[change.action]}] {change.label}{change.billable ? " · 💰과금" : ""}{change.slow ? " · ⏱수 분 소요" : ""}
                </div>
              ))}
            </div>
          </details>
          <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={Boolean(busy) || running || plan.summary.changes.length === 0} onClick={() => void approve()}>
            {busy === "apply" ? "시작하는 중…" : plan.destroy ? "4. 승인하고 삭제 실행" : "4. 승인하고 실제로 만들기 (과금 시작)"}
          </button>
        </div>
      )}

      {job && (
        <div style={{ marginTop: 16 }}>
          <div className="progress-steps" aria-live="polite">
            <div className="step-item">
              {running ? <span className="step-loading" /> : <span className="step-check">{job.status === "SUCCESS" ? "✓" : "✕"}</span>}
              <span>
                {job.kind === "destroy" ? "삭제" : "구축"} {running ? (job.phase === "health" ? "· 자원 생성 완료, 앱 응답을 기다리는 중" : "· Terraform 실행 중 (DB가 있으면 10분 안팎)") : job.status === "SUCCESS" ? "완료" : "실패"}
                {" · "}{new Date(job.startedAt).toLocaleTimeString("ko-KR")} 시작
              </span>
            </div>
          </div>
          {job.status === "FAILED" && job.error && <div className="alert-banner error" style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>⚠️ {job.error.slice(0, 600)}</div>}
          {job.diagnosis && (
            <div className="result-box" style={{ marginTop: 10 }}>
              <div className="result-title">AI 진단</div>
              <p className="field-note">{job.diagnosis.cause}</p>
              {job.diagnosis.action && <p className="field-note">해야 할 일: {job.diagnosis.action}</p>}
              {job.diagnosis.patch && (
                <button type="button" className="btn btn-secondary" disabled={Boolean(busy)} onClick={applyDiagnosis}>
                  명세 수정안 적용: {describePatch(job.diagnosis.patch)}
                </button>
              )}
            </div>
          )}
          {status?.log && (
            <details className="log-accordion" open={running}>
              <summary>Terraform 로그</summary>
              <pre className="log-content">{status.log}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
