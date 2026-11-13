-- Execution history is separate from per-endpoint DNS/TLS observations.
CREATE TABLE lcit.monitoring_jobs (
  key text PRIMARY KEY CHECK (key IN ('expiry', 'dns_tls')),
  last_run_id uuid,
  last_success_at timestamptz
);
INSERT INTO lcit.monitoring_jobs (key) VALUES ('expiry'), ('dns_tls');

CREATE TABLE lcit.monitoring_job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_key text NOT NULL REFERENCES lcit.monitoring_jobs(key),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
  error_code text CHECK (error_code ~ '^[A-Z0-9_]{1,64}$'),
  CHECK ((status = 'running' AND finished_at IS NULL AND error_code IS NULL)
    OR (status = 'succeeded' AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (status IN ('failed', 'interrupted') AND finished_at IS NOT NULL AND error_code IS NOT NULL)),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  UNIQUE (job_key, id)
);
ALTER TABLE lcit.monitoring_jobs ADD CONSTRAINT monitoring_jobs_last_run_fk
  FOREIGN KEY (key, last_run_id) REFERENCES lcit.monitoring_job_runs(job_key, id);
CREATE INDEX monitoring_job_runs_history_idx ON lcit.monitoring_job_runs (job_key, started_at DESC);

CREATE TABLE lcit.check_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_run_id uuid NOT NULL REFERENCES lcit.monitoring_job_runs(id),
  check_type text NOT NULL CHECK (check_type IN ('dns', 'tls')),
  dns_record_id uuid REFERENCES lcit.dns_records(id),
  tls_endpoint_id uuid REFERENCES lcit.tls_endpoints(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('success', 'dns_error', 'timeout', 'tls_error', 'expired')),
  resolved_addresses inet[] NOT NULL DEFAULT '{}',
  observed_expiry_at timestamptz,
  error_code text CHECK (error_code ~ '^[A-Z0-9_]{1,64}$'),
  CHECK (finished_at >= started_at),
  CHECK ((check_type = 'dns' AND dns_record_id IS NOT NULL AND tls_endpoint_id IS NULL
      AND status IN ('success', 'dns_error', 'timeout') AND observed_expiry_at IS NULL)
    OR (check_type = 'tls' AND tls_endpoint_id IS NOT NULL AND dns_record_id IS NULL)),
  CHECK (status <> 'expired' OR observed_expiry_at IS NOT NULL),
  UNIQUE (id, dns_record_id),
  UNIQUE (id, tls_endpoint_id)
);
CREATE UNIQUE INDEX check_runs_dns_run_key ON lcit.check_runs (job_run_id, dns_record_id) WHERE check_type = 'dns';
CREATE UNIQUE INDEX check_runs_tls_run_key ON lcit.check_runs (job_run_id, tls_endpoint_id) WHERE check_type = 'tls';
CREATE INDEX check_runs_dns_history_idx ON lcit.check_runs (dns_record_id, finished_at DESC) WHERE check_type = 'dns';
CREATE INDEX check_runs_tls_history_idx ON lcit.check_runs (tls_endpoint_id, finished_at DESC) WHERE check_type = 'tls';

CREATE TABLE lcit.alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('expiry', 'outage', 'recovery')),
  source text NOT NULL CHECK (source IN ('manual_domain', 'manual_tls', 'observed_tls', 'dns', 'tls')),
  domain_id uuid REFERENCES lcit.domains(id),
  dns_record_id uuid REFERENCES lcit.dns_records(id),
  tls_endpoint_id uuid REFERENCES lcit.tls_endpoints(id),
  resource_type text GENERATED ALWAYS AS (CASE WHEN domain_id IS NOT NULL THEN 'domain'
    WHEN dns_record_id IS NOT NULL THEN 'dns_record' ELSE 'tls_endpoint' END) STORED,
  resource_id uuid GENERATED ALWAYS AS (COALESCE(domain_id, dns_record_id, tls_endpoint_id)) STORED,
  expiry_date date,
  -- 0 denotes overdue; day zero itself still belongs to the 7-day threshold.
  threshold_days integer CHECK (threshold_days IN (0, 7, 14, 30, 90)),
  check_run_id uuid REFERENCES lcit.check_runs(id),
  -- Stable identity of a state transition, reused on retries by the T3.3 worker.
  transition_key uuid,
  FOREIGN KEY (check_run_id, dns_record_id) REFERENCES lcit.check_runs(id, dns_record_id),
  FOREIGN KEY (check_run_id, tls_endpoint_id) REFERENCES lcit.check_runs(id, tls_endpoint_id),
  CHECK (num_nonnulls(domain_id, dns_record_id, tls_endpoint_id) = 1),
  CHECK ((kind = 'expiry' AND expiry_date IS NOT NULL AND threshold_days IS NOT NULL AND transition_key IS NULL
      AND ((source = 'manual_domain' AND domain_id IS NOT NULL)
        OR (source IN ('manual_tls', 'observed_tls') AND tls_endpoint_id IS NOT NULL)))
    OR (kind IN ('outage', 'recovery') AND expiry_date IS NULL AND threshold_days IS NULL AND transition_key IS NOT NULL
      AND check_run_id IS NOT NULL AND ((source = 'dns' AND dns_record_id IS NOT NULL)
        OR (source = 'tls' AND tls_endpoint_id IS NOT NULL))))
);
CREATE UNIQUE INDEX alerts_expiry_key ON lcit.alerts (resource_type, resource_id, source, expiry_date, threshold_days)
  WHERE kind = 'expiry';
CREATE UNIQUE INDEX alerts_transition_key ON lcit.alerts (resource_type, resource_id, source, transition_key)
  WHERE kind IN ('outage', 'recovery');
CREATE INDEX alerts_resource_history_idx ON lcit.alerts (resource_type, resource_id, created_at DESC);
CREATE INDEX alerts_created_idx ON lcit.alerts (created_at DESC, id);

CREATE TABLE lcit.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES lcit.alerts(id),
  recipient_id uuid NOT NULL REFERENCES lcit.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (alert_id, recipient_id)
);
CREATE INDEX notifications_recipient_history_idx ON lcit.notifications (recipient_id, created_at DESC, id);
CREATE INDEX notifications_recipient_unread_idx ON lcit.notifications (recipient_id, created_at DESC, id) WHERE read_at IS NULL;
