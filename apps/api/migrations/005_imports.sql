CREATE TABLE lcit.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES lcit.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  file_name text NOT NULL,
  workbook jsonb NOT NULL,
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'previewed', 'completed')),
  preview_version integer NOT NULL DEFAULT 0,
  mapping jsonb,
  result jsonb
);
CREATE TABLE lcit.import_rows (
  batch_id uuid NOT NULL REFERENCES lcit.import_batches(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  preview jsonb NOT NULL,
  decision text NOT NULL CHECK (decision IN ('create', 'merge', 'skip')),
  result jsonb,
  PRIMARY KEY (batch_id, row_number)
);
