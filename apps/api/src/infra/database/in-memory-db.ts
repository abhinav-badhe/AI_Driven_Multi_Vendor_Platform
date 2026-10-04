import { newDb } from 'pg-mem';
import type { DatabaseConnection, DatabaseQueryResult } from './connection.js';
import { MigrationRunner } from './migrations/runner.js';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

let __dirname = '';
try {
  if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) {
    __dirname = fileURLToPath(new URL('.', import.meta.url));
  } else {
    const cwd = process.cwd();
    const root = cwd.includes('apps') ? resolve(cwd, '../..') : cwd;
    __dirname = join(root, 'apps/api/src/infra/database');
  }
} catch {
  const cwd = process.cwd();
  const root = cwd.includes('apps') ? resolve(cwd, '../..') : cwd;
  __dirname = join(root, 'apps/api/src/infra/database');
}

export async function createIsolatedTestDatabase(): Promise<{
  db: DatabaseConnection;
  runner: MigrationRunner;
}> {
  const mem = newDb({
    autoCreateForeignKeyIndices: true,
    noAstCoverageCheck: true,
  });

  const pgAdapter = mem.adapters.createPg();
  const client = new pgAdapter.Client();
  await client.connect();

  const dbConnection: DatabaseConnection = {
    async query<T = unknown>(sql: string, params?: unknown[]): Promise<DatabaseQueryResult<T>> {
      const res = await client.query(sql, params);
      return {
        rows: res.rows as T[],
        rowCount: res.rowCount ?? undefined,
      };
    },
    async withTransaction<T>(fn: (tx: DatabaseConnection) => Promise<T>): Promise<T> {
      const backup = mem.backup();
      await dbConnection.query('BEGIN');
      try {
        const res = await fn(dbConnection);
        await dbConnection.query('COMMIT');
        return res;
      } catch (err) {
        backup.restore();
        try {
          await dbConnection.query('ROLLBACK');
        } catch {
          // ignore rollback failure after restore
        }
        throw err;
      }
    },
    async close(): Promise<void> {
      await client.end();
    },
  };

  const migrationsDir = join(__dirname, 'migrations');
  const runner = new MigrationRunner(migrationsDir);

  return {
    db: dbConnection,
    runner,
  };
}

export async function createMigratedTestDatabase(): Promise<DatabaseConnection> {
  const { db, runner } = await createIsolatedTestDatabase();
  await runner.up(db);
  return db;
}
