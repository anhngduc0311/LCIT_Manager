-- Sensitive actions that leaders and specialists receive only when an administrator grants them (D-01).
CREATE TABLE lcit.user_permissions (
  user_id uuid NOT NULL REFERENCES lcit.users(id),
  permission text NOT NULL CHECK (permission IN ('attachments.download', 'reports.export')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);

-- File content lives in the private file store under storage_key. A row stays pending until the
-- content is durably written; only available rows are served. Cleanup removes stale pending rows.
CREATE TABLE lcit.attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES lcit.applications(id),
  storage_key text NOT NULL UNIQUE CHECK (storage_key ~ '^[0-9a-f]{64}$'),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  media_type text NOT NULL,
  size_bytes bigint CHECK (size_bytes > 0),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'available')),
  uploaded_by uuid NOT NULL REFERENCES lcit.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz,
  archived_at timestamptz,
  CHECK (status = 'pending' OR (size_bytes IS NOT NULL AND sha256 IS NOT NULL AND available_at IS NOT NULL))
);
CREATE INDEX attachments_application_idx ON lcit.attachments (application_id, created_at DESC)
  WHERE status = 'available' AND archived_at IS NULL;
CREATE INDEX attachments_pending_idx ON lcit.attachments (created_at) WHERE status = 'pending';
