# 세 클라우드 템플릿이 똑같이 받는 값. 플랫폼은 이 파일을 각 작업 폴더에 함께 복사한다.
# AI가 정할 수 있는 것은 여기 있는 값뿐이고, 범위를 벗어나면 plan 전에 거부된다.

variable "app_name" {
  type        = string
  description = "자원 이름의 기준이 되는 앱 이름"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}[a-z0-9]$", var.app_name))
    error_message = "app_name은 소문자로 시작하고 소문자·숫자·하이픈만 쓰는 3~21자여야 합니다."
  }
}

variable "image" {
  type        = string
  description = "Docker Hub 이미지 (namespace/repository:tag)"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*:[A-Za-z0-9._-]{1,128}$", var.image))
    error_message = "image는 namespace/repository:tag 형식의 Docker Hub 이미지여야 합니다."
  }
}

variable "port" {
  type        = number
  description = "컨테이너가 요청을 받는 포트"
  validation {
    condition     = var.port >= 1 && var.port <= 65535 && floor(var.port) == var.port
    error_message = "port는 1~65535 사이의 정수여야 합니다."
  }
}

variable "health_path" {
  type        = string
  default     = "/"
  description = "새 버전이 준비됐는지 확인할 HTTP 경로"
  validation {
    condition     = can(regex("^/[A-Za-z0-9._~/-]{0,199}$", var.health_path))
    error_message = "health_path는 /로 시작하는 경로여야 합니다."
  }
}

variable "min_instances" {
  type        = number
  default     = 0
  description = "항상 켜 둘 최소 개수 (0이면 요청이 없을 때 꺼짐)"
  validation {
    condition     = contains([0, 1, 2], var.min_instances)
    error_message = "min_instances는 0, 1, 2 중 하나여야 합니다."
  }
}

variable "max_instances" {
  type        = number
  default     = 2
  description = "요청이 몰릴 때 늘어날 최대 개수"
  validation {
    condition     = var.max_instances >= 1 && var.max_instances <= 5 && floor(var.max_instances) == var.max_instances
    error_message = "max_instances는 1~5 사이의 정수여야 합니다."
  }
}

variable "compute" {
  type        = string
  default     = "serverless"
  description = "실행 방식. 플랫폼이 이 값으로 템플릿 폴더를 고른다 (AWS: serverless=Fargate, vm=EC2)."
  validation {
    condition     = contains(["serverless", "vm"], var.compute)
    error_message = "compute는 serverless, vm 중 하나여야 합니다."
  }
}

variable "db_engine" {
  type        = string
  default     = "none"
  description = "관리형 DB 종류"
  validation {
    condition     = contains(["none", "postgres", "mysql"], var.db_engine)
    error_message = "db_engine은 none, postgres, mysql 중 하나여야 합니다."
  }
}

variable "env" {
  type        = map(string)
  default     = {}
  description = "컨테이너에 그대로 넘길 환경변수"
  validation {
    condition = alltrue([
      for name in keys(var.env) :
      can(regex("^[A-Za-z_][A-Za-z0-9_]{0,63}$", name)) && !contains(["DATABASE_URL", "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"], name)
    ])
    error_message = "env의 이름은 영문·숫자·밑줄만 쓸 수 있고, DATABASE_URL과 DB_* 는 플랫폼이 채우므로 직접 지정할 수 없습니다."
  }
}

variable "secret_env" {
  type        = map(string)
  default     = {}
  sensitive   = true
  description = "비밀 저장소를 거쳐 넘길 환경변수"
  validation {
    condition = alltrue([
      for name in nonsensitive(keys(var.secret_env)) :
      can(regex("^[A-Za-z_][A-Za-z0-9_]{0,63}$", name)) && !contains(["DATABASE_URL", "DB_PASSWORD"], name)
    ])
    error_message = "secret_env의 이름은 영문·숫자·밑줄만 쓸 수 있고, DATABASE_URL과 DB_PASSWORD는 플랫폼이 채웁니다."
  }
}

variable "region" {
  type        = string
  description = "자원을 만들 리전"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,29}$", var.region))
    error_message = "region 형식이 올바르지 않습니다."
  }
}

variable "dockerhub_username" {
  type        = string
  description = "비공개 이미지를 받을 Docker Hub 사용자명"
}

variable "dockerhub_token" {
  type        = string
  sensitive   = true
  description = "Docker Hub 읽기 토큰. 각 클라우드의 비밀 저장소에만 들어간다."
}

locals {
  has_db  = var.db_engine != "none"
  db_port = var.db_engine == "mysql" ? 3306 : 5432
  db_name = "app"
  db_user = "sbsbapp"
  # 드라이버가 공통으로 이해하는 접속 주소의 앞부분. 호스트는 클라우드마다 다르게 붙는다.
  db_scheme = var.db_engine == "mysql" ? "mysql" : "postgresql"
}
