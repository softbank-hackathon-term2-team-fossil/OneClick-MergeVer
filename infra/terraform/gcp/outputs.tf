output "instance_public_ip" {
  value = google_compute_instance.app.network_interface[0].access_config[0].nat_ip
}

output "app_url" {
  value = "http://${google_compute_instance.app.network_interface[0].access_config[0].nat_ip}/"
}

output "db_host" {
  value = google_sql_database_instance.db.public_ip_address
}

output "database_url" {
  value     = "postgresql://app:${random_password.db.result}@${google_sql_database_instance.db.public_ip_address}:5432/app"
  sensitive = true
}
