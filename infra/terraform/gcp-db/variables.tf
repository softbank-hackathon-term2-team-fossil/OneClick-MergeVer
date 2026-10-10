variable "project_id" {
  type = string
}

variable "credentials_file" {
  type    = string
  default = ""
}

variable "region" {
  type    = string
  default = "us-central1"
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
  type    = string
  default = "db-f1-micro"
}

variable "authorized_cidr" {
  type        = string
  default     = "0.0.0.0/0"
  description = "Cloud Run egress addresses are not fixed, so tests allow every address. Narrow this for real use."
}
