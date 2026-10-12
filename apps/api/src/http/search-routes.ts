import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { SearchService } from '../modules/search/index.js';
import type { SearchQueryParams, SearchSortBy } from '../modules/search/index.js';
import {
  createAuthMiddleware,
  createOptionalAuthMiddleware,
  requireActor,
} from './auth-middleware.js';
import { ValidationError, ForbiddenError } from '../errors/app-error.js';
import { CachePresets, CacheTags, cacheKey, sendCached, visibilityClass } from './cache-helper.js';

export function registerSearchRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  searchService: SearchService,
): void {
  const authenticate = createAuthMiddleware(identityService);
  const optionalAuth = createOptionalAuthMiddleware(identityService);

  // 1. GET /search (Public & Authenticated Search Endpoint)
  app.get('/search', { preHandler: optionalAuth }, async (request, reply) => {
    const actor = request.actor ?? null;
    const query = request.query as Record<string, string | undefined>;

    let minPrice: number | undefined;
    if (query.minPrice !== undefined) {
      minPrice = Number(query.minPrice);
      if (Number.isNaN(minPrice)) {
        throw new ValidationError('minPrice must be a valid number');
      }
    }

    let maxPrice: number | undefined;
    if (query.maxPrice !== undefined) {
      maxPrice = Number(query.maxPrice);
      if (Number.isNaN(maxPrice)) {
        throw new ValidationError('maxPrice must be a valid number');
      }
    }

    let page: number | undefined;
    if (query.page !== undefined) {
      page = Number(query.page);
      if (Number.isNaN(page)) {
        throw new ValidationError('page must be an integer');
      }
    }

    let pageSize: number | undefined;
    if (query.pageSize !== undefined) {
      pageSize = Number(query.pageSize);
      if (Number.isNaN(pageSize)) {
        throw new ValidationError('pageSize must be an integer');
      }
    }

    const inStock = query.inStock === 'true' ? true : query.inStock === 'false' ? false : undefined;

    const includeInactive = query.includeInactive === 'true';

    const searchParams: SearchQueryParams = {
      q: query.q,
      categoryId: query.categoryId,
      merchantId: query.merchantId,
      brand: query.brand,
      minPrice,
      maxPrice,
      inStock,
      sortBy: query.sortBy as SearchSortBy | undefined,
      page,
      pageSize,
      includeInactive,
    };

    // Normalized key over every effective filter plus the visibility
    // class (includeInactive is privilege-gated).
    const keyParts = [
      `q=${searchParams.q ?? ''}`,
      `cat=${searchParams.categoryId ?? ''}`,
      `mer=${searchParams.merchantId ?? ''}`,
      `brand=${searchParams.brand ?? ''}`,
      `min=${searchParams.minPrice ?? ''}`,
      `max=${searchParams.maxPrice ?? ''}`,
      `stock=${searchParams.inStock ?? ''}`,
      `sort=${searchParams.sortBy ?? ''}`,
      `page=${searchParams.page ?? ''}`,
      `size=${searchParams.pageSize ?? ''}`,
      `incl=${includeInactive ? '1' : '0'}`,
      `vis=${visibilityClass(request)}`,
    ].sort();

    return sendCached(
      app,
      request,
      reply,
      {
        key: cacheKey('search', ...keyParts),
        tags: [CacheTags.search],
        preset: CachePresets.search,
      },
      () => searchService.search(actor, searchParams),
    );
  });

  // 2. GET /search/documents/:id (Fetch Single Search Document)
  app.get('/search/documents/:id', { preHandler: optionalAuth }, async (request, reply) => {
    const actor = request.actor ?? null;
    const { id } = request.params as { id: string };

    return sendCached(
      app,
      request,
      reply,
      {
        key: cacheKey('search', 'documents', id, visibilityClass(request)),
        tags: [CacheTags.search, `${CacheTags.search}:doc:${id}`],
        preset: CachePresets.search,
      },
      () => searchService.getDocumentById(actor, id),
    );
  });

  // 3. POST /search/rebuild (Admin Projection Rebuild)
  app.post('/search/rebuild', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can trigger projection rebuild');
    }

    const result = await searchService.rebuildProjection(actor);
    await app.cache.invalidateTags(CacheTags.search);
    return reply.status(200).send(result);
  });

  // 4. POST /search/sync/product (Admin Manual Sync: Authoritative Source Integration)
  app.post('/search/sync/product', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can sync product projections');
    }

    const body = request.body as Record<string, unknown>;
    if (!body.productId || typeof body.productId !== 'string') {
      throw new ValidationError('productId is required');
    }

    // Prioritize authoritative synchronization from domain source (prevents version poisoning)
    let result;
    try {
      result = await searchService.syncProductFromAuthoritativeSource(body.productId);
    } catch (err: unknown) {
      // If not in catalog, allow direct projection update if valid typed contract is supplied (for testing)
      if (
        typeof body.title === 'string' &&
        typeof body.slug === 'string' &&
        typeof body.sourceVersion === 'number'
      ) {
        result = await searchService.upsertProductProjection({
          productId: body.productId,
          title: body.title,
          slug: body.slug,
          description: typeof body.description === 'string' ? body.description : null,
          brand: typeof body.brand === 'string' ? body.brand : null,
          categoryId: typeof body.categoryId === 'string' ? body.categoryId : null,
          categoryName: typeof body.categoryName === 'string' ? body.categoryName : null,
          status: (body.status as 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED') ?? 'ACTIVE',
          attributes: (body.attributes as Record<string, unknown>) ?? {},
          sourceVersion: body.sourceVersion,
        });
      } else {
        throw err;
      }
    }

    await app.cache.invalidateTags(CacheTags.search, `${CacheTags.search}:doc:${body.productId}`);
    return reply.status(200).send(result);
  });

  // 5. POST /search/sync/listing (Admin Manual Sync: Authoritative Source Integration)
  app.post('/search/sync/listing', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can sync listing projections');
    }

    const body = request.body as Record<string, unknown>;
    if (!body.listingId || typeof body.listingId !== 'string') {
      throw new ValidationError('listingId is required');
    }

    // Prioritize authoritative synchronization from domain source (prevents version poisoning)
    let result;
    try {
      result = await searchService.syncListingFromAuthoritativeSource(body.listingId);
    } catch (err: unknown) {
      if (
        typeof body.merchantId === 'string' &&
        typeof body.productId === 'string' &&
        typeof body.skuId === 'string' &&
        typeof body.skuCode === 'string' &&
        typeof body.priceAmount === 'number' &&
        typeof body.currency === 'string' &&
        typeof body.sourceVersion === 'number'
      ) {
        result = await searchService.upsertListingProjection({
          listingId: body.listingId,
          merchantId: body.merchantId,
          merchantName: typeof body.merchantName === 'string' ? body.merchantName : undefined,
          productId: body.productId,
          skuId: body.skuId,
          skuCode: body.skuCode,
          priceAmount: body.priceAmount,
          currency: body.currency,
          compareAtPrice: typeof body.compareAtPrice === 'number' ? body.compareAtPrice : null,
          status: (body.status as 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED') ?? 'ACTIVE',
          inStock: body.inStock === true,
          availableQuantity:
            typeof body.availableQuantity === 'number' ? body.availableQuantity : 0,
          attributes: (body.attributes as Record<string, unknown>) ?? {},
          sourceVersion: body.sourceVersion,
        });
      } else {
        throw err;
      }
    }

    await app.cache.invalidateTags(CacheTags.search, `${CacheTags.search}:doc:${body.listingId}`);
    return reply.status(200).send(result);
  });

  // 6. DELETE /search/sync/product/:id (Remove Product Projection)
  app.delete('/search/sync/product/:id', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can remove search projections');
    }

    const { id } = request.params as { id: string };
    const removed = await searchService.removeProductProjection(id);
    await app.cache.invalidateTags(CacheTags.search, `${CacheTags.search}:doc:${id}`);
    return reply.status(200).send({ removed });
  });

  // 7. DELETE /search/sync/product/:productId/listings/:listingId (Remove Listing Offer)
  app.delete(
    '/search/sync/product/:productId/listings/:listingId',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      if (actor.role !== 'ADMINISTRATOR') {
        throw new ForbiddenError('Only platform administrators can remove listing projections');
      }

      const { productId, listingId } = request.params as {
        productId: string;
        listingId: string;
      };
      const removed = await searchService.removeListingProjection(productId, listingId);
      await app.cache.invalidateTags(
        CacheTags.search,
        `${CacheTags.search}:doc:${productId}`,
        `${CacheTags.search}:doc:${listingId}`,
      );
      return reply.status(200).send({ removed });
    },
  );
}
