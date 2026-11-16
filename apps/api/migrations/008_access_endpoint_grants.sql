CREATE TABLE lcit.access_endpoint_grants (
  user_id uuid NOT NULL REFERENCES lcit.users(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES lcit.access_endpoints(id) ON DELETE CASCADE,
  endpoint_config jsonb NOT NULL CHECK (jsonb_typeof(endpoint_config)='object'),
  granted_by uuid NOT NULL REFERENCES lcit.users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint_id)
);
CREATE INDEX access_endpoint_grants_endpoint_idx ON lcit.access_endpoint_grants(endpoint_id);
