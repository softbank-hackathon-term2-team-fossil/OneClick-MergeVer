# AWS: ECS Fargate + ALB(웹) + RDS(DB, 사설 서브넷) + Secrets Manager(비밀값)
# Fargate가 Secrets Manager의 Docker Hub 토큰으로 비공개 이미지를 직접 받는다.

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

  container = {
    name      = "app"
    image     = "docker.io/${var.image}"
    essential = true
    repositoryCredentials = {
      credentialsParameter = aws_secretsmanager_secret.dockerhub.arn
    }
    portMappings = [{
      containerPort = var.port
      protocol      = "tcp"
    }]
    environment = [for k in sort(keys(local.plain_env)) : { name = k, value = local.plain_env[k] }]
    secrets     = [for k in sort(tolist(local.secret_names)) : { name = k, valueFrom = aws_secretsmanager_secret.env[k].arn }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "app"
      }
    }
  }
}

# ---------------------------------------------------------------- 네트워크
# 공개 서브넷: ALB와 Fargate 태스크 / 사설 서브넷: RDS (인터넷 경로 없음)

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

resource "aws_security_group" "alb" {
  name_prefix = "${local.name}-alb-"
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

# 태스크는 ALB에서 오는 요청만 받는다
resource "aws_security_group" "task" {
  name_prefix = "${local.name}-task-"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port       = var.port
    to_port         = var.port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
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

# ---------------------------------------------------------------- 로드밸런서

resource "aws_lb" "this" {
  name               = local.name
  load_balancer_type = "application"
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_lb_target_group" "app" {
  name_prefix          = "sbsb-"
  port                 = var.port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.this.id
  deregistration_delay = 15

  health_check {
    path                = var.health_path
    matcher             = "200-399"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
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

# ---------------------------------------------------------------- 컨테이너 실행

resource "aws_cloudwatch_log_group" "app" {
  name              = "/sbsb/${var.app_name}"
  retention_in_days = 14
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "secrets" {
  name = "read-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = concat([aws_secretsmanager_secret.dockerhub.arn], [for s in aws_secretsmanager_secret.env : s.arn])
    }]
  })
}

resource "aws_ecs_cluster" "this" {
  name = local.name
}

resource "aws_ecs_task_definition" "app" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([local.container])
}

resource "aws_ecs_service" "app" {
  name            = local.name
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.app.arn
  # Fargate는 0개로 줄일 수 없어 최소 1개를 유지한다.
  desired_count                     = max(1, var.min_instances)
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 120
  # 새 태스크가 헬스 체크를 통과할 때까지 apply가 기다린다.
  wait_for_steady_state = true

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = var.port
  }

  # 새 버전이 기동에 실패하면 ECS가 직전 버전으로 되돌린다
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    # 오토스케일링이 조정한 개수를 다음 배포가 되돌리지 않게 한다
    ignore_changes = [desired_count]
  }

  depends_on = [
    aws_lb_listener.http,
    aws_iam_role_policy_attachment.execution,
    aws_iam_role_policy.secrets,
    aws_secretsmanager_secret_version.dockerhub,
    aws_secretsmanager_secret_version.env,
  ]
}

# ---------------------------------------------------------------- 오토스케일링

resource "aws_appautoscaling_target" "app" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = max(1, var.min_instances)
  max_capacity       = max(1, var.min_instances, var.max_instances)
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${local.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.app.service_namespace
  resource_id        = aws_appautoscaling_target.app.resource_id
  scalable_dimension = aws_appautoscaling_target.app.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# ---------------------------------------------------------------- 결과

output "url" {
  value = "http://${aws_lb.this.dns_name}"
}

output "service" {
  value = aws_ecs_service.app.name
}

output "database" {
  value = local.has_db ? aws_db_instance.this[0].identifier : ""
}
