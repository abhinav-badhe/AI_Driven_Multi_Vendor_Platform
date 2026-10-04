import pg from 'pg';
import type { AppConfig } from '../../config/index.js';

export interface DatabaseQueryResult<T = unknown> {
  rows: T[];
  rowCount?: number | undefined;
}

export interface DatabaseConnection {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<DatabaseQueryResult<T>>;
  withTransaction<T>(fn: (tx: DatabaseConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PostgresPoolConnection implements DatabaseConnection {
  private readonly pool: pg.Pool;

  constructor(config: AppConfig['postgres']) {
    this.pool = new pg.Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      min: config.poolMin,
      max: config.poolMax,
    });
  }

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<DatabaseQueryResult<T>> {
    const result = await this.pool.query(sql, params);
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount ?? undefined,
    };
  }

  async withTransaction<T>(fn: (tx: DatabaseConnection) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txConnection: DatabaseConnection = {
        query: async <R = unknown>(sql: string, params?: unknown[]) => {
          const res = await client.query(sql, params);
          return { rows: res.rows as R[], rowCount: res.rowCount ?? undefined };
        },
        withTransaction: async () => {
          throw new Error('Nested transactions not currently supported');
        },
        close: async () => {
          // No-op for client inside transaction
        },
      };

      const result = await fn(txConnection);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
