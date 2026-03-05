#!/bin/sh
set -e

echo "[entrypoint] Starting Arachne Gateway..."

# Run migrations if DATABASE_URL is set
if [ -n "$DATABASE_URL" ]; then
  echo "[entrypoint] Running database migrations..."
  npm run migrate:up
  echo "[entrypoint] Migrations completed"
else
  echo "[entrypoint] WARNING: DATABASE_URL not set, skipping migrations"
fi

# Start the application
echo "[entrypoint] Starting application..."
exec "$@"
