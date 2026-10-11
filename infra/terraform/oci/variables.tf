variable "tenancy_ocid" {
  type = string
}

variable "user_ocid" {
  type = string
}

variable "fingerprint" {
  type = string
}

variable "private_key_path" {
  type        = string
  description = "OCI API signing private key (not the SSH key)."
}

variable "region" {
  type = string
}

variable "compartment_ocid" {
  type        = string
  default     = ""
  description = "Empty uses the tenancy root compartment."
}

variable "name_prefix" {
  type    = string
  default = "sbsb"
}

variable "ssh_public_key" {
  type        = string
  description = "Public key installed for the ubuntu user on the VM."
}

variable "instance_shape" {
  type    = string
  default = "VM.Standard.A1.Flex"
}

variable "instance_ocpus" {
  type    = number
  default = 1
}

variable "instance_memory_gb" {
  type    = number
  default = 6
}

variable "container_image" {
  type    = string
  default = ""
}

variable "container_port" {
  type    = number
  default = 8000
}

variable "allowed_cidr" {
  type    = string
  default = "0.0.0.0/0"
}

variable "db_mode" {
  type        = string
  default     = "managed"
  description = "managed = OCI Database with PostgreSQL, container = PostgreSQL container on the VM."

  validation {
    condition     = contains(["managed", "container"], var.db_mode)
    error_message = "db_mode must be managed or container."
  }
}

variable "db_version" {
  type    = string
  default = "16"
}

# The E4 shapes count against dbsystem-count, which is 0 on this tenancy; E5/E6 have their own limits.
variable "db_shape" {
  type    = string
  default = "PostgreSQL.VM.Standard.E5.Flex"
}

variable "db_ocpus" {
  type    = number
  default = 1
}

variable "db_memory_gb" {
  type    = number
  default = 16
}
