import type { Cloud } from "./spec";

// Reads the machine-readable plan (`terraform show -json`) so that a person approves a list of
// concrete resources, and so that the policy below can refuse a plan before anything is created.
type PlanJson = {
  resource_changes?: { address: string; type: string; name: string; mode?: string; change: { actions: string[] } }[];
};

export type PlanAction = "create" | "update" | "replace" | "delete";
export type PlanChange = { address: string; type: string; action: PlanAction; label: string; billable: boolean; slow: boolean };
export type PlanSummary = { changes: PlanChange[]; counts: Record<PlanAction, number> };

// Every resource type the fixed templates may create. `billable` marks what keeps costing money
// while it exists; `slow` marks what takes minutes to create.
const KNOWN: Record<Cloud, Record<string, { label: string; billable?: boolean; slow?: boolean; database?: boolean }>> = {
  gcp: {
    google_project_service: { label: "필요한 GCP API 사용 설정" },
    google_project_service_identity: { label: "Artifact Registry 서비스 계정" },
    google_secret_manager_secret: { label: "Secret Manager 비밀값" },
    google_secret_manager_secret_version: { label: "비밀값의 값" },
    google_secret_manager_secret_iam_member: { label: "비밀값 읽기 권한" },
    google_artifact_registry_repository: { label: "Docker Hub를 대신 받아 오는 이미지 저장소" },
    google_compute_network: { label: "사설 네트워크" },
    google_compute_subnetwork: { label: "서브넷" },
    google_compute_global_address: { label: "DB용 사설 IP 대역" },
    google_service_networking_connection: { label: "DB 사설 연결", slow: true },
    google_sql_database_instance: { label: "Cloud SQL 인스턴스", billable: true, slow: true, database: true },
    google_sql_database: { label: "데이터베이스", database: true },
    google_sql_user: { label: "DB 사용자" },
    google_service_account: { label: "앱 실행용 서비스 계정" },
    google_cloud_run_v2_service: { label: "Cloud Run 서비스", billable: true },
    google_cloud_run_v2_service_iam_member: { label: "공개 접속 허용" },
    random_id: { label: "이름 접미사" },
    random_password: { label: "DB 비밀번호 (무작위 생성)" },
  },
  azure: {
    azurerm_resource_group: { label: "리소스 그룹" },
    azurerm_log_analytics_workspace: { label: "로그 저장소", billable: true },
    azurerm_container_app_environment: { label: "Container Apps 환경", slow: true },
    azurerm_container_app: { label: "Container App (웹 서비스)", billable: true },
    azurerm_postgresql_flexible_server: { label: "PostgreSQL Flexible Server", billable: true, slow: true, database: true },
    azurerm_postgresql_flexible_server_database: { label: "데이터베이스", database: true },
    azurerm_postgresql_flexible_server_firewall_rule: { label: "DB 방화벽 규칙 (Azure 내부만 허용)" },
    azurerm_mysql_flexible_server: { label: "MySQL Flexible Server", billable: true, slow: true, database: true },
    azurerm_mysql_flexible_database: { label: "데이터베이스", database: true },
    azurerm_mysql_flexible_server_firewall_rule: { label: "DB 방화벽 규칙 (Azure 내부만 허용)" },
    random_id: { label: "이름 접미사" },
    random_password: { label: "DB 비밀번호 (무작위 생성)" },
  },
  aws: {
    aws_vpc: { label: "VPC (사설 네트워크)" },
    aws_internet_gateway: { label: "인터넷 게이트웨이" },
    aws_subnet: { label: "서브넷" },
    aws_route_table: { label: "라우팅 테이블" },
    aws_route_table_association: { label: "서브넷 라우팅 연결" },
    aws_security_group: { label: "보안 그룹 (방화벽)" },
    aws_lb: { label: "로드밸런서 (ALB)", billable: true, slow: true },
    aws_lb_target_group: { label: "로드밸런서 대상 그룹" },
    aws_lb_listener: { label: "로드밸런서 리스너" },
    aws_db_subnet_group: { label: "DB 서브넷 그룹" },
    aws_db_parameter_group: { label: "DB 설정 그룹" },
    aws_db_instance: { label: "RDS 인스턴스", billable: true, slow: true, database: true },
    aws_secretsmanager_secret: { label: "Secrets Manager 비밀값", billable: true },
    aws_secretsmanager_secret_version: { label: "비밀값의 값" },
    aws_cloudwatch_log_group: { label: "로그 그룹" },
    aws_iam_role: { label: "실행 역할" },
    aws_iam_role_policy_attachment: { label: "실행 역할 기본 권한" },
    aws_iam_role_policy: { label: "비밀값 읽기 권한" },
    aws_ecs_cluster: { label: "ECS 클러스터" },
    aws_ecs_task_definition: { label: "컨테이너 실행 정의" },
    aws_ecs_service: { label: "ECS 서비스 (Fargate)", billable: true, slow: true },
    aws_appautoscaling_target: { label: "자동 확장 범위" },
    aws_appautoscaling_policy: { label: "자동 확장 정책" },
    aws_instance: { label: "EC2 서버", billable: true },
    aws_eip: { label: "고정 IP", billable: true },
    aws_iam_instance_profile: { label: "서버 권한 연결" },
    terraform_data: { label: "새 서버 응답 확인 (응답해야 고정 IP를 옮김)" },
    random_password: { label: "DB 비밀번호 (무작위 생성)" },
  },
};

function actionOf(actions: string[]): PlanAction | null {
  const create = actions.includes("create");
  const remove = actions.includes("delete");
  if (create && remove) return "replace";
  if (create) return "create";
  if (remove) return "delete";
  if (actions.includes("update")) return "update";
  return null;
}

function managedChanges(plan: PlanJson) {
  return (plan.resource_changes ?? []).filter((change) => change.mode !== "data");
}

export function summarizePlan(cloud: Cloud, plan: PlanJson): PlanSummary {
  const counts: Record<PlanAction, number> = { create: 0, update: 0, replace: 0, delete: 0 };
  const changes: PlanChange[] = [];
  for (const change of managedChanges(plan)) {
    const action = actionOf(change.change.actions);
    if (!action) continue;
    const known = KNOWN[cloud][change.type];
    counts[action] += 1;
    changes.push({ address: change.address, type: change.type, action, label: known?.label ?? change.type, billable: Boolean(known?.billable), slow: Boolean(known?.slow) });
  }
  return { changes, counts };
}

// The third verifier after `validate` and `plan`. Returns the reasons a plan must not be applied.
export function checkPolicy(cloud: Cloud, plan: PlanJson, options: { destroy?: boolean } = {}): string[] {
  const violations: string[] = [];
  for (const change of managedChanges(plan)) {
    const action = actionOf(change.change.actions);
    if (!action) continue;
    const known = KNOWN[cloud][change.type];
    if (!known) {
      violations.push(`허용 목록에 없는 자원입니다: ${change.address}`);
      continue;
    }
    // A database is created once and survives every later deployment. Only the explicit
    // "delete everything" action may remove it.
    if (known.database && !options.destroy && (action === "delete" || action === "replace")) {
      violations.push(`이 계획은 ${known.label}(${change.address})를 ${action === "replace" ? "새로 만들어 교체" : "삭제"}합니다. 데이터가 사라지므로 일반 배포에서는 허용하지 않습니다.`);
    }
  }
  return violations;
}
