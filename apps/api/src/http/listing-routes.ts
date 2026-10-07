import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { ListingService } from '../modules/marketplace/index.js';
import type { PriceAlertService } from '../modules/price-alerts/index.js';
import type { ListingStatus } from '../modules/marketplace/index.js';
import { createAuthMiddleware, createOptionalAuthMiddleware, requireActor } from './auth-middleware.js';
import { ValidationError } from '../errors/app-error.js';
import {
  CachePresets,
  CacheTags,
  cacheKey,
  sendCached,
  visibilityClass,
} from './cache-helper.js';

export function registerListingRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  listingService: ListingService,
  priceAlertService?: PriceAlertService,
): void {
  const authenticate = createAuthMiddleware(identityService);
  const optionalAuth = createOptionalAuthMiddleware(identityService);

  // POST /listings (Merchant create listing; tenant derived strictly from authenticated actor)
  app.post(
    '/listings',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = request.body as {
        skuId?: unknown;
        priceAmount?: unknown;
        currency?: unknown;
        compareAtPrice?: unknown;
      };

      if (typeof body.skuId !== 'string') throw new ValidationError('skuId is required');
      if (typeof body.priceAmount !== 'number') throw new ValidationError('priceAmount is required and must be a number');
      if (typeof body.currency !== 'string') throw new ValidationError('currency is required');

      const listing = await listingService.createListing(actor, {
        skuId: body.skuId,
        priceAmount: body.priceAmount,
        currency: body.currency,
        compareAtPrice: typeof body.compareAtPrice === 'number' ? body.compareAtPrice : undefined,
      });

      await app.cache.invalidateTags(
        CacheTags.listings,
        `${CacheTags.listings}:merchant:${actor.tenantId}`,
        `${CacheTags.listings}:sku:${body.skuId}`,
      );
      return reply.status(201).send(listing);
    },
  );

  // GET /listings/me (Merchant list own listings)
  app.get(
    '/listings/me',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const query = request.query as {
        status?: ListingStatus;
        limit?: string;
        offset?: string;
      };

      const status = query.status ?? 'all';
      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('listings', 'me', actor.tenantId, status, query.limit ?? '', query.offset ?? ''),
          tags: [CacheTags.listings, `${CacheTags.listings}:merchant:${actor.tenantId}`],
          preset: CachePresets.merchantScoped,
        },
        () =>
          listingService.getMyListings(actor, {
            status: query.status,
            limit: query.limit ? parseInt(query.limit, 10) : undefined,
            offset: query.offset ? parseInt(query.offset, 10) : undefined,
          }),
      );
    },
  );

  // GET /listings/me/detail (Merchant console view: listings with product
  // display content and inventory levels — no raw IDs to manage)
  app.get(
    '/listings/me/detail',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('listings', 'me', 'detail', actor.tenantId),
          tags: [CacheTags.listings, `${CacheTags.listings}:merchant:${actor.tenantId}`],
          preset: CachePresets.merchantScoped,
        },
        () => listingService.getMyListingDetails(actor),
      );
    },
  );

  // GET /listings/:id (Merchant gets own, admin gets any, public gets if active)
  // Visibility depends on role AND tenant, so both are part of the key.
  app.get(
    '/listings/:id',
    { preHandler: optionalAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const actor = request.actor ?? null;
      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('listings', id, visibilityClass(request), actor?.tenantId ?? 'anon'),
          tags: [CacheTags.listings, `${CacheTags.listings}:${id}`],
          preset: CachePresets.listing,
        },
        () => listingService.getListingById(actor, id),
      );
    },
  );

  // PATCH /listings/:id (Merchant update own listing price/commercials)
  app.patch(
    '/listings/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        priceAmount?: number;
        currency?: string;
        compareAtPrice?: number | null;
      };

      const listing = await listingService.updateListing(actor, id, {
        priceAmount: typeof body.priceAmount === 'number' ? body.priceAmount : undefined,
        currency: typeof body.currency === 'string' ? body.currency : undefined,
        compareAtPrice: body.compareAtPrice !== undefined ? body.compareAtPrice : undefined,
      });

      // Price-drop check runs inline (cheap record creation; actual email
      // delivery stays queued behind the notification relay).
      if (typeof body.priceAmount === 'number' && priceAlertService) {
        await priceAlertService.checkListing(id);
      }

      // Price/status changes affect the compare view, search documents and
      // detail reads — invalidate them together with the listing entry.
      await app.cache.invalidateTags(
        CacheTags.listings,
        `${CacheTags.listings}:${id}`,
        `${CacheTags.listings}:merchant:${listing.tenantId}`,
        `${CacheTags.listings}:sku:${listing.skuId}`,
        CacheTags.search,
      );
      return reply.status(200).send(listing);
    },
  );

  // POST /listings/:id/status (Merchant transitions own status; Admin can suspend/manage any)
  app.post(
    '/listings/:id/status',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = request.body as { status?: unknown };

      if (typeof body.status !== 'string') throw new ValidationError('status is required');

      const listing = await listingService.setListingStatus(actor, id, body.status as ListingStatus);
      await app.cache.invalidateTags(
        CacheTags.listings,
        `${CacheTags.listings}:${id}`,
        `${CacheTags.listings}:merchant:${listing.tenantId}`,
        `${CacheTags.listings}:sku:${listing.skuId}`,
        CacheTags.search,
      );
      return reply.status(200).send(listing);
    },
  );

  // GET /skus/:skuId/listings (Marketplace multi-vendor view: compare active listings for a SKU)
  app.get(
    '/skus/:skuId/listings',
    { preHandler: optionalAuth },
    async (request, reply) => {
      const { skuId } = request.params as { skuId: string };
      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('skus', skuId, 'listings'),
          tags: [CacheTags.listings, `${CacheTags.listings}:sku:${skuId}`],
          preset: CachePresets.listing,
        },
        () => listingService.getActiveListingsForSku(skuId),
      );
    },
  );
}
