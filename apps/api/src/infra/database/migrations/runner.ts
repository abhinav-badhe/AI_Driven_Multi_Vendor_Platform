import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseConnection } from '../connection.js';

export interface MigrationRecord {
  version: string;
  name: string;
  appliedAt: string;
}

export interface MigrationStatus {
  applied: MigrationRecord[];
  pending: string[];
}

export class MigrationRunner {
  private readonly migrationsDir: string;

  constructor(migrationsDir?: string) {
    this.migrationsDir = migrationsDir ?? __dirname;
  }

  private async ensureMigrationTable(db: DatabaseConnection): Promise<void> {
    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  async getStatus(db: DatabaseConnection): Promise<MigrationStatus> {
    await this.ensureMigrationTable(db);
    const result = await db.query<{ version: string; name: string; applied_at: string }>(
      'SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC',
    );

    const appliedRecords: MigrationRecord[] = result.rows.map((r) => ({
      version: r.version,
      name: r.name,
      appliedAt: r.applied_at,
    }));

    const appliedVersions = new Set(appliedRecords.map((r) => r.version));
    const allFiles = readdirSync(this.migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const pending = allFiles.filter((file) => {
      const version = file.split('_')[0] ?? file;
      return !appliedVersions.has(version);
    });

    return {
      applied: appliedRecords,
      pending,
    };
  }

  async up(db: DatabaseConnection): Promise<string[]> {
    await this.ensureMigrationTable(db);
    const status = await this.getStatus(db);
    const appliedNow: string[] = [];

    for (const pendingFile of status.pending) {
      const version = pendingFile.split('_')[0] ?? pendingFile;
      const filePath = join(this.migrationsDir, pendingFile);
      const sql = readFileSync(filePath, 'utf-8');

      // Execute each migration atomically
      await db.withTransaction(async (tx) => {
        await tx.query(sql);
        await tx.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, NOW())',
          [version, pendingFile],
        );
      });

      appliedNow.push(pendingFile);
    }

    return appliedNow;
  }
}
