output "instance_public_ip" {
  value = oci_core_instance.app.public_ip
}

output "app_url" {
  value = "http://${oci_core_instance.app.public_ip}/"
}

output "db_mode" {
  value = var.db_mode
}

output "db_host" {
  value = local.db_host
}

output "database_url" {
  value     = local.database_url
  sensitive = true
}
