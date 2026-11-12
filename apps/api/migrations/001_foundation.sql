CREATE SCHEMA IF NOT EXISTS lcit;

CREATE TABLE IF NOT EXISTS lcit.schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
