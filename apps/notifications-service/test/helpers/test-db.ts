import { newDb, DataType } from 'pg-mem';
import { randomUUID } from 'node:crypto';
import { DatabaseConnection } from '../../src/infra/database/connection.js';
import { runMigrations } from '../../src/infra/database/migrations/runner.js';

export async function createTestDatabase(): Promise<DatabaseConnection> {
  const db = newDb();

  // Register Postgres built-ins needed by schema
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.text,
    implementation: () => randomUUID(),
  });

  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();

  const connection: DatabaseConnection = {
    async query<T = any>(
      sql: string,
      params: unknown[] = [],
    ): Promise<{ rows: T[]; rowCount: number }> {
      const res = await pool.query(sql, params);
      return {
        rows: res.rows,
        rowCount: res.rowCount ?? res.rows.length,
      };
    },
    async withTransaction<T>(callback: (client: DatabaseConnection) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const txConn: DatabaseConnection = {
          async query<R = any>(
            sql: string,
            params: unknown[] = [],
          ): Promise<{ rows: R[]; rowCount: number }> {
            const res = await client.query(sql, params);
            return {
              rows: res.rows,
              rowCount: res.rowCount ?? res.rows.length,
            };
          },
          async withTransaction<R>(nestedCb: (c: DatabaseConnection) => Promise<R>): Promise<R> {
            return nestedCb(this);
          },
          async close(): Promise<void> {},
          async end(): Promise<void> {},
        };
        const result = await callback(txConn);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async end(): Promise<void> {
      await pool.end();
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };

  await runMigrations(connection);
  return connection;
}
