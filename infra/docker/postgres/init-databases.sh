#!/bin/bash
# Creates one database per microservice. This enforces database-per-service
# ownership even though dev runs a single Postgres container.
# In AWS each service gets its own Aurora PostgreSQL database (or cluster).
set -e
for db in auth_db course_db enrollment_db payment_db progress_db quiz_db media_db \
          notification_db lab_db certificate_db analytics_db user_db; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-SQL
    SELECT 'CREATE DATABASE $db'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$db')\gexec
SQL
  echo "database ready: $db"
done
