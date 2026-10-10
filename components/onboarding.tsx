"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DeploymentRecord,
  GeneratedSetup,
  OnPremiseDeployment,
  RepositoryAnalysis,
  RepositoryOption,
  SavedDeploymentTarget,
  WorkflowRunSummary,
} from "@/lib/types";
import { DatabasePanel } from "@/components/database-panel";
import { Deployment } from "@/components/deployment";
import { DeploymentHistory } from "@/components/deployment-history";
import { EnvVarsPanel } from "@/components/env-vars-panel";
import { FailureAnalysisPanel } from "@/components/failure-analysis";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `오류가 발생했습니다 (${response.status}).`);
  return body;
}

export function Onboarding() {
  const [connected, setConnected] = useState(false);
  const [repositories, setRepositories] = useState<RepositoryOption[]>([]);
  const [repository, setRepository] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [analysis, setAnalysis] = useState<RepositoryAnalysis | null>(null);
  const [setup, setSetup] = useState<GeneratedSetup | null>(null);
  const [dockerfile, setDockerfile] = useState("");
  const [pullRequest, setPullRequest] = useState<{ number: number; htmlUrl: string; branch: string; merged?: boolean } | null>(null);
  const [pipelineStep, setPipelineStep] = useState<"idle" | "analyzing" | "generating" | "merging" | "completed">("idle");
  const [showAdvancedSetup, setShowAdvancedSetup] = useState(false);
  const [showCiSetup, setShowCiSetup] = useState(false);
  const [selectedInfra, setSelectedInfra] = useState<"on-premise" | "cloud">("on-premise");

  const [run, setRun] = useState<WorkflowRunSummary | null>(null);
  const [savedTarget, setSavedTarget] = useState<SavedDeploymentTarget | null>(null);
  const [deployedSha, setDeployedSha] = useState<string | null>(null);
  const [history, setHistory] = useState<DeploymentRecord[]>([]);
  // Bumped when detected databases or app variables may have changed, to reload the database panel.
  const [databaseRevision, setDatabaseRevision] = useState(0);
  // The last on-premises deployment error, kept apart from other errors so only it offers AI analysis.
  const [deployFailure, setDeployFailure] = useState<{ message: string; tag?: string } | null>(null);
  const [deployment, setDeployment] = useState<OnPremiseDeployment | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [deployStep, setDeployStep] = useState(0);

  const [showEditServer, setShowEditServer] = useState(false);
  const [serverHost, setServerHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUsername, setSshUsername] = useState("");
  const [sshPublicKey, setSshPublicKey] = useState("");
  const [sshSetupCommand, setSshSetupCommand] = useState("");
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [hostPort, setHostPort] = useState("8000");
  const [containerPort, setContainerPort] = useState("8000");

  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const selectedRepository = useMemo(
    () => repositories.find((item) => item.fullName === repository),
    [repositories, repository],
  );

  // 1. Restore GitHub session
  const loadRepositories = useCallback(async () => {
    setBusy("repositories");
    setError("");
    try {
      const data = await requestJson<{ repositories: RepositoryOption[] }>("/api/github/repositories");
      setConnected(true);
      setRepositories(data.repositories);
      if (data.repositories.length > 0) {
        setRepository(data.repositories[0].fullName);
        setBranch(data.repositories[0].defaultBranch || "main");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "저장소를 불러오지 못했습니다.");
      setConnected(false);
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => {
    const restoreSession = async () => {
      try {
        const session = await requestJson<{ connected: boolean }>("/api/github/session");
        setConnected(session.connected);
        if (session.connected) {
          void loadRepositories();
        }
      } catch {
        setConnected(false);
      }
    };
    void restoreSession();
  }, [loadRepositories]);

  // 2. Disconnect GitHub session
  const disconnectGithub = async () => {
    try {
      await requestJson("/api/github/session", { method: "DELETE" });
      setConnected(false);
      setRepositories([]);
      setRepository("");
      setSavedTarget(null);
      setRun(null);
      setDeployment(null);
      window.location.href = "/";
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "연결 해제에 실패했습니다.");
    }
  };

  // Load branches when repository changes
  useEffect(() => {
    if (!repository || !connected) {
      setBranches([]);
      setBranch("");
      return;
    }
    const controller = new AbortController();
    const loadBranches = async () => {
      try {
        const query = new URLSearchParams({ repository });
        const data = await requestJson<{ branches: string[] }>(
          `/api/github/branches?${query}`,
          { signal: controller.signal },
        );
        setBranches(data.branches);
        if (data.branches.length > 0 && !data.branches.includes(branch)) {
          setBranch(selectedRepository?.defaultBranch ?? data.branches[0]);
        }
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setBranches([]);
      }
    };
    void loadBranches();
    return () => controller.abort();
  }, [repository, connected, selectedRepository, branch]);

  // 3. Load saved server when repository changes
  useEffect(() => {
    if (!repository || !connected) {
      setSavedTarget(null);
      return;
    }
    const controller = new AbortController();
    const loadSavedTarget = async () => {
      try {
        const query = new URLSearchParams({ repository });
        const data = await requestJson<{ target: SavedDeploymentTarget | null }>(
          `/api/deploy/on-premise?${query}`,
          { signal: controller.signal },
        );
        setSavedTarget(data.target);
        setShowEditServer(false);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setSavedTarget(null);
      }
    };
    void loadSavedTarget();
    return () => controller.abort();
  }, [repository, connected]);

  // Load SSH public key for on-premise registration
  useEffect(() => {
    if (!repository || !connected) {
      setSshPublicKey("");
      setSshSetupCommand("");
      return;
    }
    const loadKey = async () => {
      try {
        const query = new URLSearchParams({ repository });
        const data = await requestJson<{ publicKey: string; setupCommand: string }>(
          `/api/deploy/ssh-key?${query}`,
        );
        setSshPublicKey(data.publicKey);
        setSshSetupCommand(data.setupCommand);
      } catch {
        // ignore
      }
    };
    void loadKey();
  }, [repository, connected]);

  const copySetupCommand = async () => {
    if (!sshSetupCommand) return;
    try {
      await navigator.clipboard.writeText(sshSetupCommand);
      setCopiedCommand(true);
      setTimeout(() => setCopiedCommand(false), 2000);
    } catch {
      // fallback
    }
  };

  // 4. Auto-fetch latest workflow run and poll if building
  const fetchRun = useCallback(async (repo: string) => {
    if (!repo) return null;
    try {
      const query = new URLSearchParams({ repository: repo });
      const data = await requestJson<{ run: WorkflowRunSummary | null }>(
        `/api/github/workflow-runs?${query}`,
      );
      setRun(data.run);
      return data.run;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!repository || !connected) {
      setRun(null);
      return;
    }

    let isMounted = true;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      const currentRun = await fetchRun(repository);
      if (!isMounted) return;

      const isBuilding =
        currentRun &&
        (currentRun.status === "in_progress" ||
          currentRun.status === "queued" ||
          currentRun.status === "waiting");

      const interval = isBuilding ? 2500 : 4000;
      timerId = setTimeout(() => void poll(), interval);
    };

    void poll();

    const handleFocus = () => {
      void fetchRun(repository);
    };
    window.addEventListener("focus", handleFocus);

    return () => {
      isMounted = false;
      if (timerId) clearTimeout(timerId);
      window.removeEventListener("focus", handleFocus);
    };
  }, [repository, connected, fetchRun]);

  // Deployment history. It also restores which commit is live after a page reload.
  const loadHistory = useCallback(async (repo: string) => {
    if (!repo) return;
    try {
      const query = new URLSearchParams({ repository: repo });
      const data = await requestJson<{ deployments: DeploymentRecord[] }>(`/api/deployments?${query}`);
      setHistory(data.deployments);
      const live = data.deployments.find((item) => item.target === "ONPREM" && item.current);
      if (live && /^[a-f0-9]{40}$/i.test(live.imageTag)) setDeployedSha(live.imageTag);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    setHistory([]);
    if (connected && repository) void loadHistory(repository);
  }, [connected, repository, loadHistory]);

  const post = async <T,>(url: string, body: object): Promise<T> =>
    requestJson<T>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // CI/CD Setup: 1. Analyze repository
  const analyze = async () => {
    setBusy("analyze");
    setError("");
    setAnalysis(null);
    setSetup(null);
    setPullRequest(null);
    try {
      const targetBranch = branch || selectedRepository?.defaultBranch || "main";
      const data = await post<{ analysis: RepositoryAnalysis }>("/api/github/analyze", {
        repository,
        branch: targetBranch,
      });
      setAnalysis(data.analysis);
      setDatabaseRevision((revision) => revision + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "저장소 분석에 실패했습니다.");
    } finally {
      setBusy("");
    }
  };

  // CI/CD Setup: 2. Generate Dockerfile with AI
  const generate = async () => {
    setBusy("generate");
    setError("");
    try {
      const targetBranch = branch || selectedRepository?.defaultBranch || "main";
      const data = await post<{ setup: GeneratedSetup }>("/api/github/generate", {
        repository,
        branch: targetBranch,
      });
      setSetup(data.setup);
      setDockerfile(data.setup.dockerfile);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dockerfile 생성에 실패했습니다.");
    } finally {
      setBusy("");
    }
  };

  // CI/CD Setup: 3. Create GitHub Pull Request (Dockerfile + workflow)
  const createPullRequest = async (autoMerge = true) => {
    setBusy("pull-request");
    setError("");
    try {
      const targetBranch = branch || selectedRepository?.defaultBranch || "main";
      const data = await post<{ pullRequest: { number: number; htmlUrl: string; branch: string; merged: boolean } }>(
        "/api/github/pull-request",
        {
          repository,
          branch: targetBranch,
          dockerfile,
          autoMerge,
        },
      );
      setPullRequest(data.pullRequest);
      if (data.pullRequest.merged) {
        setPipelineStep("completed");
        setTimeout(() => {
          void fetchRun(repository);
        }, 1500);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "설정 PR 생성에 실패했습니다.");
    } finally {
      setBusy("");
    }
  };

  // Full One-Click Pipeline: Analyze -> AI Dockerfile -> PR & Auto-Merge -> Actions Build
  const runOneClickSetup = async () => {
    setBusy("one-click-setup");
    setError("");
    setPipelineStep("analyzing");
    try {
      const targetBranch = branch || selectedRepository?.defaultBranch || "main";

      // 1. Analyze repository
      const analysisData = await post<{ analysis: RepositoryAnalysis }>("/api/github/analyze", {
        repository,
        branch: targetBranch,
      });
      setAnalysis(analysisData.analysis);
      setDatabaseRevision((revision) => revision + 1);

      // 2. Generate Dockerfile with AI
      setPipelineStep("generating");
      const generateData = await post<{ setup: GeneratedSetup }>("/api/github/generate", {
        repository,
        branch: targetBranch,
      });
      setSetup(generateData.setup);
      setDockerfile(generateData.setup.dockerfile);

      // 3. Create PR and Auto-merge into main
      setPipelineStep("merging");
      const prData = await post<{ pullRequest: { number: number; htmlUrl: string; branch: string; merged: boolean } }>(
        "/api/github/pull-request",
        {
          repository,
          branch: targetBranch,
          dockerfile: generateData.setup.dockerfile,
          autoMerge: true,
        },
      );
      setPullRequest(prData.pullRequest);
      setPipelineStep("completed");

      // 4. Poll and trigger latest workflow run
      setTimeout(() => {
        void fetchRun(repository);
      }, 1500);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "원클릭 파이프라인 자동 구축에 실패했습니다.");
      setPipelineStep("idle");
    } finally {
      setBusy("");
    }
  };

  // Execute rolling deployment with step progression simulation
  // With `rollbackOf`, the saved server is redeployed with that past deployment's commit.
  const deploy = async (useSaved = false, rollbackOf?: DeploymentRecord) => {
    setBusy("deploy");
    setError("");
    setDeployFailure(null);
    setDeployment(null);
    setDeployStep(1);

    const stepInterval = setInterval(() => {
      setDeployStep((prev) => (prev < 4 ? prev + 1 : prev));
    }, 2400);

    try {
      const data = await post<{ deployment: OnPremiseDeployment }>(
        "/api/deploy/on-premise",
        {
          repository,
          ...(useSaved
            ? {}
            : {
                host: serverHost,
                sshPort: Number(sshPort),
                username: sshUsername,
                hostPort: Number(hostPort),
                containerPort: Number(containerPort),
              }),
          imageTag: run?.headSha || "latest",
          ...(rollbackOf ? { rollbackOf: rollbackOf.id } : {}),
          useSavedConnection: useSaved,
          saveConnection: true,
        },
      );
      clearInterval(stepInterval);
      setDeployStep(5);
      setDeployment(data.deployment);
      setSavedTarget(data.deployment.target);
      setShowEditServer(false);
      if (rollbackOf) {
        setDeployedSha(rollbackOf.imageTag);
      } else if (run?.headSha) {
        setDeployedSha(run.headSha);
      }
    } catch (caught) {
      clearInterval(stepInterval);
      setDeployStep(0);
      const message = caught instanceof Error ? caught.message : "배포에 실패했습니다.";
      setError(message);
      setDeployFailure({ message, tag: rollbackOf?.imageTag ?? run?.headSha });
    } finally {
      setBusy("");
      void loadHistory(repository);
    }
  };

  // Test and save server connection
  const verifyAndSaveServer = async () => {
    setBusy("save");
    setError("");
    try {
      const data = await post<{ target: SavedDeploymentTarget }>(
        "/api/deploy/on-premise",
        {
          repository,
          host: serverHost,
          sshPort: Number(sshPort),
          username: sshUsername,
          hostPort: Number(hostPort),
          containerPort: Number(containerPort),
          saveOnly: true,
        },
      );
      setSavedTarget(data.target);
      setShowEditServer(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "서버 연결 확인에 실패했습니다.");
    } finally {
      setBusy("");
    }
  };

  const rollback = (record: DeploymentRecord) => {
    if (!confirm(`#${record.number} (${record.imageTag.slice(0, 12)}) 버전으로 되돌리시겠습니까?`)) return;
    setSelectedInfra("on-premise");
    void deploy(true, record);
  };

  // Delete saved server connection
  const deleteServer = async () => {
    if (!confirm("등록된 서버 정보를 삭제하시겠습니까?")) return;
    // Default is to keep the data: only an explicit second confirmation deletes the database volumes.
    const purgeData = confirm(
      "이 앱의 DB 컨테이너와 데이터도 서버에서 함께 삭제할까요? 되돌릴 수 없습니다.\n\n확인: DB 데이터까지 삭제\n취소: 서버 정보만 삭제 (DB 데이터는 서버에 남음)",
    );
    setBusy("delete");
    setError("");
    try {
      const query = new URLSearchParams({ repository, ...(purgeData ? { purgeData: "true" } : {}) });
      await requestJson<{ success: boolean }>(`/api/deploy/on-premise?${query}`, {
        method: "DELETE",
      });
      setSavedTarget(null);
      setShowEditServer(false);
      setDeployment(null);
      setDeployStep(0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "서버 삭제에 실패했습니다.");
    } finally {
      setBusy("");
    }
  };

  const isBuilding =
    run &&
    (run.status === "in_progress" ||
      run.status === "queued" ||
      run.status === "waiting");

  const hasNewRelease = Boolean(
    run &&
      run.conclusion === "success" &&
      (!deployedSha || deployedSha !== run.headSha),
  );

  const activePublicUrl = deployment?.publicUrl;

  return (
    <div>
      {/* HEADER */}
      <header className="app-header">
        <a className="logo" href="/">
          SBSB <span className="logo-badge">배포</span>
        </a>
        <div className="header-actions">
          {connected ? (
            <>
              <a className="pill-btn" href="/api/github/install">
                저장소 권한 변경 ↗
              </a>
              <button className="pill-btn danger" onClick={() => void disconnectGithub()}>
                연결 해제
              </button>
            </>
          ) : (
            <span className="user-badge">무중단 자동 배포</span>
          )}
        </div>
      </header>

      {/* 1. GITHUB CONNECT / REPO SELECT */}
      {!connected ? (
        <div className="card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: "44px", marginBottom: "16px" }}>🐙</div>
          <h2 className="card-title" style={{ fontSize: "22px" }}>GitHub 저장소를 연결해 주세요</h2>
          <p className="card-desc">배포할 저장소를 선택할 수 있도록 GitHub App을 연결합니다.</p>
          <a className="btn btn-primary" href="/api/github/install">
            GitHub 연동하기
          </a>
        </div>
      ) : (
        <div className="card">
          <label className="form-label">배포할 저장소</label>
          <select
            className="form-select"
            value={repository}
            onChange={(e) => {
              const next = e.target.value;
              setRepository(next);
              const found = repositories.find((r) => r.fullName === next);
              setBranch(found?.defaultBranch || "main");
              setAnalysis(null);
              setSetup(null);
              setDockerfile("");
              setPullRequest(null);
              setDeployment(null);
              setDeployedSha(null);
              setDeployStep(0);
              setError("");
            }}
          >
            {repositories.map((item) => (
              <option key={item.id} value={item.fullName}>
                {item.fullName}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* CI/CD SETUP CARD (INITIAL SETUP OR RECONFIGURATION) */}
      {connected && repository && (!run || showCiSetup) && (
        <div
          className="card"
          style={{
            border: !run ? "1.5px solid #ff922b" : "1px solid var(--border)",
            background: !run ? "#fffdf5" : "var(--card-bg)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              marginBottom: "14px",
            }}
          >
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "20px" }}>🛠️</span>
                <h3 className="card-title" style={{ margin: 0 }}>
                  {!run ? "1단계: 빌드 파이프라인(CI/CD) 설정" : "CI/CD 설정 다시 생성"}
                </h3>
                {!run && (
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: "99px",
                      background: "#ff922b",
                      color: "white",
                    }}
                  >
                    최초 필수
                  </span>
                )}
              </div>
              <p className="card-desc" style={{ marginTop: "6px", marginBottom: 0 }}>
                {!run
                  ? "이 저장소에는 아직 Docker 빌드 파이프라인이 없습니다. AI가 코드를 분석하여 Dockerfile과 GitHub Actions 워크플로우를 자동 생성하고 PR을 만듭니다."
                  : "AI로 저장소를 다시 분석하고 Dockerfile 및 GitHub Actions PR을 새로 생성합니다."}
              </p>
            </div>
            {run && (
              <button
                type="button"
                className="btn-link"
                onClick={() => setShowCiSetup(false)}
              >
                닫기 ✕
              </button>
            )}
          </div>

          {/* Branch selector & One-click automated setup button */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: "12px",
              alignItems: "end",
              marginBottom: "16px",
            }}
          >
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label" style={{ fontWeight: 600 }}>기준 브랜치</label>
              <select
                className="form-select"
                value={branch}
                disabled={busy !== ""}
                onChange={(e) => {
                  setBranch(e.target.value);
                  setAnalysis(null);
                  setSetup(null);
                  setPullRequest(null);
                  setPipelineStep("idle");
                }}
              >
                {branches.length === 0 && <option>{branch || "main"}</option>}
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              style={{
                height: "46px",
                padding: "0 24px",
                width: "auto",
                fontWeight: 800,
                fontSize: "14px",
                background: "linear-gradient(135deg, #1971c2 0%, #0c8599 100%)",
                border: "none",
                boxShadow: "0 4px 12px rgba(12, 133, 153, 0.25)",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
              }}
              disabled={busy !== "" || !repository}
              onClick={() => void runOneClickSetup()}
            >
              {busy === "one-click-setup" ? (
                <>
                  <span className="step-loading" style={{ borderColor: "white", borderTopColor: "transparent" }} />
                  파이프라인 자동 구축 중…
                </>
              ) : (
                <>
                  <span>⚡</span>
                  <span>원클릭 배포 준비 시작 (자동 머지)</span>
                </>
              )}
            </button>
          </div>

          {/* Real-time Pipeline Progress Box */}
          {(pipelineStep !== "idle" || analysis || pullRequest || isBuilding || (run && run.conclusion === "success")) && (
            <div
              style={{
                background: "white",
                borderRadius: "14px",
                border: "1.5px solid var(--border)",
                padding: "18px 20px",
                marginBottom: "16px",
                boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
              }}
            >
              <div style={{ fontSize: "14px", fontWeight: 800, color: "var(--text-main)", marginBottom: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
                <span>📋</span>
                <span>배포 파이프라인 진행 상태</span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {/* 1단계: 저장소 기술 스택 분석 */}
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div
                    style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "12px",
                      fontWeight: 800,
                      flexShrink: 0,
                      background: analysis ? "#20c997" : pipelineStep === "analyzing" ? "#339af0" : "#e9ecef",
                      color: analysis || pipelineStep === "analyzing" ? "white" : "#868e96",
                    }}
                  >
                    {analysis ? "✓" : pipelineStep === "analyzing" ? <span className="step-loading" style={{ width: "12px", height: "12px", borderColor: "white", borderTopColor: "transparent" }} /> : "1"}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-main)" }}>
                      1. 저장소 기술 스택 및 포트 분석
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--text-sub)", marginTop: "2px" }}>
                      {analysis
                        ? `감지된 프레임워크: ${analysis.framework} (패키지: ${analysis.packageManager}, ${analysis.files.length}개 파일 검토)`
                        : pipelineStep === "analyzing"
                        ? "저장소 코드 구조와 종속성 파일을 분석하고 있습니다…"
                        : "저장소 분석 대기 중"}
                    </div>
                  </div>
                </div>

                {/* 2단계: AI 최적화 Dockerfile 생성 */}
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div
                    style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "12px",
                      fontWeight: 800,
                      flexShrink: 0,
                      background: setup ? "#20c997" : pipelineStep === "generating" ? "#339af0" : "#e9ecef",
                      color: setup || pipelineStep === "generating" ? "white" : "#868e96",
                    }}
                  >
                    {setup ? "✓" : pipelineStep === "generating" ? <span className="step-loading" style={{ width: "12px", height: "12px", borderColor: "white", borderTopColor: "transparent" }} /> : "2"}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-main)" }}>
                      2. AI 최적화 Dockerfile 자동 생성
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--text-sub)", marginTop: "2px" }}>
                      {setup
                        ? "멀티스테이지 경량 Dockerfile 생성 완료"
                        : pipelineStep === "generating"
                        ? "프레임워크에 최적화된 컨테이너 빌드 설정을 작성하고 있습니다…"
                        : "Dockerfile 생성 대기 중"}
                    </div>
                  </div>
                </div>

                {/* 3단계: CI/CD 워크플로우 등록 및 main 자동 병합 */}
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div
                    style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "12px",
                      fontWeight: 800,
                      flexShrink: 0,
                      background: pullRequest?.merged ? "#20c997" : pullRequest && !pullRequest.merged ? "#ff922b" : pipelineStep === "merging" ? "#339af0" : "#e9ecef",
                      color: pullRequest || pipelineStep === "merging" ? "white" : "#868e96",
                    }}
                  >
                    {pullRequest?.merged ? "✓" : pullRequest && !pullRequest.merged ? "!" : pipelineStep === "merging" ? <span className="step-loading" style={{ width: "12px", height: "12px", borderColor: "white", borderTopColor: "transparent" }} /> : "3"}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-main)" }}>
                      3. CI/CD 워크플로우 등록 및 main 브랜치 자동 병합
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--text-sub)", marginTop: "2px" }}>
                      {pullRequest?.merged ? (
                        <span style={{ color: "#099268", fontWeight: 600 }}>
                          ✓ PR #{pullRequest.number} 생성 및 <code>{branch || "main"}</code> 브랜치 자동 머지 완료! (수동 승인 불필요)
                        </span>
                      ) : pullRequest && !pullRequest.merged ? (
                        <span style={{ color: "#d9480f" }}>
                          PR #{pullRequest.number} 생성 완료 (저장소 보호 규칙으로 인해 수동 머지가 필요합니다:{" "}
                          <a href={pullRequest.htmlUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "underline", fontWeight: 700 }}>
                            GitHub에서 머지하기 ↗
                          </a>)
                        </span>
                      ) : pipelineStep === "merging" ? (
                        "GitHub Actions 워크플로우 커밋 후 main 브랜치로 자동 머지하고 있습니다…"
                      ) : (
                        "GitHub Actions 워크플로우 등록 및 자동 머지 대기 중"
                      )}
                    </div>
                  </div>
                </div>

                {/* 4단계: GitHub Actions 컨테이너 이미지 빌드 */}
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div
                    style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "12px",
                      fontWeight: 800,
                      flexShrink: 0,
                      background: run?.conclusion === "success" ? "#20c997" : isBuilding ? "#fcc419" : "#e9ecef",
                      color: run?.conclusion === "success" || isBuilding ? "white" : "#868e96",
                    }}
                  >
                    {run?.conclusion === "success" ? "✓" : isBuilding ? <span className="step-loading" style={{ width: "12px", height: "12px", borderColor: "white", borderTopColor: "transparent" }} /> : "4"}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-main)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span>4. GitHub Actions 첫 Docker 이미지 빌드</span>
                      {run?.htmlUrl && (
                        <a href={run.htmlUrl} target="_blank" rel="noreferrer" style={{ fontSize: "11px", color: "var(--primary)", textDecoration: "underline" }}>
                          실시간 빌드 로그 ↗
                        </a>
                      )}
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--text-sub)", marginTop: "2px" }}>
                      {run?.conclusion === "success" ? (
                        <span style={{ color: "#099268", fontWeight: 700 }}>
                          🎉 첫 번째 컨테이너 이미지 빌드 완료! ({run.headSha ? run.headSha.slice(0, 7) : "latest"}) — 이제 아래 탭에서 서버로 배포할 수 있습니다.
                        </span>
                      ) : isBuilding ? (
                        <span style={{ color: "#b17900", fontWeight: 600 }}>
                          GitHub Actions에서 Docker 이미지를 빌드하고 있습니다… (커밋: <code>{run?.headSha ? run.headSha.slice(0, 7) : "main"}</code>)
                        </span>
                      ) : (
                        "main 브랜치 병합 후 자동으로 GitHub Actions 빌드가 실행됩니다."
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* 고급 설정 아코디언 (Dockerfile 확인 및 개별 실행) */}
              <div style={{ marginTop: "16px", paddingTop: "12px", borderTop: "1px dashed var(--border)" }}>
                <button
                  type="button"
                  className="btn-link"
                  style={{
                    fontSize: "12px",
                    color: "var(--text-muted)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    cursor: "pointer",
                    padding: 0,
                  }}
                  onClick={() => setShowAdvancedSetup(!showAdvancedSetup)}
                >
                  {showAdvancedSetup ? "▲ 생성된 Dockerfile 확인 접기" : "▼ 고급: 생성된 Dockerfile 확인 및 개별 실행 옵션"}
                </button>

                {showAdvancedSetup && (
                  <div style={{ marginTop: "12px", padding: "14px", background: "#f8f9fa", borderRadius: "10px", border: "1px solid var(--border)" }}>
                    {analysis && (
                      <div style={{ marginBottom: "12px" }}>
                        <div style={{ fontSize: "12px", fontWeight: 700, marginBottom: "6px" }}>감지된 분석 파일:</div>
                        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                          {analysis.files.map((f) => (
                            <code key={f.path} style={{ fontSize: "11px", background: "#e9ecef", padding: "2px 6px", borderRadius: "4px" }}>
                              {f.path}
                            </code>
                          ))}
                        </div>
                      </div>
                    )}

                    <div style={{ marginBottom: "10px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                        <label className="form-label" style={{ margin: 0, fontSize: "12px" }}>
                          Dockerfile 내용 (수정 가능)
                        </label>
                      </div>
                      <textarea
                        className="form-input"
                        style={{
                          fontFamily: "monospace",
                          fontSize: "12px",
                          height: "150px",
                          resize: "vertical",
                          background: "white",
                        }}
                        value={dockerfile}
                        onChange={(e) => setDockerfile(e.target.value)}
                        placeholder="AI가 생성한 Dockerfile이 여기에 표시됩니다."
                        spellCheck={false}
                      />
                    </div>

                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: "12px", padding: "6px 14px", width: "auto" }}
                        disabled={busy !== "" || !repository}
                        onClick={() => void analyze()}
                      >
                        {busy === "analyze" ? "분석 중…" : "저장소만 다시 분석"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: "12px", padding: "6px 14px", width: "auto" }}
                        disabled={busy !== "" || !analysis}
                        onClick={() => void generate()}
                      >
                        {busy === "generate" ? "생성 중…" : "Dockerfile만 재생성"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: "12px", padding: "6px 14px", width: "auto" }}
                        disabled={busy !== "" || !dockerfile}
                        onClick={() => void createPullRequest(false)}
                      >
                        {busy === "pull-request" ? "PR 생성 중…" : "수동 승인 PR 생성 (자동 머지 X)"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* RE-OPEN CI/CD SETUP BUTTON (When run exists and card is closed) */}
      {connected && repository && run && !showCiSetup && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "12px" }}>
          <button
            type="button"
            className="btn-link"
            style={{ fontSize: "12px", color: "var(--text-muted)" }}
            onClick={() => setShowCiSetup(true)}
          >
            ⚙️ CI/CD 파이프라인 (Dockerfile & Actions PR) 다시 설정하기
          </button>
        </div>
      )}

      {/* 2. INFRASTRUCTURE SELECTOR */}
      {connected && repository && (
        <>
          {/* GITHUB ACTIONS LIVE BUILD PROGRESS (GLOBAL) */}
          {isBuilding && (
            <div
              className="status-card building"
              style={{
                flexDirection: "column",
                alignItems: "stretch",
                gap: "10px",
                marginBottom: "20px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span className="step-loading" />
                  <strong style={{ fontSize: "15px" }}>GitHub Actions 빌드 진행 중…</strong>
                </div>
                {run?.htmlUrl && (
                  <a
                    href={run.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-link"
                    style={{ fontSize: "12px", color: "inherit", fontWeight: 700 }}
                  >
                    실시간 로그 보기 ↗
                  </a>
                )}
              </div>
              <div
                className="progress-steps"
                style={{
                  margin: 0,
                  padding: "12px",
                  background: "rgba(255, 255, 255, 0.75)",
                  borderRadius: "10px",
                }}
              >
                <div className="step-item">
                  <span className="step-check">✓</span>
                  <span>코드 Push 감지 완료 ({run?.headSha ? run.headSha.slice(0, 7) : "main"})</span>
                </div>
                <div className="step-item" style={{ color: "#b17900" }}>
                  <span className="step-loading" />
                  <span>Docker 이미지 빌드 & 테스트 진행 중…</span>
                </div>
                <div className="step-item" style={{ color: "#adb5bd" }}>
                  <span className="step-pending">3</span>
                  <span>Docker Hub 비공개 저장소 등록 대기</span>
                </div>
              </div>
            </div>
          )}

          {/* NEW RELEASE READY NOTIFICATION (GLOBAL) */}
          {!isBuilding && busy !== "deploy" && hasNewRelease && (
            <div
              className="status-card new"
              style={{
                marginBottom: "20px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "#eef2ff",
                border: "1.5px solid #c7d2fe",
                padding: "16px 20px",
                borderRadius: "16px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <span className="status-icon" style={{ fontSize: "28px" }}>📦</span>
                <div className="status-text">
                  <div style={{ fontSize: "15px", fontWeight: 800, color: "#3730a3" }}>
                    새로운 Docker 이미지가 준비되었습니다!
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                    최신 커밋: <code>{run?.headSha.slice(0, 7)}</code>
                    {run?.htmlUrl && (
                      <a
                        href={run.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ marginLeft: "8px", color: "var(--primary)", fontWeight: 700 }}
                      >
                        빌드 로그 ↗
                      </a>
                    )}
                  </div>
                </div>
              </div>
              {savedTarget && (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: "auto", height: "42px", padding: "0 18px", fontSize: "14px", flexShrink: 0 }}
                  disabled={busy !== ""}
                  onClick={() => void deploy(true)}
                >
                  {busy === "deploy" ? "배포 진행 중…" : "새 버전 롤링 배포하기 →"}
                </button>
              )}
            </div>
          )}

          <div className="infra-tabs">
            <button
              className={`infra-tab-btn ${selectedInfra === "on-premise" ? "active" : ""}`}
              onClick={() => setSelectedInfra("on-premise")}
            >
              🏢 온프레미스
            </button>
            <button
              className={`infra-tab-btn ${selectedInfra === "cloud" ? "active" : ""}`}
              onClick={() => setSelectedInfra("cloud")}
            >
              ☁️ 클라우드
            </button>
          </div>

          {error && <div className="alert-banner error">⚠️ {error}</div>}
          {deployFailure && error === deployFailure.message && (
            <FailureAnalysisPanel
              key={deployFailure.message}
              repository={repository}
              kind="deploy"
              tag={deployFailure.tag && /^[a-f0-9]{40}$/.test(deployFailure.tag) ? deployFailure.tag : undefined}
              error={deployFailure.message}
              context={{ target: "on-premise", port: savedTarget?.containerPort ?? (Number(containerPort) || undefined) }}
            />
          )}
          {run?.conclusion === "failure" && (
            <div className="card">
              <h3 className="card-title">최근 빌드가 실패했습니다</h3>
              <p className="card-desc">커밋 {run.headSha.slice(0, 12)}의 이미지 빌드가 실패해 배포할 새 버전이 없습니다.</p>
              <FailureAnalysisPanel key={run.id} repository={repository} kind="build" runId={run.id} />
            </div>
          )}

          {/* CLOUD TAB CONTENT */}
          {selectedInfra === "cloud" && (
            <Deployment
              repository={repository}
              branch={run?.branch || selectedRepository?.defaultBranch || ""}
              onDeployed={() => void loadHistory(repository)}
            />
          )}

          {/* ON-PREMISE TAB CONTENT */}
          {selectedInfra === "on-premise" && (
            <div className="card">
              {/* CASE A: NO SERVER REGISTERED OR EDITING */}
              {!savedTarget || showEditServer ? (
                <div>
                  <h3 className="card-title">
                    {savedTarget ? "서버 접속 정보 변경" : "배포 대상 온프레미스 서버 설정"}
                  </h3>
                  <p className="card-desc">
                    {savedTarget
                      ? "서버 접속 정보를 수정한 후 다시 등록합니다."
                      : "비밀번호 입력 없이 안전하게 배포할 수 있도록 아래 순서대로 진행해 주세요."}
                  </p>

                  {/* 1단계: 서버에 인증키 등록 */}
                  <div style={{ marginBottom: "22px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                      <span style={{
                        background: "var(--primary)",
                        color: "white",
                        borderRadius: "99px",
                        width: "20px",
                        height: "20px",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "12px",
                        fontWeight: 800,
                      }}>1</span>
                      <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-main)" }}>
                        서버 원클릭 초기 설정 (인증키 등록 + Docker 자동 설치)
                      </span>
                    </div>

                    {/* SSH 공개키 + Docker 원클릭 복사 카드 */}
                    <div
                      onClick={() => void copySetupCommand()}
                      style={{
                        background: copiedCommand ? "#e6fcf5" : "#f8f9fa",
                        border: `1.5px solid ${copiedCommand ? "#20c997" : "#e9ecef"}`,
                        borderRadius: "14px",
                        padding: "14px 18px",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        transition: "all 0.2s ease",
                        userSelect: "none",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            width: "36px",
                            height: "36px",
                            borderRadius: "10px",
                            background: copiedCommand ? "#20c997" : "#212529",
                            color: "white",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "16px",
                            flexShrink: 0,
                            transition: "background 0.2s ease",
                          }}
                        >
                          {copiedCommand ? "✓" : "🚀"}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-main)" }}>
                            {copiedCommand ? "원클릭 설정 명령어가 복사되었습니다!" : "원클릭 설정 명령어 복사하기"}
                          </div>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "var(--text-muted)",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              fontFamily: "monospace",
                              marginTop: "2px",
                            }}
                          >
                            $ mkdir -p ~/.ssh && echo &quot;ssh-rsa...&quot; &gt;&gt; authorized_keys && install docker...
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="pill-btn"
                        style={{
                          flexShrink: 0,
                          marginLeft: "12px",
                          background: copiedCommand ? "#20c997" : "white",
                          color: copiedCommand ? "white" : "var(--text-main)",
                          borderColor: copiedCommand ? "#20c997" : "var(--border)",
                          fontWeight: 700,
                        }}
                      >
                        {copiedCommand ? "✓ 복사 완료" : "클릭하여 복사"}
                      </button>
                    </div>
                    <p style={{ fontSize: "11px", color: "var(--text-sub)", margin: "6px 0 0 4px" }}>
                      * 복사한 명령어를 배포 대상 서버 터미널에 1회 실행하면 SSH 인증키 등록과 Docker 설치 및 권한 설정이 한 번에 완료됩니다.
                    </p>
                  </div>

                  {/* 2단계: 서버 접속 정보 입력 */}
                  <div style={{ marginBottom: "20px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                      <span style={{
                        background: "var(--primary)",
                        color: "white",
                        borderRadius: "99px",
                        width: "20px",
                        height: "20px",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "12px",
                        fontWeight: 800,
                      }}>2</span>
                      <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-main)" }}>
                        서버 접속 정보 입력
                      </span>
                    </div>

                    <div className="form-group">
                      <label className="form-label">서버 IP 또는 호스트 주소</label>
                      <input
                        className="form-input"
                        value={serverHost}
                        onChange={(e) => setServerHost(e.target.value)}
                        placeholder="예: 192.168.1.100"
                      />
                    </div>

                    <div className="form-row">
                      <div className="form-group">
                        <label className="form-label">SSH 사용자명</label>
                        <input
                          className="form-input"
                          value={sshUsername}
                          onChange={(e) => setSshUsername(e.target.value)}
                          placeholder="예: ubuntu"
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">SSH 포트</label>
                        <input
                          className="form-input"
                          type="number"
                          value={sshPort}
                          onChange={(e) => setSshPort(e.target.value)}
                          placeholder="22"
                        />
                      </div>
                    </div>
                  </div>

                  {/* 3단계: 서비스 포트 설정 */}
                  <div style={{ marginBottom: "16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                      <span style={{
                        background: "#adb5bd",
                        color: "white",
                        borderRadius: "99px",
                        width: "20px",
                        height: "20px",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "12px",
                        fontWeight: 800,
                      }}>3</span>
                      <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-main)" }}>
                        서비스 포트 설정 (선택)
                      </span>
                    </div>

                    <div className="form-row">
                      <div className="form-group">
                        <label className="form-label">외부 접속 포트</label>
                        <input
                          className="form-input"
                          type="number"
                          value={hostPort}
                          onChange={(e) => setHostPort(e.target.value)}
                          placeholder="8000"
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">컨테이너 포트</label>
                        <input
                          className="form-input"
                          type="number"
                          value={containerPort}
                          onChange={(e) => setContainerPort(e.target.value)}
                          placeholder="8000"
                        />
                      </div>
                    </div>
                  </div>

                  {/* 액션 버튼 */}
                  <div style={{ display: "flex", gap: "10px", marginTop: "24px" }}>
                    {showEditServer && (
                      <button
                        className="btn btn-secondary"
                        onClick={() => setShowEditServer(false)}
                      >
                        취소
                      </button>
                    )}
                    <button
                      className="btn btn-secondary"
                      disabled={!serverHost || !sshPort || !sshUsername || busy !== ""}
                      onClick={() => void verifyAndSaveServer()}
                    >
                      {busy === "save" ? "연결 확인 중…" : "서버 연결 확인"}
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={
                        !serverHost ||
                        !sshPort ||
                        !sshUsername ||
                        busy !== ""
                      }
                      onClick={() => void deploy(false)}
                    >
                      {busy === "deploy" ? "연결 및 롤링 배포 진행 중…" : "서버 등록하고 첫 릴리즈하기 →"}
                    </button>
                  </div>
                </div>
              ) : (
                /* CASE B: SERVER ALREADY REGISTERED (CLEAN MINIMAL UI) */
                <div>
                  {/* Compact Server Header */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                    <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "6px" }}>
                      <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#20c997", display: "inline-block" }} />
                      연결된 서버: {savedTarget.username}@{savedTarget.host}
                    </span>
                    <div style={{ display: "flex", gap: "10px" }}>
                      <button className="btn-link" onClick={() => setShowEditServer(true)}>정보 변경</button>
                      <button className="btn-link danger" onClick={() => void deleteServer()}>삭제</button>
                    </div>
                  </div>

                  {/* 1. MAIN SERVICE URL CARD */}
                  {activePublicUrl && (
                    <div className="url-card" style={{ padding: "18px", border: "1.5px solid #b7eb8f", background: "#f6ffed", marginBottom: "16px" }}>
                      <div className="url-label" style={{ fontSize: "12px", color: "#389e0d", marginBottom: "6px" }}>
                        🌐 서비스 공개 URL
                      </div>
                      <a
                        className="url-link"
                        href={activePublicUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: "17px", wordBreak: "break-all" }}
                      >
                        {activePublicUrl}
                      </a>
                    </div>
                  )}

                  {/* 2. ROLLING DEPLOYMENT PROGRESS (DEPLOYING) */}
                  {busy === "deploy" && (
                    <div className="status-card" style={{ background: "#fff5ee", border: "1.5px solid #ffd8a8", flexDirection: "column", alignItems: "stretch", gap: "10px", marginBottom: "16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span className="step-loading" />
                        <strong style={{ fontSize: "14px", color: "var(--primary)" }}>온프레미스 무중단 롤링 배포 진행 중…</strong>
                      </div>
                      <div className="progress-steps" style={{ margin: 0, padding: "12px", background: "white" }}>
                        <div className="step-item">
                          {deployStep >= 1 ? <span className="step-check">✓</span> : <span className="step-loading" />}
                          <span>1. Docker Hub에서 최신 이미지 Pull</span>
                        </div>
                        <div className="step-item">
                          {deployStep > 2 ? <span className="step-check">✓</span> : deployStep === 2 ? <span className="step-loading" /> : <span className="step-pending">2</span>}
                          <span>2. 신규 컨테이너 백그라운드 기동 (기존 버전 유지)</span>
                        </div>
                        <div className="step-item">
                          {deployStep > 3 ? <span className="step-check">✓</span> : deployStep === 3 ? <span className="step-loading" /> : <span className="step-pending">3</span>}
                          <span>3. 무중단 헬스체크 및 포트 응답 대기</span>
                        </div>
                        <div className="step-item">
                          {deployStep > 4 ? <span className="step-check">✓</span> : deployStep === 4 ? <span className="step-loading" /> : <span className="step-pending">4</span>}
                          <span>4. Nginx 0초 다운타임 트래픽 스위칭 (Nginx Reload)</span>
                        </div>
                        <div className="step-item">
                          {deployStep >= 5 ? <span className="step-check">✓</span> : <span className="step-pending">5</span>}
                          <span>5. 이전 컨테이너 정리 및 외부 터널 확인</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 4. NEW RELEASE NOTICE (READY TO DEPLOY) */}
                  {!isBuilding && busy !== "deploy" && hasNewRelease && (
                    <div className="status-card new" style={{ marginBottom: "16px" }}>
                      <span className="status-icon">📦</span>
                      <div className="status-text">
                        <strong>새로운 버전이 준비되었습니다!</strong>
                        <span>최신 커밋 ({run?.headSha.slice(0, 7)})</span>
                      </div>
                    </div>
                  )}

                  {/* 5. ACTION BUTTONS */}
                  {busy === "deploy" ? (
                    <button className="btn btn-primary" disabled style={{ height: "56px", fontSize: "16px" }}>
                      무중단 배포 진행 중…
                    </button>
                  ) : hasNewRelease ? (
                    <button
                      className="btn btn-primary"
                      style={{ height: "56px", fontSize: "17px" }}
                      onClick={() => void deploy(true)}
                    >
                      🚀 새로운 버전 릴리즈하기
                    </button>
                  ) : activePublicUrl ? (
                    <a
                      className="btn btn-primary"
                      style={{ height: "54px", fontSize: "16px" }}
                      href={activePublicUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      🌐 서비스 바로가기 ↗
                    </a>
                  ) : (
                    <a
                      className="btn btn-primary"
                      style={{ height: "54px", fontSize: "16px" }}
                      href={`http://${savedTarget.host}:${savedTarget.hostPort}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      웹 서비스 열기 ↗
                    </a>
                  )}

                  {/* BOTTOM CONTROLS & DETAILS TOGGLE */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "18px" }}>
                    <button
                      className="btn-link"
                      style={{ fontSize: "13px", color: "var(--text-main)", fontWeight: 700 }}
                      onClick={() => setShowDetails((prev) => !prev)}
                    >
                      배포 진행과정 상세보기 {showDetails ? "▲" : "▼"}
                    </button>

                    <button
                      className="btn-link"
                      disabled={busy !== ""}
                      onClick={() => void deploy(true)}
                    >
                      {busy === "deploy" ? "릴리즈 중…" : "다시 릴리즈"}
                    </button>
                  </div>

                  {/* DETAILS ACCORDION */}
                  {showDetails && (
                    <div className="detail-box">
                      <div style={{ fontSize: "13px", fontWeight: 800, color: "var(--text-main)", marginBottom: "8px" }}>
                        무중단 롤링 배포 진행 과정
                      </div>
                      <div className="progress-steps">
                        <div className="step-item">
                          <span className="step-check">✓</span>
                          <span>Docker Hub 최신 이미지 Pull 완료</span>
                        </div>
                        <div className="step-item">
                          <span className="step-check">✓</span>
                          <span>Blue / Green 슬롯 신규 컨테이너 백그라운드 기동</span>
                        </div>
                        <div className="step-item">
                          <span className="step-check">✓</span>
                          <span>무중단 헬스체크 통과 (HTTP 내부 응답 검증)</span>
                        </div>
                        <div className="step-item">
                          <span className="step-check">✓</span>
                          <span>Nginx 리버스 프록시 0 다운타임 트래픽 스위칭</span>
                        </div>
                        <div className="step-item">
                          <span className="step-check">✓</span>
                          <span>이전 슬롯 컨테이너 안전 종료 (Graceful termination)</span>
                        </div>
                        <div className="step-item">
                          <span className="step-check">✓</span>
                          <span>Cloudflare 인터넷 공개 터널 연결</span>
                        </div>
                      </div>

                      {deployment?.logs && deployment.logs.length > 0 && (
                        <div style={{ marginTop: "12px" }}>
                          <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "6px" }}>실제 배포 로그</div>
                          <div className="log-content">
                            {deployment.logs.map((log, i) => (
                              <div key={i}>{log}</div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div style={{ marginTop: "10px", fontSize: "12px", color: "var(--text-sub)" }}>
                        로컬 내부 주소: http://{savedTarget.host}:{savedTarget.hostPort}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {repository && (
                <>
                  <DatabasePanel
                    repository={repository}
                    refreshKey={databaseRevision}
                    sshTarget={savedTarget ? { username: savedTarget.username, host: savedTarget.host, sshPort: savedTarget.sshPort } : undefined}
                  />
                  <EnvVarsPanel repository={repository} onChange={() => setDatabaseRevision((revision) => revision + 1)} />
                </>
              )}
            </div>
          )}

          <DeploymentHistory records={history} busy={Boolean(busy)} onRollback={rollback} />
        </>
      )}
    </div>
  );
}
