output "db_host" {
  value = google_sql_database_instance.db.public_ip_address
}

output "instance_name" {
  value = google_sql_database_instance.db.name
}

output "database_url" {
  value     = "postgresql://app:${random_password.db.result}@${google_sql_database_instance.db.public_ip_address}:5432/app"
  sensitive = true
}
