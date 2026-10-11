resource "random_id" "suffix" {
  byte_length = 3
}

resource "random_password" "db" {
  length  = 24
  special = false
}

locals {
  name = "${var.name_prefix}-${random_id.suffix.hex}"
}

resource "google_sql_database_instance" "db" {
  name                = "${local.name}-pg"
  database_version    = var.db_version
  region              = var.region
  deletion_protection = false

  settings {
    tier    = var.db_tier
    edition = "ENTERPRISE"

    ip_configuration {
      ipv4_enabled = true

      authorized_networks {
        name  = "allowed"
        value = var.authorized_cidr
      }
    }

    backup_configuration {
      enabled = false
    }
  }
}

resource "google_sql_database" "app" {
  name     = "app"
  instance = google_sql_database_instance.db.name
  # The app creates tables owned by this role; dropping the instance removes both.
  deletion_policy = "ABANDON"
}

resource "google_sql_user" "app" {
  name            = "app"
  instance        = google_sql_database_instance.db.name
  password        = random_password.db.result
  deletion_policy = "ABANDON"
}

resource "google_compute_firewall" "http" {
  name    = "${local.name}-http"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["80"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["${local.name}-web"]
}

resource "google_compute_instance" "app" {
  name         = "${local.name}-vm"
  machine_type = var.machine_type
  tags         = ["${local.name}-web"]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 10
    }
  }

  network_interface {
    network = "default"
    access_config {}
  }

  metadata_startup_script = var.container_image == "" ? "#!/bin/bash\nexit 0\n" : <<-SCRIPT
    #!/bin/bash
    set -eu
    if ! command -v docker >/dev/null; then
      apt-get update -y
      apt-get install -y docker.io
    fi
    systemctl enable --now docker
    docker rm -f sbsb-app >/dev/null 2>&1 || true
    docker run -d --restart unless-stopped --name sbsb-app -p 80:${var.container_port} \
      -e DATABASE_URL='postgresql://app:${random_password.db.result}@${google_sql_database_instance.db.public_ip_address}:5432/app' \
      ${var.container_image}
  SCRIPT
}
