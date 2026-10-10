locals {
  compartment_id = var.compartment_ocid == "" ? var.tenancy_ocid : var.compartment_ocid
}

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

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

resource "oci_core_vcn" "main" {
  compartment_id = local.compartment_id
  display_name   = "${local.name}-vcn"
  cidr_blocks    = ["10.20.0.0/16"]
  dns_label      = "sbsb"
}

resource "oci_core_internet_gateway" "main" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${local.name}-igw"
}

resource "oci_core_route_table" "main" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${local.name}-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.main.id
  }
}

resource "oci_core_security_list" "main" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${local.name}-sl"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  dynamic "ingress_security_rules" {
    for_each = [22, 80, 5432]

    content {
      protocol = "6"
      source   = var.allowed_cidr

      tcp_options {
        min = ingress_security_rules.value
        max = ingress_security_rules.value
      }
    }
  }
}

resource "oci_core_subnet" "main" {
  compartment_id    = local.compartment_id
  vcn_id            = oci_core_vcn.main.id
  display_name      = "${local.name}-subnet"
  cidr_block        = "10.20.1.0/24"
  route_table_id    = oci_core_route_table.main.id
  security_list_ids = [oci_core_security_list.main.id]
  dns_label         = "app"
}

data "oci_core_images" "ubuntu" {
  compartment_id           = local.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "22.04"
  shape                    = var.instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_instance" "app" {
  compartment_id      = local.compartment_id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  display_name        = "${local.name}-vm"
  shape               = var.instance_shape

  shape_config {
    ocpus         = var.instance_ocpus
    memory_in_gbs = var.instance_memory_gb
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu.images[0].id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.main.id
    assign_public_ip = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(var.container_image == "" ? "#!/bin/bash\nexit 0\n" : <<-SCRIPT
      #!/bin/bash
      set -eu
      apt-get update -y
      apt-get install -y docker.io iptables-persistent
      systemctl enable --now docker
      iptables -I INPUT -p tcp --dport 80 -j ACCEPT
      netfilter-persistent save
      docker rm -f sbsb-app >/dev/null 2>&1 || true
      docker run -d --restart unless-stopped --name sbsb-app -p 80:${var.container_port} \
        -e DATABASE_URL='postgresql://app:${random_password.db.result}@${oci_psql_db_system.db.network_details[0].primary_db_endpoint_private_ip}:5432/postgres' \
        ${var.container_image}
    SCRIPT
    )
  }
}

resource "oci_psql_db_system" "db" {
  compartment_id              = local.compartment_id
  display_name                = "${local.name}-pg"
  db_version                  = var.db_version
  shape                       = var.db_shape
  instance_count              = 1
  instance_ocpu_count         = var.db_ocpus
  instance_memory_size_in_gbs = var.db_memory_gb

  network_details {
    subnet_id = oci_core_subnet.main.id
  }

  storage_details {
    is_regionally_durable = false
    system_type           = "OCI_OPTIMIZED_STORAGE"
    availability_domain   = data.oci_identity_availability_domains.ads.availability_domains[0].name
  }

  credentials {
    username = "app"

    password_details {
      password_type = "PLAIN_TEXT"
      password      = random_password.db.result
    }
  }
}
