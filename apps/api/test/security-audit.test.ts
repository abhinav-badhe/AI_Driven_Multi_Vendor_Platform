import { describe, it, expect, beforeEach } from 'vitest';
import {
  SecurityAuditService,
  InMemorySecurityAuditService,
  identityModule,
} from '../src/modules/identity/index.js';
import { createMigratedTestDatabase } from './helpers/test-db.js';
import { JsonLogger } from '../src/observability/logger.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { MerchantService } from '../src/modules/merchant/index.js';
import { ListingService } from '../src/modules/marketplace/index.js';
import { PromotionService } from '../src/modules/promotion-pricing/index.js';
import { CatalogService } from '../src/modules/catalog/index.js';

describe('Domain 2: Security & Audit Decoupling (ISecurityAuditService)', () => {
  let db: DatabaseConnection;
  const logger = new JsonLogger({ serviceName: 'test', level: 'fatal', sink: () => undefined });

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
  });

  describe('1. InMemorySecurityAuditService (Standalone / Mock Decoupling)', () => {
    it('records and queries audit events without requiring a database', async () => {
      const audit = identityModule.createInMemoryAuditService();

      await audit.record({
        eventType: 'LOGIN_SUCCESS',
        actorId: 'usr-1',
        tenantId: 'ten-1',
        ipAddress: '127.0.0.1',
        userAgent: 'Vitest/Agent',
        metadata: { method: 'password' },
      });

      await audit.record({
        eventType: 'LOGIN_FAILURE',
        actorId: 'usr-2',
        tenantId: 'ten-1',
        ipAddress: '192.168.1.1',
        metadata: { reason: 'invalid_credentials' },
      });

      const all = await audit.query();
      expect(all).toHaveLength(2);
      expect(all[0]!.eventType).toBe('LOGIN_FAILURE');
      expect(all[1]!.eventType).toBe('LOGIN_SUCCESS');

      // Filter by actor
      const user1Events = await audit.query({ actorId: 'usr-1' });
      expect(user1Events).toHaveLength(1);
      expect(user1Events[0]!.actorId).toBe('usr-1');

      // Filter by eventType
      const failureEvents = await audit.query({ eventType: 'LOGIN_FAILURE' });
      expect(failureEvents).toHaveLength(1);
      expect(failureEvents[0]!.actorId).toBe('usr-2');
    });

    it('clears records cleanly', async () => {
      const audit = new InMemorySecurityAuditService();
      await audit.record({ eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT' });
      expect(await audit.query()).toHaveLength(1);

      audit.clear();
      expect(await audit.query()).toHaveLength(0);
    });
  });

  describe('2. SecurityAuditService (Database Persistence & Query)', () => {
    it('persists audit events and queries them with filters', async () => {
      const audit = new SecurityAuditService(db, logger);

      await audit.record({
        eventType: 'MERCHANT_VERIFICATION_APPROVED',
        actorId: 'admin-1',
        tenantId: 'merchant-ten-99',
        metadata: { reviewerNotes: 'All KYC documents verified' },
      });

      await audit.record({
        eventType: 'MERCHANT_VERIFICATION_REJECTED',
        actorId: 'admin-2',
        tenantId: 'merchant-ten-100',
        metadata: { reason: 'incomplete_tax_form' },
      });

      const records = await audit.query({ tenantId: 'merchant-ten-99' });
      expect(records).toHaveLength(1);
      expect(records[0]!.eventType).toBe('MERCHANT_VERIFICATION_APPROVED');
      expect(records[0]!.tenantId).toBe('merchant-ten-99');
      expect(records[0]!.metadata).toEqual({ reviewerNotes: 'All KYC documents verified' });
    });

    it('silently swallows database write errors to protect primary transaction flows', async () => {
      const brokenDb = {
        query: async () => {
          throw new Error('Database connection terminated');
        },
      } as unknown as DatabaseConnection;

      const audit = new SecurityAuditService(brokenDb, logger);

      // Must not throw
      await expect(
        audit.record({
          eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
          actorId: 'attacker-1',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('3. Dependency Injection across Domain Boundaries', () => {
    it('MerchantService accepts injected InMemorySecurityAuditService', async () => {
      const inMemoryAudit = new InMemorySecurityAuditService();
      const merchantService = new MerchantService(db, logger, inMemoryAudit);
      expect(merchantService).toBeDefined();

      // Verify audit service is decoupled from SQL table
      await inMemoryAudit.record({
        eventType: 'MERCHANT_VERIFICATION_APPROVED',
        actorId: 'admin-x',
        tenantId: 'ten-x',
      });
      expect(await inMemoryAudit.query()).toHaveLength(1);
    });

    it('ListingService accepts injected InMemorySecurityAuditService', async () => {
      const inMemoryAudit = new InMemorySecurityAuditService();
      const catalogService = new CatalogService(db, logger);
      const merchantService = new MerchantService(db, logger, inMemoryAudit);

      const listingService = new ListingService(
        db,
        logger,
        catalogService,
        merchantService,
        inMemoryAudit,
      );
      expect(listingService).toBeDefined();

      await inMemoryAudit.record({
        eventType: 'LISTING_SUSPENDED',
        actorId: 'admin-mod',
        tenantId: 'merchant-ten',
      });
      expect(await inMemoryAudit.query()).toHaveLength(1);
    });

    it('PromotionService accepts injected InMemorySecurityAuditService', async () => {
      const inMemoryAudit = new InMemorySecurityAuditService();
      const promotionService = new PromotionService(db, logger, undefined, inMemoryAudit);
      expect(promotionService).toBeDefined();

      await inMemoryAudit.record({
        eventType: 'PROMOTION_CREATED',
        actorId: 'merchant-admin',
        tenantId: 'promo-tenant',
      });
      expect(await inMemoryAudit.query()).toHaveLength(1);
    });
  });
});
