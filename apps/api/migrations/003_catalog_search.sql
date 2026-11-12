CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX applications_search_name_idx ON lcit.applications USING gin (name gin_trgm_ops)
  WHERE archived_at IS NULL;
CREATE INDEX organizations_search_name_idx ON lcit.organizations USING gin (name gin_trgm_ops)
  WHERE archived_at IS NULL;
CREATE INDEX dns_records_host_idx ON lcit.dns_records (host);
CREATE INDEX domain_servers_server_idx ON lcit.domain_servers (server_id, domain_id);
