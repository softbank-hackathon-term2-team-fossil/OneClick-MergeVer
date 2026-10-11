# GCP: Cloud Run(웹) + Cloud SQL(DB, 사설 IP) + Secret Manager(비밀값)
# Docker Hub 비공개 이미지는 Artifact Registry 원격 저장소가 대신 받아 온다.

terraform {
  required_version = ">= 1.5"
  required_providers {
    google      = { source = "hashicorp/google", version = ">= 6.0, < 8.0" }
    google-beta = { source = "hashicorp/google-beta", version = ">= 6.0, < 8.0" }
    random      = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

variable "project_id" {
  type        = string
  description = "GCP 프로젝트 ID"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

locals {
  name   = "sbsb-${var.app_name}"
  labels = { managed-by = "sbsb", app = var.app_name }
  # Cloud Run은 PORT를 직접 정하므로 사용자가 넣은 PORT는 뺀다.
  plain_env = merge(
    { for k, v in var.env : k => v if k != "PORT" },
    local.has_db ? {
      DB_HOST = google_sql_database_instance.db[0].private_ip_address
      DB_PORT = tostring(local.db_port)
      DB_NAME = local.db_name
      DB_USER = local.db_user
    } : {}
  )
  secret_names = toset(concat(nonsensitive(keys(var.secret_env)), local.has_db ? ["DATABASE_URL", "DB_PASSWORD"] : []))
  secret_values = merge(var.secret_env, local.has_db ? {
    DATABASE_URL = "${local.db_scheme}://${local.db_user}:${random_password.db[0].result}@${google_sql_database_instance.db[0].private_ip_address}:${local.db_port}/${local.db_name}"
    DB_PASSWORD  = random_password.db[0].result
  } : {})
}

# ---------------------------------------------------------------- 필요한 API 켜기

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "servicenetworking.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}

# ---------------------------------------------------------------- 이미지 경로 (Docker Hub → Artifact Registry 원격 저장소)

resource "google_secret_manager_secret" "dockerhub" {
  secret_id = "${local.name}-dockerhub-token"
  labels    = local.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "dockerhub" {
  secret      = google_secret_manager_secret.dockerhub.id
  secret_data = var.dockerhub_token
}

# Artifact Registry가 Docker Hub에 로그인할 때 쓰는 서비스 계정
resource "google_project_service_identity" "artifact_registry" {
  provider   = google-beta
  service    = "artifactregistry.googleapis.com"
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "dockerhub" {
  secret_id = google_secret_manager_secret.dockerhub.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_project_service_identity.artifact_registry.member
}

resource "google_artifact_registry_repository" "dockerhub" {
  location      = var.region
  repository_id = "${local.name}-hub"
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"
  labels        = local.labels

  remote_repository_config {
    docker_repository {
      public_repository = "DOCKER_HUB"
    }
    upstream_credentials {
      username_password_credentials {
        username                = var.dockerhub_username
        password_secret_version = google_secret_manager_secret_version.dockerhub.name
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.dockerhub]
}

# ---------------------------------------------------------------- 사설망 (DB가 있을 때만)

resource "google_compute_network" "vpc" {
  count                   = local.has_db ? 1 : 0
  name                    = local.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "run" {
  count         = local.has_db ? 1 : 0
  name          = local.name
  region        = var.region
  network       = google_compute_network.vpc[0].id
  ip_cidr_range = "10.42.0.0/24"
}

resource "google_compute_global_address" "sql" {
  count         = local.has_db ? 1 : 0
  name          = "${local.name}-sql"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.vpc[0].id
}

resource "google_service_networking_connection" "sql" {
  count                   = local.has_db ? 1 : 0
  network                 = google_compute_network.vpc[0].id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql[0].name]
  # 삭제할 때 GCP 쪽 정리가 늦어 실패하는 일이 잦아, 연결 해제는 네트워크 삭제에 맡긴다.
  deletion_policy = "ABANDON"
}

# ---------------------------------------------------------------- 데이터베이스 (선택)

resource "random_id" "db" {
  count       = local.has_db ? 1 : 0
  byte_length = 3
}

resource "random_password" "db" {
  count   = local.has_db ? 1 : 0
  length  = 28
  special = false
}

resource "google_sql_database_instance" "db" {
  count = local.has_db ? 1 : 0
  # Cloud SQL은 지운 이름을 한동안 다시 쓸 수 없어서 임의 접미사를 붙인다.
  name             = "${local.name}-${random_id.db[0].hex}"
  region           = var.region
  database_version = var.db_engine == "mysql" ? "MYSQL_8_0" : "POSTGRES_16"
  # 삭제 보호는 플랫폼의 정책 검사가 맡는다 (일반 배포 계획에 DB 삭제가 있으면 거부).
  deletion_protection = false

  settings {
    edition           = "ENTERPRISE"
    tier              = "db-f1-micro"
    availability_type = "ZONAL"
    disk_size         = 10
    user_labels       = local.labels

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc[0].id
    }
    backup_configuration {
      enabled = true
    }
  }
  depends_on = [google_service_networking_connection.sql]
}

resource "google_sql_database" "app" {
  count           = local.has_db ? 1 : 0
  name            = local.db_name
  instance        = google_sql_database_instance.db[0].name
  deletion_policy = "ABANDON"
}

resource "google_sql_user" "app" {
  count           = local.has_db ? 1 : 0
  name            = local.db_user
  instance        = google_sql_database_instance.db[0].name
  password        = random_password.db[0].result
  deletion_policy = "ABANDON"
}

# ---------------------------------------------------------------- 앱 비밀값

resource "google_secret_manager_secret" "env" {
  for_each  = local.secret_names
  secret_id = "${local.name}-${lower(replace(each.key, "_", "-"))}"
  labels    = local.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "env" {
  for_each    = local.secret_names
  secret      = google_secret_manager_secret.env[each.key].id
  secret_data = local.secret_values[each.key]
}

resource "google_service_account" "run" {
  account_id   = local.name
  display_name = "SBSB ${var.app_name} runtime"
  depends_on   = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "env" {
  for_each  = local.secret_names
  secret_id = google_secret_manager_secret.env[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.run.member
}

# ---------------------------------------------------------------- 웹 서비스

resource "google_cloud_run_v2_service" "web" {
  name                = local.name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  labels              = local.labels

  template {
    service_account = google_service_account.run.email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    dynamic "vpc_access" {
      for_each = local.has_db ? [1] : []
      content {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.vpc[0].id
          subnetwork = google_compute_subnetwork.run[0].id
        }
      }
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.dockerhub.repository_id}/${var.image}"

      ports {
        container_port = var.port
      }
      resources {
        limits = { cpu = "1", memory = "1Gi" }
      }

      dynamic "env" {
        for_each = local.plain_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_names
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.env[env.key].secret_id
              version = "latest"
            }
          }
        }
      }

      # 이 경로가 응답해야 새 리비전으로 트래픽이 넘어간다. 실패하면 이전 리비전이 계속 받는다.
      startup_probe {
        period_seconds    = 5
        timeout_seconds   = 3
        failure_threshold = 36
        http_get {
          path = var.health_path
          port = var.port
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.env,
    google_secret_manager_secret_iam_member.env,
    google_sql_user.app,
    google_sql_database.app,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.web.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---------------------------------------------------------------- 결과

output "url" {
  value = google_cloud_run_v2_service.web.uri
}

output "service" {
  value = google_cloud_run_v2_service.web.name
}

output "database" {
  value = local.has_db ? google_sql_database_instance.db[0].name : ""
}
