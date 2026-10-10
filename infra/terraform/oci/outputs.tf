output "instance_public_ip" {
  value = oci_core_instance.app.public_ip
}

output "app_url" {
  value = "http://${oci_core_instance.app.public_ip}/"
}

output "db_endpoint_private_ip" {
  value = oci_psql_db_system.db.network_details[0].primary_db_endpoint_private_ip
}

output "database_url" {
  value     = "postgresql://app:${random_password.db.result}@${oci_psql_db_system.db.network_details[0].primary_db_endpoint_private_ip}:5432/postgres"
  sensitive = true
}
