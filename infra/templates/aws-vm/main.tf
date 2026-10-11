# AWS (VM): EC2 한 대 + 고정 IP(웹) + RDS(DB, 사설 서브넷) + Secrets Manager(비밀값)
# 서버가 켜질 때 자기 권한으로 Secrets Manager에서 Docker Hub 토큰과 비밀값을 읽어 컨테이너를 실행한다.
# 네트워크·DB·비밀값의 자원 이름은 Fargate 템플릿(aws/main.tf)과 같아서, 실행 방식을 바꿔도 DB는 그대로 남는다.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws    = { source = "hashicorp/aws", version = ">= 5.60, < 7.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { ManagedBy = "sbsb", App = var.app_name }
  }
}

locals {
  name = "sbsb-${var.app_name}"

  plain_env = merge(
    { PORT = tostring(var.port) },
    var.env,
    local.has_db ? {
      DB_HOST = aws_db_instance.this[0].address
      DB_PORT = tostring(local.db_port)
      DB_NAME = local.db_name
      DB_USER = local.db_user
    } : {}
  )
  secret_names = toset(concat(nonsensitive(keys(var.secret_env)), local.has_db ? ["DATABASE_URL", "DB_PASSWORD"] : []))
  secret_values = merge(var.secret_env, local.has_db ? {
    DATABASE_URL = "${local.db_scheme}://${local.db_user}:${random_password.db[0].result}@${aws_db_instance.this[0].address}:${local.db_port}/${local.db_name}"
    DB_PASSWORD  = random_password.db[0].result
  } : {})

  # 서버가 처음 켜질 때 한 번 실행된다. 비밀값은 여기에 적지 않고, 서버가 실행 중에 직접 읽는다.
  # 이미지·포트·환경변수가 바뀌면 이 내용이 바뀌고, 그러면 서버가 새로 만들어진다 (= 새 버전 배포).
  user_data = join("\n", concat(
    [
      "#!/bin/bash",
      "set -euo pipefail",
      "dnf install -y docker",
      "systemctl enable --now docker",
      "read_secret() { aws secretsmanager get-secret-value --region ${var.region} --secret-id \"$1\" --query SecretString --output text; }",
      "field() { python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' \"$1\"; }",
      "HUB=\"$(read_secret ${aws_secretsmanager_secret.dockerhub.arn})\"",
      "printf '%s' \"$(printf '%s' \"$HUB\" | field password)\" | docker login --username \"$(printf '%s' \"$HUB\" | field username)\" --password-stdin",
      "install -d -m 700 /etc/sbsb",
      "cat > /etc/sbsb/app.env <<'ENVEOF'",
    ],
    [for name in sort(keys(local.plain_env)) : "${name}=${local.plain_env[name]}"],
    ["ENVEOF"],
    [for name in sort(tolist(local.secret_names)) : "printf '%s=%s\\n' ${name} \"$(read_secret ${aws_secretsmanager_secret.env[name].arn})\" >> /etc/sbsb/app.env"],
    [
      "chmod 600 /etc/sbsb/app.env",
      "docker pull docker.io/${var.image}",
      "docker run -d --name app --restart unless-stopped -p 80:${var.port} --env-file /etc/sbsb/app.env --log-driver awslogs --log-opt awslogs-region=${var.region} --log-opt awslogs-group=${aws_cloudwatch_log_group.app.name} docker.io/${var.image}",
      # 비밀값이 바뀌면 이 줄이 바뀌어 서버가 새 값으로 다시 만들어진다.
      "# secret versions: ${join(",", [for name in sort(tolist(local.secret_names)) : aws_secretsmanager_secret_version.env[name].version_id])}",
      "",
    ],
  ))
}

# ---------------------------------------------------------------- 네트워크
# 공개 서브넷: EC2 / 사설 서브넷: RDS (인터넷 경로 없음)

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "this" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  cidr_block              = "10.42.${count.index}.0/24"
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.name}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = "10.42.${count.index + 10}.0/24"
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "${local.name}-private-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# 서버는 HTTP 80번만 받는다. SSH 포트는 열지 않는다.
resource "aws_security_group" "task" {
  name_prefix = "${local.name}-task-"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  lifecycle {
    create_before_destroy = true
  }
}

# ---------------------------------------------------------------- 데이터베이스 (선택)

resource "random_password" "db" {
  count   = local.has_db ? 1 : 0
  length  = 28
  special = false
}

resource "aws_db_subnet_group" "this" {
  count      = local.has_db ? 1 : 0
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "db" {
  count       = local.has_db ? 1 : 0
  name_prefix = "${local.name}-db-"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port       = local.db_port
    to_port         = local.db_port
    protocol        = "tcp"
    security_groups = [aws_security_group.task.id]
  }
  lifecycle {
    create_before_destroy = true
  }
}

