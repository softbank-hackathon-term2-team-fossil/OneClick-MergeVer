"use client";

import { useEffect, useState } from "react";

type DatabaseInfo = { kind: "postgres" | "mysql" | "mongo" | "redis"; image: string; managed: boolean };

const LABEL = { postgres: "PostgreSQL", mysql: "MySQL", mongo: "MongoDB", redis: "Redis" } as const;
const PORT = { postgres: 5432, mysql: 3306, mongo: 27017, redis: 6379 } as const;

type Props = {
  repository: string;
  // Changes when the repository is analysed again, so the detected list is reloaded.
  refreshKey?: unknown;
  sshTarget?: { username: string; host: string; sshPort: number };
};

// Databases detected at analysis, run by SBSB next to the on-premises app. Read-only by design:
// what runs is decided by detection; a user's own DATABASE_URL (etc.) switches one off.
export function DatabasePanel({ repository, refreshKey, sshTarget }: Props) {
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [variables, setVariables] = useState<string[]>([]);
  const [passwords, setPasswords] = useState<Partial<Record<DatabaseInfo["kind"], string>>>({});
  const [failure, setFailure] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setFailure("");
      try {
        const query = new URLSearchParams({ repository });
        const response = await fetch(`/api/deploy/databases?${query}`, { signal: controller.signal, cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "DB 정보를 불러오지 못했습니다.");
        setDatabases(data.databases);
        setVariables(data.connectionVariables);
        setPasswords({});
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setFailure(caught instanceof Error ? caught.message : "DB 정보를 불러오지 못했습니다.");
      }
    };
    void load();
    return () => controller.abort();
  }, [repository, refreshKey]);

  const reveal = async (kind: DatabaseInfo["kind"]) => {
    setFailure("");
    try {
      const response = await fetch("/api/deploy/databases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository, kind }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "비밀번호를 확인하지 못했습니다.");
      setPasswords((previous) => ({ ...previous, [kind]: data.password }));
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "비밀번호를 확인하지 못했습니다.");
    }
  };

  if (databases.length === 0) return failure ? <p className="card-desc">{failure}</p> : null;
  const managed = databases.filter((database) => database.managed);
  const tunnelHost = sshTarget ? `${sshTarget.username}@${sshTarget.host}${sshTarget.sshPort !== 22 ? ` -p ${sshTarget.sshPort}` : ""}` : "<사용자>@<서버>";

  return (
    <div style={{ marginTop: "20px", paddingTop: "16px", borderTop: "1px solid var(--border)" }}>
      <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-main)", marginBottom: "6px" }}>🗄️ 데이터베이스 자동 설정</div>
      <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 10px" }}>
        저장소 분석에서 감지된 DB를 배포 서버에 함께 띄우고 앱에 연결합니다. DB는 앱과 따로 유지되어 배포·롤백해도 데이터가 남습니다.
      </p>
      <ul style={{ listStyle: "none", padding: 0, margin: "0 0 10px", display: "grid", gap: "6px" }}>
        {databases.map((database) => (
          <li key={database.kind} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", flexWrap: "wrap" }}>
            <strong>{LABEL[database.kind]}</strong>
            <code style={{ fontSize: "12px", color: "var(--text-muted)" }}>{database.image}</code>
            {!database.managed && <span style={{ fontSize: "12px", color: "var(--text-sub)" }}>직접 넣은 환경변수를 사용 (자동 생성 안 함)</span>}
            {database.managed && database.kind !== "redis" && (passwords[database.kind]
              ? <code style={{ fontSize: "12px", userSelect: "all" }}>{passwords[database.kind]}</code>
              : <button type="button" className="btn-link" onClick={() => void reveal(database.kind)}>비밀번호 보기</button>)}
          </li>
        ))}
      </ul>
      {variables.length > 0 && (
        <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 8px" }}>
          앱에 넣는 연결 환경변수: <code>{variables.join(", ")}</code>
        </p>
      )}
      <ul style={{ fontSize: "12px", color: "var(--text-sub)", margin: 0, paddingLeft: "18px", display: "grid", gap: "4px" }}>
        <li>
          DB 포트는 서버 바깥에 열지 않습니다. 직접 보려면 서버에서 <code>docker ps --filter label=sbsb.app</code>로 DB 컨테이너를 찾고,
          그 IP(<code>{"docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <컨테이너>"}</code>)로 SSH 터널을 여세요
          {managed[0] && <>: <code>ssh -L {PORT[managed[0].kind]}:&lt;컨테이너 IP&gt;:{PORT[managed[0].kind]} {tunnelHost}</code></>}
        </li>
        <li>롤백해도 DB 데이터와 구조는 되돌아가지 않습니다. 테이블 생성·변경(마이그레이션)은 앱이 시작할 때 직접 실행해야 합니다.</li>
        <li>새 버전으로 교체되는 몇 초 동안 이전 버전과 새 버전이 같은 DB를 함께 씁니다.</li>
        <li>배포 서버를 바꾸면 새 서버에는 빈 DB가 만들어집니다. 이전 서버의 데이터는 옮겨지지 않습니다.</li>
      </ul>
      {failure && <p style={{ fontSize: "12px", color: "#e03131", marginTop: "8px" }}>{failure}</p>}
    </div>
  );
}
