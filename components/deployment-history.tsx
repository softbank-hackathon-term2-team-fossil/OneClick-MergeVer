"use client";

import type { DeploymentRecord } from "@/lib/types";

const TARGET_LABEL = { ONPREM: "온프레미스", AWS: "AWS", AZURE: "Azure", CLOUD_RUN: "Cloud Run" } as const;
const STATUS_LABEL = { RUNNING: "진행 중", SUCCESS: "성공", FAILED: "실패" } as const;

type Props = {
  records: DeploymentRecord[];
  busy: boolean;
  onRollback: (record: DeploymentRecord) => void;
};

// Deployment history of the selected repository, with one-click rollback for past on-premises versions.
export function DeploymentHistory({ records, busy, onRollback }: Props) {
  if (!records.length) return null;
  return (
    <div className="card">
      <h3 className="card-title">배포 이력</h3>
      <p className="card-desc">이 저장소의 최근 배포입니다. 온프레미스의 이전 버전은 바로 되돌릴 수 있습니다.</p>
      <ul className="history-list">
        {records.map((record) => (
          <li className="history-item" key={record.id}>
            <div className="history-main">
              <strong>#{record.number}</strong>
              <span className="history-target">{TARGET_LABEL[record.target]}</span>
              <span className={`history-status ${record.status.toLowerCase()}`}>
                {record.current ? "서비스 중" : STATUS_LABEL[record.status]}
              </span>
              {record.trigger === "ROLLBACK" && <span className="history-target">되돌리기</span>}
            </div>
            <div className="history-meta">
              <code>{record.imageTag.slice(0, 12)}</code>
              {record.destination && <span> · {record.destination}</span>}
              <span> · {new Date(record.startedAt).toLocaleString("ko-KR")}</span>
            </div>
            {record.status === "FAILED" && record.failureReason && (
              <div className="history-meta history-error">{record.failureReason.slice(0, 200)}</div>
            )}
            {record.current && record.url && (
              <a className="history-meta url-link" href={record.url} target="_blank" rel="noreferrer">{record.url}</a>
            )}
            {record.canRollback && (
              <button type="button" className="pill-btn" disabled={busy} onClick={() => onRollback(record)}>
                이 버전으로 되돌리기
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
