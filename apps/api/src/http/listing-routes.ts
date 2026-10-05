import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { ListingService } from '../modules/marketplace/index.js';
import type { ListingStatus } from '../modules/marketplace/index.js';
import { createAuthMiddleware, createOptionalAuthMiddleware, requireActor } from './auth-middleware.js';
import { ValidationError } from '../errors/app-error.js';

export function registerListingRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  listingService: ListingService,
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

      const listings = await listingService.getMyListings(actor, {
        status: query.status,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });

      return reply.status(200).send(listings);
    },
  );

  // GET /listings/me/detail (Merchant console view: listings with product
  // display content and inventory levels — no raw IDs to manage)
  app.get(
    '/listings/me/detail',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const details = await listingService.getMyListingDetails(actor);
      return reply.status(200).send(details);
    },
  );

  // GET /listings/:id (Merchant gets own, admin gets any, public gets if active)
  app.get(
    '/listings/:id',
    { preHandler: optionalAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const actor = request.actor ?? null;
      const listing = await listingService.getListingById(actor, id);
      return reply.status(200).send(listing);
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
      return reply.status(200).send(listing);
    },
  );

  // GET /skus/:skuId/listings (Marketplace multi-vendor view: compare active listings for a SKU)
  app.get(
    '/skus/:skuId/listings',
    { preHandler: optionalAuth },
    async (request, reply) => {
      const { skuId } = request.params as { skuId: string };
      const listings = await listingService.getActiveListingsForSku(skuId);
      return reply.status(200).send(listings);
    },
  );
}
