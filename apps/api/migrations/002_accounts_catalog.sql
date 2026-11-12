CREATE TABLE lcit.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  version integer NOT NULL DEFAULT 1,
  archived_at timestamptz
);

CREATE TABLE lcit.data_centers (LIKE lcit.organizations INCLUDING ALL);

CREATE TABLE lcit.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'leader', 'specialist')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked')),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE lcit.sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES lcit.users(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON lcit.sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE lcit.login_throttles (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL
);
CREATE INDEX login_throttles_window_idx ON lcit.login_throttles (window_start);

CREATE TABLE lcit.user_organizations (
  user_id uuid NOT NULL REFERENCES lcit.users(id),
  organization_id uuid NOT NULL REFERENCES lcit.organizations(id),
  PRIMARY KEY (user_id, organization_id)
);

CREATE TABLE lcit.applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  organization_id uuid NOT NULL REFERENCES lcit.organizations(id),
  owner_id uuid REFERENCES lcit.users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  service_type text NOT NULL CHECK (service_type IN ('ordered', 'monitoring', 'operations')),
  version integer NOT NULL DEFAULT 1,
  archived_at timestamptz
);
CREATE INDEX applications_organization_idx ON lcit.applications (organization_id);

CREATE TABLE lcit.app_assignments (
  user_id uuid NOT NULL REFERENCES lcit.users(id),
  application_id uuid NOT NULL REFERENCES lcit.applications(id),
  PRIMARY KEY (user_id, application_id)
);

CREATE TABLE lcit.databases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  organization_id uuid NOT NULL REFERENCES lcit.organizations(id),
  owner_id uuid REFERENCES lcit.users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  engine text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  archived_at timestamptz
);
CREATE INDEX databases_organization_idx ON lcit.databases (organization_id);

CREATE TABLE lcit.app_databases (
  application_id uuid NOT NULL REFERENCES lcit.applications(id),
  database_id uuid NOT NULL REFERENCES lcit.databases(id),
  PRIMARY KEY (application_id, database_id)
);
CREATE INDEX app_databases_database_idx ON lcit.app_databases (database_id, application_id);

CREATE TABLE lcit.servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  hostname text NOT NULL,
  data_center_id uuid NOT NULL REFERENCES lcit.data_centers(id),
  operating_system text,
  configuration text,
  notes text,
  version integer NOT NULL DEFAULT 1,
  archived_at timestamptz
);
CREATE INDEX servers_data_center_idx ON lcit.servers (data_center_id);
CREATE INDEX servers_hostname_idx ON lcit.servers (lower(hostname));

CREATE TABLE lcit.server_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES lcit.servers(id),
  address inet NOT NULL CHECK (masklen(address) IN (32, 128) AND
    masklen(address) = CASE family(address) WHEN 4 THEN 32 ELSE 128 END),
  network_scope text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('private', 'public', 'nat')),
  UNIQUE (server_id, address, network_scope, kind)
);
CREATE UNIQUE INDEX private_address_scope_idx ON lcit.server_addresses (network_scope, address)
  WHERE kind = 'private';
CREATE INDEX server_addresses_address_idx ON lcit.server_addresses (address);

CREATE TABLE lcit.access_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES lcit.servers(id),
  protocol text NOT NULL CHECK (protocol IN ('ssh', 'rdp')),
  host text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  UNIQUE (server_id, protocol, host, port)
);

CREATE TABLE lcit.app_servers (
  application_id uuid NOT NULL REFERENCES lcit.applications(id),
  server_id uuid NOT NULL REFERENCES lcit.servers(id),
  PRIMARY KEY (application_id, server_id)
);
CREATE INDEX app_servers_server_idx ON lcit.app_servers (server_id, application_id);

CREATE TABLE lcit.domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (name = lower(name) AND right(name, 1) <> '.'),
  renewal_date date,
  version integer NOT NULL DEFAULT 1,
  archived_at timestamptz
);

CREATE TABLE lcit.dns_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id uuid NOT NULL REFERENCES lcit.domains(id),
  host text NOT NULL,
  type text NOT NULL,
  target text NOT NULL,
  UNIQUE (domain_id, host, type, target)
);

CREATE TABLE lcit.tls_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id uuid NOT NULL REFERENCES lcit.domains(id),
  host text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  sni text NOT NULL DEFAULT '',
  manual_expiry_date date,
  observed_expiry_at timestamptz,
  UNIQUE (domain_id, host, port, sni)
);

CREATE TABLE lcit.app_domains (
  application_id uuid NOT NULL REFERENCES lcit.applications(id),
  domain_id uuid NOT NULL REFERENCES lcit.domains(id),
  PRIMARY KEY (application_id, domain_id)
);
CREATE INDEX app_domains_domain_idx ON lcit.app_domains (domain_id, application_id);

CREATE TABLE lcit.app_dns_records (
  application_id uuid NOT NULL REFERENCES lcit.applications(id),
  dns_record_id uuid NOT NULL REFERENCES lcit.dns_records(id),
  PRIMARY KEY (application_id, dns_record_id)
);
CREATE INDEX app_dns_records_record_idx ON lcit.app_dns_records (dns_record_id, application_id);

CREATE TABLE lcit.domain_servers (
  domain_id uuid NOT NULL REFERENCES lcit.domains(id),
  server_id uuid NOT NULL REFERENCES lcit.servers(id),
  PRIMARY KEY (domain_id, server_id)
);

CREATE TABLE lcit.audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES lcit.users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  related_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  request_id uuid NOT NULL
);
CREATE INDEX audit_events_target_idx ON lcit.audit_events (target_type, target_id, occurred_at DESC);
