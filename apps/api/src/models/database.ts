import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';

export function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required.');
  }

  return new Pool({
    connectionString,
    enableChannelBinding: true,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    max: 5,
  });
}

@Injectable()
export class Database implements OnModuleDestroy {
  private readonly logger = new Logger(Database.name);
  private readonly pool = process.env.DATABASE_URL ? createPool() : undefined;

  constructor() {
    this.pool?.on('error', () => this.logger.warn('An idle PostgreSQL connection failed.'));
  }

  async ping() {
    await this.query('SELECT 1');
  }

  private connectionPool() {
    if (!this.pool) throw new ServiceUnavailableException('Database unavailable.');
    return this.pool;
  }

  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
    return this.connectionPool().query<Row>(sql, values);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connectionPool().connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  /** Session-scoped lock survives the worker's short transactions, without keeping one transaction open over network I/O. */
  async withAdvisoryLock<T>(namespace: number, key: number, work: (client: PoolClient) => Promise<T>) {
    const client = await this.connectionPool().connect();
    let acquired = false;
    try {
      const { rows: [row] } = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired', [namespace, key]);
      if (!row.acquired) return { acquired: false as const };
      acquired = true;
      return { acquired: true as const, result: await work(client) };
    } finally {
      // Await unlock so the next invocation can acquire immediately after this promise settles.
      try {
        if (acquired) await client.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [namespace, key]);
      } catch { /* Closing the connection releases locks after SQL/connection failures. */ }
      // Also roll back any unfinished worker transaction by closing this dedicated connection.
      client.release(true);
    }
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }
}
