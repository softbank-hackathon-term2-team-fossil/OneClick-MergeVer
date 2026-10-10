variable "project_id" {
  type        = string
  description = "GCP project ID."
}

variable "credentials_file" {
  type        = string
  default     = ""
  description = "Service account key path. Empty uses Application Default Credentials."
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

variable "name_prefix" {
  type    = string
  default = "sbsb"
}

variable "db_version" {
  type    = string
  default = "POSTGRES_16"
}

variable "db_tier" {
  type        = string
  default     = "db-f1-micro"
  description = "Cloud SQL machine tier. db-f1-micro is the smallest shared-core tier."
}

variable "machine_type" {
  type    = string
  default = "e2-micro"
}

variable "container_image" {
  type        = string
  default     = ""
  description = "Docker image the VM runs on port 80. Empty leaves the VM without an app."
}

variable "container_port" {
  type    = number
  default = 8000
}

variable "authorized_cidr" {
  type        = string
  default     = "0.0.0.0/0"
  description = "CIDR allowed to reach the database. Narrow this outside of short tests."
}
