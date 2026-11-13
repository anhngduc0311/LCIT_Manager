ALTER TABLE lcit.check_runs DROP CONSTRAINT check_runs_status_check;
ALTER TABLE lcit.check_runs DROP CONSTRAINT check_runs_check1;
ALTER TABLE lcit.check_runs ADD CONSTRAINT check_runs_status_check
  CHECK (status IN ('success', 'dns_error', 'timeout', 'tls_error', 'expired', 'blocked'));
ALTER TABLE lcit.check_runs ADD CONSTRAINT check_runs_target_check CHECK (
  (check_type='dns' AND dns_record_id IS NOT NULL AND tls_endpoint_id IS NULL
    AND status IN ('success','dns_error','timeout','blocked') AND observed_expiry_at IS NULL)
  OR (check_type='tls' AND tls_endpoint_id IS NOT NULL AND dns_record_id IS NULL));

-- Nothing is enabled implicitly: each endpoint needs an administrator's approval of its exact configuration.
CREATE TABLE lcit.monitoring_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_type text NOT NULL CHECK (check_type IN ('dns','tls')),
  dns_record_id uuid UNIQUE REFERENCES lcit.dns_records(id),
  tls_endpoint_id uuid UNIQUE REFERENCES lcit.tls_endpoints(id),
  enabled boolean NOT NULL,
  approved_config jsonb NOT NULL CHECK (jsonb_typeof(approved_config)='object'),
  approved_by uuid NOT NULL REFERENCES lcit.users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  health text NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown','up','down')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures BETWEEN 0 AND 2),
  last_check_run_id uuid REFERENCES lcit.check_runs(id),
  CHECK ((check_type='dns' AND dns_record_id IS NOT NULL AND tls_endpoint_id IS NULL)
    OR (check_type='tls' AND tls_endpoint_id IS NOT NULL AND dns_record_id IS NULL)),
  FOREIGN KEY (last_check_run_id,dns_record_id) REFERENCES lcit.check_runs(id,dns_record_id),
  FOREIGN KEY (last_check_run_id,tls_endpoint_id) REFERENCES lcit.check_runs(id,tls_endpoint_id)
);
CREATE INDEX monitoring_targets_enabled_idx ON lcit.monitoring_targets (id) WHERE enabled;
