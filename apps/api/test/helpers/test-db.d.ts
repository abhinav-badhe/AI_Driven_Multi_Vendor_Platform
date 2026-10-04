import type { DatabaseConnection } from '../../src/infra/database/connection.js';
import { MigrationRunner } from '../../src/infra/database/migrations/runner.js';
export declare function createIsolatedTestDatabase(): Promise<{
    db: DatabaseConnection;
    runner: MigrationRunner;
}>;
export declare function createMigratedTestDatabase(): Promise<DatabaseConnection>;
//# sourceMappingURL=test-db.d.ts.map