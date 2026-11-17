-- Run as lcit_owner after restore/migration. Roles must already exist on this cluster.
-- The backup intentionally omits cluster roles, ownership and ACLs.
GRANT USAGE ON SCHEMA lcit TO lcit_readwrite;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA lcit TO lcit_readwrite;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA lcit TO lcit_readwrite;
ALTER DEFAULT PRIVILEGES FOR ROLE lcit_owner IN SCHEMA lcit
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lcit_readwrite;
ALTER DEFAULT PRIVILEGES FOR ROLE lcit_owner IN SCHEMA lcit
  GRANT USAGE, SELECT ON SEQUENCES TO lcit_readwrite;
