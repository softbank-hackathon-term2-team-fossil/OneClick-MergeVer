# Read-only: lists the VM instances of a compartment so the app can offer "deploy to an existing VM".
terraform {
  required_version = ">= 1.5"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
  }
}

variable "tenancy_ocid" { type = string }
variable "user_ocid" { type = string }
variable "fingerprint" { type = string }
variable "private_key_path" { type = string }
variable "region" { type = string }

variable "compartment_ocid" {
  type    = string
  default = ""
}

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}

locals {
  compartment_id = var.compartment_ocid == "" ? var.tenancy_ocid : var.compartment_ocid
}

data "oci_core_instances" "all" {
  compartment_id = local.compartment_id
}

data "oci_core_vnic_attachments" "all" {
  compartment_id = local.compartment_id
}

data "oci_core_vnic" "each" {
  for_each = { for a in data.oci_core_vnic_attachments.all.vnic_attachments : a.instance_id => a.vnic_id if a.vnic_id != null && a.state == "ATTACHED" }
  vnic_id  = each.value
}

output "instances" {
  value = [
    for i in data.oci_core_instances.all.instances : {
      id            = i.id
      name          = i.display_name
      state         = i.state
      shape         = i.shape
      publicAddress = try(data.oci_core_vnic.each[i.id].public_ip_address, null)
    } if i.state != "TERMINATED" && i.state != "TERMINATING"
  ]
}
