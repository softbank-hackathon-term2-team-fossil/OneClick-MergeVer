# Azure: Container Apps(웹) + Database for PostgreSQL/MySQL Flexible Server(DB)
# 비밀값은 Container Apps의 비밀 저장 영역에 들어가고, 컨테이너에는 환경변수로만 전달된다.

terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "azurerm" {
  features {}
  # 이 템플릿이 쓰는 서비스만 구독에 등록한다.
  resource_provider_registrations = "none"
  resource_providers_to_register = [
    "Microsoft.App",
    "Microsoft.OperationalInsights",
    "Microsoft.DBforPostgreSQL",
    "Microsoft.DBforMySQL",
  ]
}

variable "resource_group" {
  type        = string
  description = "기존 Azure 리소스 그룹. 사이트 서비스 주체가 이미 관리할 수 있는 그룹을 사용한다."
  validation {
    condition     = can(regex("^[A-Za-z0-9._()-]{1,90}$", var.resource_group)) && !endswith(var.resource_group, ".")
    error_message = "resource_group은 Azure 리소스 그룹 이름이어야 합니다."
  }
}

locals {
  name = "sbsb-${var.app_name}"
  tags = { ManagedBy = "sbsb", App = var.app_name }

  db_host = (
    var.db_engine == "postgres" ? azurerm_postgresql_flexible_server.db[0].fqdn :
    var.db_engine == "mysql" ? azurerm_mysql_flexible_server.db[0].fqdn : ""
  )
  # Azure PostgreSQL은 TLS 접속만 받는다.
  db_url_suffix = var.db_engine == "postgres" ? "?sslmode=require" : ""

  plain_env = merge(
    { PORT = tostring(var.port) },
    var.env,
    local.has_db ? {
      DB_HOST = local.db_host
      DB_PORT = tostring(local.db_port)
      DB_NAME = local.db_name
      DB_USER = local.db_user
    } : {}
  )
  secret_names = toset(concat(nonsensitive(keys(var.secret_env)), local.has_db ? ["DATABASE_URL", "DB_PASSWORD"] : []))
  secret_values = merge(var.secret_env, local.has_db ? {
    DATABASE_URL = "${local.db_scheme}://${local.db_user}:${random_password.db[0].result}@${local.db_host}:${local.db_port}/${local.db_name}${local.db_url_suffix}"
    DB_PASSWORD  = random_password.db[0].result
  } : {})
}

data "azurerm_resource_group" "this" {
  name = var.resource_group
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

resource "azurerm_postgresql_flexible_server" "db" {
  count = var.db_engine == "postgres" ? 1 : 0
  # 서버 이름은 Azure 전체에서 겹치면 안 되므로 임의 접미사를 붙인다.
  name                          = "${local.name}-${random_id.db[0].hex}"
  resource_group_name           = azurerm_resource_group.this.name
  location                      = azurerm_resource_group.this.location
  version                       = "16"
  administrator_login           = local.db_user
  administrator_password        = random_password.db[0].result
  sku_name                      = "B_Standard_B1ms"
  storage_mb                    = 32768
  backup_retention_days         = 7
  public_network_access_enabled = true
  tags                          = local.tags

  lifecycle {
    # Azure가 고른 가용 영역을 다음 배포가 바꾸려 들지 않게 한다.
    ignore_changes = [zone]
  }
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  count     = var.db_engine == "postgres" ? 1 : 0
  name      = local.db_name
  server_id = azurerm_postgresql_flexible_server.db[0].id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# 시작·끝이 0.0.0.0인 규칙은 "Azure 내부 서비스의 접속만 허용"을 뜻한다. 인터넷에는 열리지 않는다.
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure" {
  count            = var.db_engine == "postgres" ? 1 : 0
  name             = "allow-azure-services"
  server_id        = azurerm_postgresql_flexible_server.db[0].id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

resource "azurerm_mysql_flexible_server" "db" {
  count                  = var.db_engine == "mysql" ? 1 : 0
  name                   = "${local.name}-${random_id.db[0].hex}"
  resource_group_name    = azurerm_resource_group.this.name
  location               = azurerm_resource_group.this.location
  version                = "8.0.21"
  administrator_login    = local.db_user
  administrator_password = random_password.db[0].result
  sku_name               = "B_Standard_B1ms"
  backup_retention_days  = 7
  tags                   = local.tags

  lifecycle {
    ignore_changes = [zone]
  }
}

resource "azurerm_mysql_flexible_database" "app" {
  count               = var.db_engine == "mysql" ? 1 : 0
  name                = local.db_name
  resource_group_name = azurerm_resource_group.this.name
  server_name         = azurerm_mysql_flexible_server.db[0].name
  charset             = "utf8mb4"
  collation           = "utf8mb4_unicode_ci"
}

resource "azurerm_mysql_flexible_server_firewall_rule" "azure" {
  count               = var.db_engine == "mysql" ? 1 : 0
  name                = "allow-azure-services"
  resource_group_name = azurerm_resource_group.this.name
  server_name         = azurerm_mysql_flexible_server.db[0].name
  start_ip_address    = "0.0.0.0"
  end_ip_address      = "0.0.0.0"
}

# ---------------------------------------------------------------- 웹 서비스

resource "azurerm_log_analytics_workspace" "this" {
  name                = local.name
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

resource "azurerm_container_app_environment" "this" {
  name                       = local.name
  resource_group_name        = azurerm_resource_group.this.name
  location                   = azurerm_resource_group.this.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  tags                       = local.tags
}

resource "azurerm_container_app" "web" {
  name                         = local.name
  resource_group_name          = azurerm_resource_group.this.name
  container_app_environment_id = azurerm_container_app_environment.this.id
  revision_mode                = "Single"
  tags                         = local.tags

  secret {
    name  = "dockerhub-token"
    value = var.dockerhub_token
  }
  dynamic "secret" {
    for_each = local.secret_names
    content {
      name  = lower(replace(secret.key, "_", "-"))
      value = local.secret_values[secret.key]
    }
  }

  registry {
    server               = "docker.io"
    username             = var.dockerhub_username
    password_secret_name = "dockerhub-token"
  }

  ingress {
    external_enabled = true
    target_port      = var.port
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.min_instances
    max_replicas = var.max_instances

    container {
      name   = "app"
      image  = "docker.io/${var.image}"
      cpu    = 0.5
      memory = "1Gi"

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
          name        = env.key
          secret_name = lower(replace(env.key, "_", "-"))
        }
      }

      # 이 경로가 응답해야 새 리비전이 요청을 받기 시작한다.
      startup_probe {
        transport               = "HTTP"
        port                    = var.port
        path                    = var.health_path
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 10
      }
    }
  }

  depends_on = [
    azurerm_postgresql_flexible_server_database.app,
    azurerm_postgresql_flexible_server_firewall_rule.azure,
    azurerm_mysql_flexible_database.app,
    azurerm_mysql_flexible_server_firewall_rule.azure,
  ]
}

# ---------------------------------------------------------------- 결과

output "url" {
  value = "https://${azurerm_container_app.web.ingress[0].fqdn}"
}

output "service" {
  value = azurerm_container_app.web.name
}

output "database" {
  value = (
    var.db_engine == "postgres" ? azurerm_postgresql_flexible_server.db[0].name :
    var.db_engine == "mysql" ? azurerm_mysql_flexible_server.db[0].name : ""
  )
}
