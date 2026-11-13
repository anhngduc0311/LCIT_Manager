export class DirectDatabaseConnectionRequired extends Error {
  readonly code = 'DATABASE_DIRECT_CONNECTION_REQUIRED';

  constructor() {
    super('DATABASE_URL must use a direct PostgreSQL endpoint. Disable Neon connection pooling (remove the -pooler hostname suffix); monitoring uses session advisory locks.');
    this.name = 'DirectDatabaseConnectionRequired';
  }
}

/** Do not silently rewrite credentials/hosts: an incompatible endpoint must fail before opening a pool. */
export function requireDirectDatabaseUrl(connectionString: string) {
  let parsed: URL;
  try { parsed = new URL(connectionString); }
  catch { throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must use postgres:// or postgresql://.');
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith('.neon.tech') && hostname.split('.')[0].endsWith('-pooler')) {
    throw new DirectDatabaseConnectionRequired();
  }
  return connectionString;
}
