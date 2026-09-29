import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateImportBoundary } from '../src/architecture/boundary-rules.js';

describe('Architecture Boundary & Dependency Enforcement', () => {
  describe('Rule Verification Test Cases', () => {
    it('allows clean cross-module imports through public module exports', () => {
      const violation = validateImportBoundary(
        'apps/api/src/modules/orders/service.ts',
        '../catalog/index.js',
      );
      expect(violation).toBeNull();
    });

    it('rejects cross-module access to internal implementation files', () => {
      const violation = validateImportBoundary(
        'apps/api/src/modules/orders/service.ts',
        '../catalog/internal/private-repo.js',
      );
      expect(violation).not.toBeNull();
      expect(violation?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
      expect(violation?.message).toContain('Forbidden cross-module access');
    });

    it('allows a module to import its own internal implementation files', () => {
      const violation = validateImportBoundary(
        'apps/api/src/modules/catalog/service.ts',
        './internal/catalog-repo.js',
      );
      expect(violation).toBeNull();
    });

    it('rejects AI module from directly importing database infrastructure', () => {
      const violation = validateImportBoundary(
        'apps/api/src/modules/ai/tools/product-lookup.ts',
        '../../infra/database/index.js',
      );
      expect(violation).not.toBeNull();
      expect(violation?.rule).toBe('AI_DIRECT_DB_IMPORT_VIOLATION');
      expect(violation?.message).toContain(
        'AI must interact with commerce strictly via authorized typed tools',
      );
    });

    it('rejects derived read systems (search, analytics) from directly importing database', () => {
      const searchViolation = validateImportBoundary(
        'apps/api/src/modules/search/indexer.ts',
        '../../infra/database/index.js',
      );
      expect(searchViolation).not.toBeNull();
      expect(searchViolation?.rule).toBe('DERIVED_SYSTEM_TRANSACTIONAL_WRITE_VIOLATION');

      const analyticsViolation = validateImportBoundary(
        'apps/api/src/modules/analytics-ml/pipeline.ts',
        '../../infra/database/index.js',
      );
      expect(analyticsViolation).not.toBeNull();
      expect(analyticsViolation?.rule).toBe('DERIVED_SYSTEM_TRANSACTIONAL_WRITE_VIOLATION');
    });

    it('rejects domain modules from directly importing HTTP transport framework', () => {
      const violation = validateImportBoundary(
        'apps/api/src/modules/inventory/stock-service.ts',
        'fastify',
      );
      expect(violation).not.toBeNull();
      expect(violation?.rule).toBe('DOMAIN_TO_HTTP_COUPLING_VIOLATION');
    });
  });

  describe('Static Scan of Current Repository Files', () => {
    function getAllSourceFiles(dir: string): string[] {
      const files: string[] = [];
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        if (statSync(fullPath).isDirectory()) {
          files.push(...getAllSourceFiles(fullPath));
        } else if (fullPath.endsWith('.ts')) {
          files.push(fullPath);
        }
      }
      return files;
    }

    it('proves zero architecture violations in the current codebase', () => {
      const srcDir = join(__dirname, '../src');
      const allFiles = getAllSourceFiles(srcDir);
      const violations = [];

      for (const file of allFiles) {
        const content = readFileSync(file, 'utf-8');
        // Match import statements: import ... from '...' or import '...'
        const importMatches = content.matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g);
        for (const match of importMatches) {
          const importPath = match[1];
          if (importPath) {
            const violation = validateImportBoundary(file, importPath);
            if (violation) {
              violations.push(violation);
            }
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });
});
