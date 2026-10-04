import { newDb } from 'pg-mem';
import { MigrationRunner } from '../../src/infra/database/migrations/runner.js';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
let __dirname = '';
try {
    if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) {
        __dirname = fileURLToPath(new URL('.', import.meta.url));
    }
    else {
        const cwd = process.cwd();
        const root = cwd.includes('apps') ? resolve(cwd, '../..') : cwd;
        __dirname = join(root, 'apps/api/test/helpers');
    }
}
catch {
    const cwd = process.cwd();
    const root = cwd.includes('apps') ? resolve(cwd, '../..') : cwd;
    __dirname = join(root, 'apps/api/test/helpers');
}
export async function createIsolatedTestDatabase() {
    const mem = newDb({
        autoCreateForeignKeyIndices: true,
        noAstCoverageCheck: true,
    });
    const pgAdapter = mem.adapters.createPg();
    const client = new pgAdapter.Client();
    await client.connect();
    const dbConnection = {
        async query(sql, params) {
            const res = await client.query(sql, params);
            return {
                rows: res.rows,
                rowCount: res.rowCount ?? undefined,
            };
        },
        async withTransaction(fn) {
            await dbConnection.query('BEGIN');
            try {
                const res = await fn(dbConnection);
                await dbConnection.query('COMMIT');
                return res;
            }
            catch (err) {
                await dbConnection.query('ROLLBACK');
                throw err;
            }
        },
        async close() {
            await client.end();
        },
    };
    const migrationsDir = join(__dirname, '../../src/infra/database/migrations');
    const runner = new MigrationRunner(migrationsDir);
    return {
        db: dbConnection,
        runner,
    };
}
export async function createMigratedTestDatabase() {
    const { db, runner } = await createIsolatedTestDatabase();
    await runner.up(db);
    return db;
}
//# sourceMappingURL=test-db.js.map