import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { InventoryService, IInventoryService } from '../modules/inventory/index.js';
import {
  createAuthMiddleware,
  createOptionalAuthMiddleware,
  requireActor,
} from './auth-middleware.js';
import { ValidationError, ForbiddenError } from '../errors/app-error.js';
import {
  CachePresets,
  CacheTags,
  cacheKey,
  inventoryItemTag,
  inventoryListingTag,
  inventoryMerchantTag,
  sendCached,
} from './cache-helper.js';

export function registerInventoryRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  inventoryService: IInventoryService | InventoryService,
): void {
  const authenticate = createAuthMiddleware(identityService);
  const optionalAuth = createOptionalAuthMiddleware(identityService);

  // --- Inventory Item Endpoints ---

  // POST /inventory (Initialize inventory for a merchant listing)
  app.post('/inventory', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const body = request.body as {
      listingId?: unknown;
      initialOnHandQuantity?: unknown;
      initialNonSellableQuantity?: unknown;
    };

    if (typeof body.listingId !== 'string') throw new ValidationError('listingId is required');

    const item = await inventoryService.initializeInventory(actor, {
      listingId: body.listingId,
      initialOnHandQuantity:
        typeof body.initialOnHandQuantity === 'number' ? body.initialOnHandQuantity : undefined,
      initialNonSellableQuantity:
        typeof body.initialNonSellableQuantity === 'number'
          ? body.initialNonSellableQuantity
          : undefined,
    });

    return reply.status(201).send(item);
  });

  // GET /inventory (List inventory items for authenticated merchant)
  app.get('/inventory', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const query = request.query as { limit?: string; offset?: string };
    return sendCached(
      app,
      request,
      reply,
      {
        key: cacheKey(
          'inventory',
          'merchant',
          actor.tenantId,
          query.limit ?? '',
          query.offset ?? '',
        ),
        tags: [CacheTags.inventory, inventoryMerchantTag(actor.tenantId)],
        preset: CachePresets.merchantScoped,
      },
      () =>
        inventoryService.listInventory(actor, {
          limit: query.limit ? parseInt(query.limit, 10) : undefined,
          offset: query.offset ? parseInt(query.offset, 10) : undefined,
        }),
    );
  });

  // GET /admin/inventory (Platform administrator view of all inventory across all merchants)
  app.get('/admin/inventory', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can inspect all inventory records');
    }
    const query = request.query as { limit?: string; offset?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;
    const items = inventoryService.listAllInventory
      ? await inventoryService.listAllInventory(actor, { limit, offset })
      : await inventoryService.listInventory(actor, { limit, offset });
    return reply.status(200).send(items);
  });

  // GET /inventory/availability/:listingId (Public availability view - sanitized DTO)
  // Advisory only: short TTL + SWR. Checkout revalidates against the ledger
  // and reserves atomically, and every stock mutation invalidates this entry
  // from inside the inventory transaction.
  app.get(
    '/inventory/availability/:listingId',
    { preHandler: optionalAuth },
    async (request, reply) => {
      const { listingId } = request.params as { listingId: string };
      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('inventory', 'availability', listingId),
          tags: [CacheTags.availability, inventoryListingTag(listingId)],
          preset: CachePresets.availability,
        },
        () => inventoryService.getAvailabilityByListingId(listingId),
      );
    },
  );

  // GET /inventory/by-listing/:listingId (Merchant/Admin internal view)
  app.get(
    '/inventory/by-listing/:listingId',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { listingId } = request.params as { listingId: string };
      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('inventory', 'by-listing', listingId, actor.tenantId),
          tags: [CacheTags.inventory, inventoryListingTag(listingId)],
          preset: CachePresets.merchantScoped,
        },
        () => inventoryService.getInventoryByListingId(actor, listingId),
      );
    },
  );

  // GET /inventory/:id (Internal item view)
  app.get('/inventory/:id', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    return sendCached(
      app,
      request,
      reply,
      {
        key: cacheKey('inventory', 'item', id, actor.tenantId),
        tags: [CacheTags.inventory, inventoryItemTag(id)],
        preset: CachePresets.merchantScoped,
      },
      () => inventoryService.getInventoryById(actor, id),
    );
  });

  // POST /inventory/:id/increase-stock (with aliases for microservice clients)
  const increaseStockHandler = async (
    request: Parameters<Parameters<typeof app.post>[1]['handler']>[0],
    reply: Parameters<Parameters<typeof app.post>[1]['handler']>[1],
  ) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    const body = request.body as { quantity?: unknown; notes?: unknown; referenceId?: unknown };

    if (typeof body.quantity !== 'number') throw new ValidationError('quantity is required');

    const item = await inventoryService.increaseStock(
      actor,
      id,
      body.quantity,
      typeof body.notes === 'string' ? body.notes : undefined,
      typeof body.referenceId === 'string' ? body.referenceId : undefined,
    );

    return reply.status(200).send(item);
  };

  app.post('/inventory/:id/increase-stock', { preHandler: authenticate }, increaseStockHandler);
  app.post('/inventory/:id/stock/increase', { preHandler: authenticate }, increaseStockHandler);
  app.post('/inventory/:id/increase', { preHandler: authenticate }, increaseStockHandler);

  // POST /inventory/:id/decrease-stock (with aliases for microservice clients)
  const decreaseStockHandler = async (
    request: Parameters<Parameters<typeof app.post>[1]['handler']>[0],
    reply: Parameters<Parameters<typeof app.post>[1]['handler']>[1],
  ) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    const body = request.body as { quantity?: unknown; notes?: unknown };

    if (typeof body.quantity !== 'number') throw new ValidationError('quantity is required');

    const item = await inventoryService.decreaseStock(
      actor,
      id,
      body.quantity,
      typeof body.notes === 'string' ? body.notes : undefined,
    );

    return reply.status(200).send(item);
  };

  app.post('/inventory/:id/decrease-stock', { preHandler: authenticate }, decreaseStockHandler);
  app.post('/inventory/:id/stock/decrease', { preHandler: authenticate }, decreaseStockHandler);
  app.post('/inventory/:id/decrease', { preHandler: authenticate }, decreaseStockHandler);

  // POST /inventory/:id/adjust-non-sellable
  app.post(
    '/inventory/:id/adjust-non-sellable',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        newNonSellableQuantity?: unknown;
        notes?: unknown;
        referenceId?: unknown;
      };

      if (typeof body.newNonSellableQuantity !== 'number') {
        throw new ValidationError('newNonSellableQuantity is required');
      }

      const item = await inventoryService.adjustNonSellable(
        actor,
        id,
        body.newNonSellableQuantity,
        typeof body.notes === 'string' ? body.notes : undefined,
        typeof body.referenceId === 'string' ? body.referenceId : undefined,
      );

      return reply.status(200).send(item);
    },
  );

  // GET /inventory/:id/movements
  // Append-only ledger: invalidated by every mutation of this item via the
  // service-level hook, so a short TTL is safe.
  app.get('/inventory/:id/movements', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    return sendCached(
      app,
      request,
      reply,
      {
        key: cacheKey('inventory', 'item', id, 'movements', actor.tenantId),
        tags: [CacheTags.inventory, inventoryItemTag(id)],
        preset: CachePresets.merchantScoped,
      },
      () => inventoryService.getMovements(actor, id),
    );
  });

  // --- Reservation Endpoints ---

  // POST /inventory/reservations (Create concurrency-safe reservation)
  app.post('/inventory/reservations', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const body = request.body as {
      inventoryId?: unknown;
      listingId?: unknown;
      quantity?: unknown;
      idempotencyKey?: unknown;
      expiresAt?: unknown;
    };

    if (typeof body.quantity !== 'number') throw new ValidationError('quantity is required');

    const reservation = await inventoryService.createReservation(actor, {
      inventoryId: typeof body.inventoryId === 'string' ? body.inventoryId : undefined,
      listingId: typeof body.listingId === 'string' ? body.listingId : undefined,
      quantity: body.quantity,
      idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined,
    });

    return reply.status(201).send(reservation);
  });

  // GET /inventory/reservations/:id
  app.get('/inventory/reservations/:id', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    const reservation = await inventoryService.getReservationById(actor, id);
    return reply.status(200).send(reservation);
  });

  // POST /inventory/reservations/:id/release
  app.post(
    '/inventory/reservations/:id/release',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = (request.body as { notes?: unknown } | undefined) ?? {};
      const reservation = await inventoryService.releaseReservation(
        actor,
        id,
        typeof body.notes === 'string' ? body.notes : undefined,
      );
      return reply.status(200).send(reservation);
    },
  );

  // POST /inventory/reservations/:id/consume
  app.post(
    '/inventory/reservations/:id/consume',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = (request.body as { notes?: unknown } | undefined) ?? {};
      const reservation = await inventoryService.consumeReservation(
        actor,
        id,
        typeof body.notes === 'string' ? body.notes : undefined,
      );
      return reply.status(200).send(reservation);
    },
  );

  // POST /inventory/reservations/:id/expire (Administrative / system expiration trigger)
  app.post(
    '/inventory/reservations/:id/expire',
    { preHandler: authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body as { notes?: unknown } | undefined) ?? {};
      const reservation = await inventoryService.expireReservation(
        id,
        typeof body.notes === 'string' ? body.notes : undefined,
      );
      return reply.status(200).send(reservation);
    },
  );

  // POST /inventory/reservations/process-expirations (Admin trigger for batch expiration)
  app.post(
    '/inventory/reservations/process-expirations',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      if (actor.role !== 'ADMINISTRATOR') {
        throw new ValidationError(
          'Only platform administrators can trigger inventory expiration processing',
        );
      }

      const body = (request.body as { batchSize?: unknown } | undefined) ?? {};
      const batchSize = typeof body.batchSize === 'number' ? body.batchSize : 50;

      const processedCount = await inventoryService.processExpirations(batchSize);
      return reply.status(200).send({ processedCount });
    },
  );
}
