import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { CatalogService, ICatalogService } from '../modules/catalog/index.js';
import type { ProductStatus, SkuStatus } from '../modules/catalog/index.js';
import {
  createAuthMiddleware,
  createOptionalAuthMiddleware,
  requireActor,
} from './auth-middleware.js';
import { ValidationError } from '../errors/app-error.js';
import { CachePresets, CacheTags, cacheKey, sendCached, visibilityClass } from './cache-helper.js';

export function registerCatalogRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  catalogService: ICatalogService | CatalogService,
): void {
  const authenticate = createAuthMiddleware(identityService);
  const optionalAuth = createOptionalAuthMiddleware(identityService);

  // --- Category Routes ---

  // POST /categories (Admin only)
  app.post('/categories', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const body = request.body as {
      name?: unknown;
      slug?: unknown;
      parentId?: unknown;
    };

    if (typeof body.name !== 'string') throw new ValidationError('name is required');
    if (typeof body.slug !== 'string') throw new ValidationError('slug is required');

    const category = await catalogService.createCategory(actor, {
      name: body.name,
      slug: body.slug,
      parentId: typeof body.parentId === 'string' ? body.parentId : null,
    });

    await app.cache.invalidateTags(CacheTags.categories, CacheTags.search);
    return reply.status(201).send(category);
  });

  // GET /categories
  app.get('/categories', { preHandler: optionalAuth }, async (request, reply) => {
    return sendCached(
      app,
      request,
      reply,
      {
        key: cacheKey('categories', 'list'),
        tags: [CacheTags.categories],
        preset: CachePresets.categories,
      },
      () => catalogService.listCategories(),
    );
  });

  // GET /categories/:id
  app.get('/categories/:id', { preHandler: optionalAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return sendCached(
      app,
      request,
      reply,
      {
        key: cacheKey('categories', id),
        tags: [CacheTags.categories, `${CacheTags.categories}:${id}`],
        preset: CachePresets.categories,
      },
      () => catalogService.getCategoryById(id),
    );
  });

  // --- Product Routes ---

  // POST /products (Admin only)
  app.post('/products', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const body = request.body as {
      title?: unknown;
      slug?: unknown;
      description?: unknown;
      brand?: unknown;
      categoryId?: unknown;
      thumbnailUrl?: unknown;
      images?: unknown;
      attributes?: unknown;
    };

    if (typeof body.title !== 'string') throw new ValidationError('title is required');
    if (typeof body.slug !== 'string') throw new ValidationError('slug is required');

    const product = await catalogService.createProduct(actor, {
      title: body.title,
      slug: body.slug,
      description: typeof body.description === 'string' ? body.description : undefined,
      brand: typeof body.brand === 'string' ? body.brand : undefined,
      categoryId: typeof body.categoryId === 'string' ? body.categoryId : undefined,
      thumbnailUrl: typeof body.thumbnailUrl === 'string' ? body.thumbnailUrl : undefined,
      images: Array.isArray(body.images)
        ? body.images.filter((v): v is string => typeof v === 'string')
        : undefined,
      attributes:
        typeof body.attributes === 'object' && body.attributes !== null
          ? (body.attributes as Record<string, unknown>)
          : undefined,
    });

    await app.cache.invalidateTags(CacheTags.products, CacheTags.search);
    return reply.status(201).send(product);
  });

  // GET /products
  app.get('/products', { preHandler: optionalAuth }, async (request, reply) => {
    const query = request.query as {
      categoryId?: string;
      status?: ProductStatus;
      search?: string;
      limit?: string;
      offset?: string;
    };

    // Normalized key: only defined filters, sorted, so equivalent
    // queries share one entry regardless of parameter order.
    const filterParts = [
      query.categoryId ? `cat=${query.categoryId}` : '',
      query.status ? `status=${query.status}` : '',
      query.search ? `q=${query.search}` : '',
      query.limit ? `limit=${query.limit}` : '',
      query.offset ? `offset=${query.offset}` : '',
    ]
      .filter((p) => p.length > 0)
      .sort();

    return sendCached(
      app,
      request,
      reply,
      {
        key: cacheKey('products', 'list', ...filterParts),
        tags: [CacheTags.products],
        preset: CachePresets.catalogList,
      },
      () =>
        catalogService.listProducts({
          categoryId: query.categoryId,
          status: query.status,
          search: query.search,
          limit: query.limit ? parseInt(query.limit, 10) : undefined,
          offset: query.offset ? parseInt(query.offset, 10) : undefined,
        }),
    );
  });

  // GET /products/:id
  app.get('/products/:id', { preHandler: optionalAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return sendCached(
      app,
      request,
      reply,
      {
        key: cacheKey('products', id),
        tags: [CacheTags.products, `${CacheTags.products}:${id}`],
        preset: CachePresets.catalogDetail,
      },
      () => catalogService.getProductById(id),
    );
  });

  // PATCH /products/:id (Admin only)
  app.patch('/products/:id', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    const body = request.body as {
      title?: string;
      slug?: string;
      description?: string;
      brand?: string;
      categoryId?: string;
      thumbnailUrl?: string;
      images?: string[];
      attributes?: Record<string, unknown>;
    };

    const product = await catalogService.updateProduct(actor, id, {
      title: typeof body.title === 'string' ? body.title : undefined,
      slug: typeof body.slug === 'string' ? body.slug : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      brand: typeof body.brand === 'string' ? body.brand : undefined,
      categoryId: typeof body.categoryId === 'string' ? body.categoryId : undefined,
      thumbnailUrl: typeof body.thumbnailUrl === 'string' ? body.thumbnailUrl : undefined,
      images: Array.isArray(body.images)
        ? body.images.filter((v): v is string => typeof v === 'string')
        : undefined,
      attributes:
        typeof body.attributes === 'object' && body.attributes !== null
          ? body.attributes
          : undefined,
    });

    await app.cache.invalidateTags(
      CacheTags.products,
      `${CacheTags.products}:${id}`,
      CacheTags.search,
    );
    return reply.status(200).send(product);
  });

  // POST /products/:id/status (Admin only)
  app.post('/products/:id/status', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    const body = request.body as { status?: unknown };

    if (typeof body.status !== 'string') throw new ValidationError('status is required');

    const product = await catalogService.setProductStatus(actor, id, body.status as ProductStatus);
    await app.cache.invalidateTags(
      CacheTags.products,
      `${CacheTags.products}:${id}`,
      CacheTags.search,
    );
    return reply.status(200).send(product);
  });

  // --- SKU Routes ---

  // POST /products/:id/skus (Admin only)
  app.post('/products/:id/skus', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const { id: productId } = request.params as { id: string };
    const body = request.body as {
      skuCode?: unknown;
      barcode?: unknown;
      attributes?: unknown;
    };

    if (typeof body.skuCode !== 'string') throw new ValidationError('skuCode is required');

    const sku = await catalogService.createSku(actor, productId, {
      skuCode: body.skuCode,
      barcode: typeof body.barcode === 'string' ? body.barcode : undefined,
      attributes:
        typeof body.attributes === 'object' && body.attributes !== null
          ? (body.attributes as Record<string, unknown>)
          : undefined,
    });

    await app.cache.invalidateTags(
      CacheTags.skus,
      `${CacheTags.products}:${productId}`,
      CacheTags.search,
    );
    return reply.status(201).send(sku);
  });

  // GET /products/:id/skus
  // Visibility varies by role (admins see non-active SKUs), so the role is
  // part of the key — a public entry can never serve an admin view.
  app.get('/products/:id/skus', { preHandler: optionalAuth }, async (request, reply) => {
    const { id: productId } = request.params as { id: string };
    const actor = request.actor ?? null;
    return sendCached(
      app,
      request,
      reply,
      {
        key: cacheKey('products', productId, 'skus', visibilityClass(request)),
        tags: [CacheTags.skus, `${CacheTags.products}:${productId}`],
        preset: CachePresets.catalogDetail,
      },
      () => catalogService.listSkusByProduct(productId, actor),
    );
  });

  // GET /skus/:id
  app.get('/skus/:id', { preHandler: optionalAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return sendCached(
      app,
      request,
      reply,
      {
        key: cacheKey('skus', id),
        tags: [CacheTags.skus, `${CacheTags.skus}:${id}`],
        preset: CachePresets.catalogDetail,
      },
      () => catalogService.getSkuById(id),
    );
  });

  // PATCH /skus/:id (Admin only)
  app.patch('/skus/:id', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    const body = request.body as {
      skuCode?: string;
      barcode?: string;
      attributes?: Record<string, unknown>;
    };

    const sku = await catalogService.updateSku(actor, id, {
      skuCode: typeof body.skuCode === 'string' ? body.skuCode : undefined,
      barcode: typeof body.barcode === 'string' ? body.barcode : undefined,
      attributes:
        typeof body.attributes === 'object' && body.attributes !== null
          ? body.attributes
          : undefined,
    });

    await app.cache.invalidateTags(
      CacheTags.skus,
      `${CacheTags.skus}:${id}`,
      `${CacheTags.products}:${sku.productId}`,
      CacheTags.search,
    );
    return reply.status(200).send(sku);
  });

  // POST /skus/:id/status (Admin only)
  app.post('/skus/:id/status', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    const body = request.body as { status?: unknown };

    if (typeof body.status !== 'string') throw new ValidationError('status is required');

    const sku = await catalogService.setSkuStatus(actor, id, body.status as SkuStatus);
    await app.cache.invalidateTags(
      CacheTags.skus,
      `${CacheTags.skus}:${id}`,
      `${CacheTags.products}:${sku.productId}`,
      CacheTags.search,
    );
    return reply.status(200).send(sku);
  });
}
