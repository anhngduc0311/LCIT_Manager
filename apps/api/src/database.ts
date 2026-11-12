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

  async onModuleDestroy() {
    await this.pool?.end();
  }
}
