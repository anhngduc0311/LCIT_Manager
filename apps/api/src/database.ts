import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

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
    if (!this.pool) {
      throw new Error('DATABASE_URL is required.');
    }
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }
}