# RDS PostgreSQL은 기본으로 SSL 접속을 강제한다. 앱마다 SSL 설정 방식이 달라 같은 DATABASE_URL이
# 다른 환경에서는 되고 여기서는 안 되는 차이가 생기므로, VPC 내부 전용인 이 DB에서는 끈다.
resource "aws_db_parameter_group" "postgres" {
  count       = var.db_engine == "postgres" ? 1 : 0
  name_prefix = "${local.name}-"
  family      = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "0"
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "this" {
  count                   = local.has_db ? 1 : 0
  identifier              = local.name
  engine                  = var.db_engine == "mysql" ? "mysql" : "postgres"
  engine_version          = var.db_engine == "mysql" ? "8.0" : "16"
  instance_class          = "db.t4g.micro"
  allocated_storage       = 20
  storage_encrypted       = true
  db_name                 = local.db_name
  username                = local.db_user
  password                = random_password.db[0].result
  db_subnet_group_name    = aws_db_subnet_group.this[0].name
  vpc_security_group_ids  = [aws_security_group.db[0].id]
  parameter_group_name    = var.db_engine == "postgres" ? aws_db_parameter_group.postgres[0].name : null
  publicly_accessible     = false
  backup_retention_period = 1
  skip_final_snapshot     = true
  apply_immediately       = true
  # 삭제 보호는 플랫폼의 정책 검사가 맡는다 (일반 배포 계획에 DB 삭제가 있으면 거부).
  deletion_protection = false
}

# ---------------------------------------------------------------- 비밀값

resource "aws_secretsmanager_secret" "dockerhub" {
  name                    = "${local.name}/dockerhub"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "dockerhub" {
  secret_id     = aws_secretsmanager_secret.dockerhub.id
  secret_string = jsonencode({ username = var.dockerhub_username, password = var.dockerhub_token })
}

resource "aws_secretsmanager_secret" "env" {
  for_each                = local.secret_names
  name                    = "${local.name}/${each.key}"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "env" {
  for_each      = local.secret_names
  secret_id     = aws_secretsmanager_secret.env[each.key].id
  secret_string = local.secret_values[each.key]
}

# ---------------------------------------------------------------- 서버

resource "aws_cloudwatch_log_group" "app" {
  name              = "/sbsb/${var.app_name}"
  retention_in_days = 14
}

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${local.name}-ec2"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

# 서버가 읽을 수 있는 것은 이 앱의 비밀값뿐이고, 쓸 수 있는 것은 이 앱의 로그뿐이다.
resource "aws_iam_role_policy" "instance" {
  name = "read-secrets-write-logs"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = concat([aws_secretsmanager_secret.dockerhub.arn], [for s in aws_secretsmanager_secret.env : s.arn])
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.app.arn}:*"
      },
    ]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.name}-ec2"
  role = aws_iam_role.instance.name
}

data "aws_ssm_parameter" "ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_instance" "web" {
  ami                         = data.aws_ssm_parameter.ami.value
  instance_type               = "t3.small"
  subnet_id                   = aws_subnet.public[0].id
  vpc_security_group_ids      = [aws_security_group.task.id]
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  user_data                   = local.user_data
  user_data_replace_on_change = true
  tags                        = { Name = local.name }

  metadata_options {
    http_tokens = "required"
  }

  lifecycle {
    # 새 서버를 먼저 만들고, 준비된 뒤에 옛 서버를 지운다.
    create_before_destroy = true
    # Amazon이 새 OS 이미지를 내놓았다는 이유만으로 서버를 교체하지 않는다.
    ignore_changes = [ami]
  }

  depends_on = [
    aws_route_table_association.public,
    aws_iam_role_policy.instance,
    aws_secretsmanager_secret_version.dockerhub,
    aws_secretsmanager_secret_version.env,
  ]
}

# 새 서버의 앱이 응답할 때까지 기다린다. 응답하지 않으면 apply가 여기서 실패하고,
# 고정 IP는 옛 서버에 그대로 남아 이전 버전이 계속 서비스한다.
resource "terraform_data" "ready" {
  triggers_replace = aws_instance.web.id

  provisioner "local-exec" {
    command = "for i in $(seq 1 60); do curl -fsS -o /dev/null -m 5 http://${aws_instance.web.public_ip}${var.health_path} && exit 0; sleep 5; done; echo '새 서버의 앱이 5분 안에 응답하지 않았습니다.' >&2; exit 1"
  }
}

# 서버가 교체돼도 접속 주소가 바뀌지 않도록 고정 IP를 둔다. 새 서버가 준비된 뒤에 옮겨진다.
resource "aws_eip" "web" {
  domain     = "vpc"
  instance   = aws_instance.web.id
  tags       = { Name = local.name }
  depends_on = [aws_internet_gateway.this, terraform_data.ready]
}

# ---------------------------------------------------------------- 결과

output "url" {
  value = "http://${aws_eip.web.public_ip}"
}

output "service" {
  value = aws_instance.web.id
}

output "database" {
  value = local.has_db ? aws_db_instance.this[0].identifier : ""
}
