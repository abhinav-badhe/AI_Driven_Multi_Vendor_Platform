import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { CatalogService } from '../modules/catalog/index.js';
import type { ProductStatus, SkuStatus } from '../modules/catalog/index.js';
import { createAuthMiddleware, createOptionalAuthMiddleware, requireActor } from './auth-middleware.js';
import { ValidationError } from '../errors/app-error.js';

export function registerCatalogRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  catalogService: CatalogService,
): void {
  const authenticate = createAuthMiddleware(identityService);
  const optionalAuth = createOptionalAuthMiddleware(identityService);

  // --- Category Routes ---

  // POST /categories (Admin only)
  app.post(
    '/categories',
    { preHandler: authenticate },
    async (request, reply) => {
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

      return reply.status(201).send(category);
    },
  );

  // GET /categories
  app.get(
    '/categories',
    { preHandler: optionalAuth },
    async (_request, reply) => {
      const categories = await catalogService.listCategories();
      return reply.status(200).send(categories);
    },
  );

  // GET /categories/:id
  app.get(
    '/categories/:id',
    { preHandler: optionalAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const category = await catalogService.getCategoryById(id);
      return reply.status(200).send(category);
    },
  );

  // --- Product Routes ---

  // POST /products (Admin only)
  app.post(
    '/products',
    { preHandler: authenticate },
    async (request, reply) => {
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

      return reply.status(201).send(product);
    },
  );

  // GET /products
  app.get(
    '/products',
    { preHandler: optionalAuth },
    async (request, reply) => {
      const query = request.query as {
        categoryId?: string;
        status?: ProductStatus;
        search?: string;
        limit?: string;
        offset?: string;
      };

      const products = await catalogService.listProducts({
        categoryId: query.categoryId,
        status: query.status,
        search: query.search,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });

      return reply.status(200).send(products);
    },
  );

  // GET /products/:id
  app.get(
    '/products/:id',
    { preHandler: optionalAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const product = await catalogService.getProductById(id);
      return reply.status(200).send(product);
    },
  );

  // GET /products/:id/reviews (public customer reviews for a canonical product)
  app.get(
    '/products/:id/reviews',
    { preHandler: optionalAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const reviews = await catalogService.listProductReviews(id);
      return reply.status(200).send(reviews);
    },
  );

  // PATCH /products/:id (Admin only)
  app.patch(
    '/products/:id',
    { preHandler: authenticate },
    async (request, reply) => {
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

      return reply.status(200).send(product);
    },
  );

  // POST /products/:id/status (Admin only)
  app.post(
    '/products/:id/status',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = request.body as { status?: unknown };

      if (typeof body.status !== 'string') throw new ValidationError('status is required');

      const product = await catalogService.setProductStatus(actor, id, body.status as ProductStatus);
      return reply.status(200).send(product);
    },
  );

  // --- SKU Routes ---

  // POST /products/:id/skus (Admin only)
  app.post(
    '/products/:id/skus',
    { preHandler: authenticate },
    async (request, reply) => {
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

      return reply.status(201).send(sku);
    },
  );

  // GET /products/:id/skus
  app.get(
    '/products/:id/skus',
    { preHandler: optionalAuth },
    async (request, reply) => {
      const { id: productId } = request.params as { id: string };
      const actor = request.actor ?? null;
      const skus = await catalogService.listSkusByProduct(productId, actor);
      return reply.status(200).send(skus);
    },
  );

  // GET /skus/:id
  app.get(
    '/skus/:id',
    { preHandler: optionalAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const sku = await catalogService.getSkuById(id);
      return reply.status(200).send(sku);
    },
  );

  // PATCH /skus/:id (Admin only)
  app.patch(
    '/skus/:id',
    { preHandler: authenticate },
    async (request, reply) => {
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

      return reply.status(200).send(sku);
    },
  );

  // POST /skus/:id/status (Admin only)
  app.post(
    '/skus/:id/status',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = request.body as { status?: unknown };

      if (typeof body.status !== 'string') throw new ValidationError('status is required');

      const sku = await catalogService.setSkuStatus(actor, id, body.status as SkuStatus);
      return reply.status(200).send(sku);
    },
  );
}
