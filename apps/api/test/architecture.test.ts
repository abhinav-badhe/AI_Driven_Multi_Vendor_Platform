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

    it('rejects Merchant module from importing Identity internal implementation files', () => {
      const violation = validateImportBoundary(
        'apps/api/src/modules/merchant/internal/merchant-service.ts',
        '../../identity/internal/identity-repository.js',
      );
      expect(violation).not.toBeNull();
      expect(violation?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
    });

    it('rejects Identity module from importing Merchant internal implementation files', () => {
      const violation = validateImportBoundary(
        'apps/api/src/modules/identity/internal/identity-service.ts',
        '../../merchant/internal/merchant-repository.js',
      );
      expect(violation).not.toBeNull();
      expect(violation?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
    });

    it('rejects future modules (catalog, orders) from importing Identity or Merchant internals', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/catalog/service.ts',
        '../identity/internal/password-hasher.js',
      );
      expect(v1?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/orders/service.ts',
        '../merchant/internal/merchant-repository.js',
      );
      expect(v2?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
    });

    it('rejects AI module from directly accessing Identity or Merchant repositories', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/ai/tools/auth-tool.ts',
        '../../infra/database/index.js',
      );
      expect(v1?.rule).toBe('AI_DIRECT_DB_IMPORT_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/ai/tools/merchant-tool.ts',
        '../merchant/internal/merchant-repository.js',
      );
      expect(v2?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
    });

    it('rejects external modules from directly importing Inventory internals', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/orders/service.ts',
        '../inventory/internal/inventory-repository.js',
      );
      expect(v1?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/catalog/service.ts',
        '../inventory/internal/inventory-service.js',
      );
      expect(v2?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
    });

    it('rejects external modules from directly importing Cart & Checkout internals', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/orders/service.ts',
        '../cart-checkout/internal/checkout-repository.js',
      );
      expect(v1?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/inventory/internal/inventory-service.ts',
        '../../cart-checkout/internal/cart-service.js',
      );
      expect(v2?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
    });

    it('rejects Cart & Checkout module from importing Inventory or Catalog internals', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/cart-checkout/internal/checkout-service.ts',
        '../../inventory/internal/inventory-repository.js',
      );
      expect(v1?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/cart-checkout/internal/checkout-service.ts',
        '../../catalog/internal/catalog-repository.js',
      );
      expect(v2?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
    });

    it('rejects Settlement & Ledger module from importing Orders or Payment internal files', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/settlement-ledger/internal/settlement-service.ts',
        '../../orders/internal/order-repository.js',
      );
      expect(v1?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/settlement-ledger/internal/settlement-service.ts',
        '../../payment/internal/payment-repository.js',
      );
      expect(v2?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
    });

    it('rejects external modules from directly importing Settlement & Ledger internals', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/orders/internal/order-service.ts',
        '../../settlement-ledger/internal/settlement-repository.js',
      );
      expect(v1?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/payment/internal/payment-service.ts',
        '../../settlement-ledger/internal/settlement-service.js',
      );
      expect(v2?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
    });

    it('rejects Search module from importing Catalog or Marketplace internals', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/search/internal/search-service.ts',
        '../../catalog/internal/catalog-repository.js',
      );
      expect(v1?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/search/internal/search-service.ts',
        '../../marketplace/internal/listing-repository.js',
      );
      expect(v2?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
    });

    it('rejects Search module from importing Orders, Payment, or Settlement modules', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/search/internal/search-service.ts',
        '../../orders/index.js',
      );
      expect(v1?.rule).toBe('SEARCH_DOWNSTREAM_DEPENDENCY_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/search/internal/search-service.ts',
        '../../payment/index.js',
      );
      expect(v2?.rule).toBe('SEARCH_DOWNSTREAM_DEPENDENCY_VIOLATION');

      const v3 = validateImportBoundary(
        'apps/api/src/modules/search/internal/search-service.ts',
        '../../settlement-ledger/index.js',
      );
      expect(v3?.rule).toBe('SEARCH_DOWNSTREAM_DEPENDENCY_VIOLATION');
    });

    it('rejects external modules from importing Search internal files', () => {
      const violation = validateImportBoundary(
        'apps/api/src/modules/catalog/internal/catalog-service.ts',
        '../../search/internal/search-store.js',
      );
      expect(violation?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
    });

    it('rejects Notifications module from importing Orders, Payment, or Settlement modules', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/notifications/internal/notification-service.ts',
        '../../orders/index.js',
      );
      expect(v1?.rule).toBe('NOTIFICATIONS_DOWNSTREAM_DEPENDENCY_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/notifications/internal/notification-consumer.ts',
        '../../payment/index.js',
      );
      expect(v2?.rule).toBe('NOTIFICATIONS_DOWNSTREAM_DEPENDENCY_VIOLATION');
    });

    it('rejects Event consumers and Notifications from directly importing private domain repositories', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/events/internal/search-consumer.ts',
        '../../catalog/internal/catalog-repository.js',
      );
      expect(v1?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/notifications/internal/notification-service.ts',
        '../../orders/internal/order-repository.js',
      );
      expect(v2?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
    });

    it('rejects Analytics module from importing transactional domain modules directly', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/analytics/internal/analytics-service.ts',
        '../../orders/index.js',
      );
      expect(v1?.rule).toBe('ANALYTICS_TRANSACTIONAL_DEPENDENCY_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/analytics/internal/analytics-service.ts',
        '../../inventory/index.js',
      );
      expect(v2?.rule).toBe('ANALYTICS_TRANSACTIONAL_DEPENDENCY_VIOLATION');

      const v3 = validateImportBoundary(
        'apps/api/src/modules/analytics/internal/analytics-service.ts',
        '../../payment/index.js',
      );
      expect(v3?.rule).toBe('ANALYTICS_TRANSACTIONAL_DEPENDENCY_VIOLATION');

      const v4 = validateImportBoundary(
        'apps/api/src/modules/analytics/internal/analytics-service.ts',
        '../../settlement-ledger/index.js',
      );
      expect(v4?.rule).toBe('ANALYTICS_TRANSACTIONAL_DEPENDENCY_VIOLATION');
    });

    it('rejects Analytics from accessing internal repositories of transactional domains', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/analytics/internal/analytics-repository.ts',
        '../../orders/internal/order-repository.js',
      );
      expect(v1?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/analytics/internal/analytics-repository.ts',
        '../../inventory/internal/inventory-repository.js',
      );
      expect(v2?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
    });

    it('rejects Recommendations module from importing transactional downstream or ML modules directly', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/recommendations/internal/recommendation-service.ts',
        '../../orders/index.js',
      );
      expect(v1?.rule).toBe('RECOMMENDATIONS_TRANSACTIONAL_DEPENDENCY_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/recommendations/internal/recommendation-service.ts',
        '../../payment/index.js',
      );
      expect(v2?.rule).toBe('RECOMMENDATIONS_TRANSACTIONAL_DEPENDENCY_VIOLATION');

      const v3 = validateImportBoundary(
        'apps/api/src/modules/recommendations/internal/recommendation-service.ts',
        '../../ai/index.js',
      );
      expect(v3?.rule).toBe('RECOMMENDATIONS_TRANSACTIONAL_DEPENDENCY_VIOLATION');

      const v4 = validateImportBoundary(
        'apps/api/src/modules/recommendations/internal/recommendation-service.ts',
        '../../analytics-ml/index.js',
      );
      expect(v4?.rule).toBe('RECOMMENDATIONS_TRANSACTIONAL_DEPENDENCY_VIOLATION');
    });

    it('allows Recommendations module to import catalog and marketplace public interfaces', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/recommendations/internal/recommendation-service.ts',
        '../../catalog/index.js',
      );
      expect(v1).toBeNull();

      const v2 = validateImportBoundary(
        'apps/api/src/modules/recommendations/internal/recommendation-service.ts',
        '../../marketplace/index.js',
      );
      expect(v2).toBeNull();
    });

    it('rejects Recommendations module from importing internal files of catalog or marketplace', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/recommendations/internal/recommendation-service.ts',
        '../../catalog/internal/catalog-repository.js',
      );
      expect(v1?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/recommendations/internal/recommendation-service.ts',
        '../../marketplace/internal/listing-repository.js',
      );
      expect(v2?.rule).toBe('PRIVATE_INTERNAL_IMPORT_VIOLATION');
    });
  });

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

  describe('Static Scan of Current Repository Files', () => {
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

    it('proves Analytics module never executes write queries against transactional tables', () => {
      const transactionalTables = [
        'orders',
        'seller_orders',
        'order_items',
        'inventory',
        'inventory_reservations',
        'payment_intents',
        'payment_attempts',
        'payment_refunds',
        'settlements',
        'ledger_entries',
        'products',
        'merchant_listings',
      ];

      const analyticsDir = join(__dirname, '../src/modules/analytics');
      const analyticsFiles = getAllSourceFiles(analyticsDir);

      for (const file of analyticsFiles) {
        const content = readFileSync(file, 'utf-8');
        for (const table of transactionalTables) {
          const insertRegex = new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, 'i');
          const updateRegex = new RegExp(`UPDATE\\s+${table}\\b`, 'i');
          const deleteRegex = new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, 'i');

          expect(insertRegex.test(content)).toBe(false);
          expect(updateRegex.test(content)).toBe(false);
          expect(deleteRegex.test(content)).toBe(false);
        }
      }
    });

    it('proves Recommendations module never executes write queries against transactional tables', () => {
      const transactionalTables = [
        'orders',
        'seller_orders',
        'order_items',
        'inventory',
        'inventory_reservations',
        'payment_intents',
        'payment_attempts',
        'payment_refunds',
        'settlements',
        'ledger_entries',
        'products',
        'merchant_listings',
      ];

      const recommendationsDir = join(__dirname, '../src/modules/recommendations');
      const recommendationsFiles = getAllSourceFiles(recommendationsDir);

      for (const file of recommendationsFiles) {
        const content = readFileSync(file, 'utf-8');
        for (const table of transactionalTables) {
          const insertRegex = new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, 'i');
          const updateRegex = new RegExp(`UPDATE\\s+${table}\\b`, 'i');
          const deleteRegex = new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, 'i');

          expect(insertRegex.test(content)).toBe(false);
          expect(updateRegex.test(content)).toBe(false);
          expect(deleteRegex.test(content)).toBe(false);
        }
      }
    });

    it('proves Recommendations module never queries Analytics internal fact tables directly with SQL', () => {
      const analyticsTables = [
        'analytics_order_facts',
        'analytics_payment_facts',
        'analytics_fulfillment_facts',
        'analytics_settlement_facts',
        'analytics_catalog_facts',
        'analytics_daily_metrics',
        'analytics_quarantine_records',
        'analytics_rebuild_audit',
      ];

      const recommendationsDir = join(__dirname, '../src/modules/recommendations');
      const recommendationsFiles = getAllSourceFiles(recommendationsDir);

      for (const file of recommendationsFiles) {
        const content = readFileSync(file, 'utf-8');
        for (const table of analyticsTables) {
          const sqlRegex = new RegExp(`\\b${table}\\b`, 'i');
          expect(sqlRegex.test(content)).toBe(false);
        }
      }
    });
  });

  describe('Phase 13: Predictive ML Architecture Invariants', () => {
    const transactionalTables = [
      'customer_orders',
      'seller_orders',
      'order_items',
      'payment_intents',
      'payment_webhook_events',
      'inventory_items',
      'inventory_reservations',
      'stock_movement_logs',
      'seller_financial_accounts',
      'ledger_entries',
      'settlements',
      'carts',
      'cart_items',
      'checkout_sessions',
      'shipments',
      'shipment_items',
      'returns',
      'return_items',
    ];

    it('proves Predictive ML module never contains direct SQL against transactional domain tables', () => {
      const mlDir = join(__dirname, '../src/modules/analytics-ml');
      const mlFiles = getAllSourceFiles(mlDir);

      for (const file of mlFiles) {
        const content = readFileSync(file, 'utf-8');
        for (const table of transactionalTables) {
          const sqlRegex = new RegExp(`(?:FROM|JOIN|INTO|UPDATE|TABLE)\\s+${table}\\b`, 'i');
          expect(sqlRegex.test(content)).toBe(false);
        }
      }
    });

    it('proves Predictive ML never executes mutating statements on transactional tables', () => {
      const mlDir = join(__dirname, '../src/modules/analytics-ml');
      const mlFiles = getAllSourceFiles(mlDir);

      for (const file of mlFiles) {
        const content = readFileSync(file, 'utf-8');
        for (const table of transactionalTables) {
          const insertRegex = new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, 'i');
          const updateRegex = new RegExp(`UPDATE\\s+${table}\\b`, 'i');
          const deleteRegex = new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, 'i');

          expect(insertRegex.test(content)).toBe(false);
          expect(updateRegex.test(content)).toBe(false);
          expect(deleteRegex.test(content)).toBe(false);
        }
      }
    });

    it('proves Predictive ML module does not directly query Analytics internal tables via SQL', () => {
      const analyticsInternalTables = [
        'analytics_order_facts',
        'analytics_payment_facts',
        'analytics_fulfillment_facts',
        'analytics_settlement_facts',
        'analytics_catalog_facts',
        'analytics_daily_metrics',
        'analytics_quarantine_records',
        'analytics_rebuild_audit',
      ];

      const mlDir = join(__dirname, '../src/modules/analytics-ml');
      const mlFiles = getAllSourceFiles(mlDir);

      for (const file of mlFiles) {
        const content = readFileSync(file, 'utf-8');
        for (const table of analyticsInternalTables) {
          const sqlRegex = new RegExp(`\\b${table}\\b`, 'i');
          expect(sqlRegex.test(content)).toBe(false);
        }
      }
    });

    it('proves boundary-rules reject transactional domains from importing ML', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/orders/internal/order-service.ts',
        '../../analytics-ml/index.js',
      );
      expect(v1?.rule).toBe('TRANSACTIONAL_TO_ML_DEPENDENCY_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/payment/internal/payment-service.ts',
        '../../analytics-ml/index.js',
      );
      expect(v2?.rule).toBe('TRANSACTIONAL_TO_ML_DEPENDENCY_VIOLATION');

      const v3 = validateImportBoundary(
        'apps/api/src/modules/inventory/internal/inventory-service.ts',
        '../../analytics-ml/index.js',
      );
      expect(v3?.rule).toBe('TRANSACTIONAL_TO_ML_DEPENDENCY_VIOLATION');

      const v4 = validateImportBoundary(
        'apps/api/src/modules/cart-checkout/internal/checkout-service.ts',
        '../../analytics-ml/index.js',
      );
      expect(v4?.rule).toBe('TRANSACTIONAL_TO_ML_DEPENDENCY_VIOLATION');
    });

    it('proves boundary-rules reject ML from importing transactional domain internals or modules', () => {
      const v1 = validateImportBoundary(
        'apps/api/src/modules/analytics-ml/internal/ml-service.ts',
        '../../orders/index.js',
      );
      expect(v1?.rule).toBe('ML_TRANSACTIONAL_DEPENDENCY_VIOLATION');

      const v2 = validateImportBoundary(
        'apps/api/src/modules/analytics-ml/internal/ml-service.ts',
        '../../payment/index.js',
      );
      expect(v2?.rule).toBe('ML_TRANSACTIONAL_DEPENDENCY_VIOLATION');

      const v3 = validateImportBoundary(
        'apps/api/src/modules/analytics-ml/internal/ml-service.ts',
        '../../inventory/index.js',
      );
      expect(v3?.rule).toBe('ML_TRANSACTIONAL_DEPENDENCY_VIOLATION');
    });

    it('proves AI module never directly imports database infrastructure (Rule 2)', () => {
      const aiDir = join(__dirname, '../src/modules/ai');
      const aiFiles = getAllSourceFiles(aiDir);

      for (const file of aiFiles) {
        const content = readFileSync(file, 'utf-8');
        expect(content.includes('infra/database')).toBe(false);
        expect(/from\s+['"][^'"]*\/database(?:\/index(?:\.js)?)?['"]/i.test(content)).toBe(false);
        expect(/from\s+['"]pg['"]/i.test(content)).toBe(false);
      }
    });

    it('proves AI module never contains direct SQL against transactional domain tables', () => {
      const aiDir = join(__dirname, '../src/modules/ai');
      const aiFiles = getAllSourceFiles(aiDir);

      for (const file of aiFiles) {
        const content = readFileSync(file, 'utf-8');
        for (const table of transactionalTables) {
          const sqlRegex = new RegExp(`(?:FROM|JOIN|INTO|UPDATE|TABLE)\\s+${table}\\b`, 'i');
          expect(sqlRegex.test(content)).toBe(false);
        }
      }
    });

    it('proves boundary-rules reject AI module from directly importing database', () => {
      const v = validateImportBoundary(
        'apps/api/src/modules/ai/internal/ai-orchestrator.ts',
        '../../infra/database/index.js',
      );
      expect(v).not.toBeNull();
      expect(v?.rule).toBe('AI_DIRECT_DB_IMPORT_VIOLATION');
    });

    it('verifies No Phase 15+ implementation has been introduced', () => {
      const modulesDir = join(__dirname, '../src/modules');
      const allFiles = getAllSourceFiles(modulesDir);

      for (const file of allFiles) {
        const content = readFileSync(file, 'utf-8');
        // No Kubernetes, no Helm, no Ansible, no proprietary vector db SDKs
        expect(/@kubernetes|kubernetes-client|helm/i.test(content)).toBe(false);
        expect(/chromadb|pinecone|qdrant|langchain/i.test(content)).toBe(false);
      }
    });
  });
});
