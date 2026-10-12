import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { WishlistService } from '../modules/customer/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import { ValidationError } from '../errors/app-error.js';

export function registerWishlistRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  wishlistService: WishlistService,
): void {
  const authenticate = createAuthMiddleware(identityService);
  const routePrefixes = ['', '/api/v1'];

  for (const prefix of routePrefixes) {
    // GET /customer/wishlist: List customer wishlist with resolved live offers & availability
    app.get(`${prefix}/customer/wishlist`, { preHandler: authenticate }, async (request, reply) => {
      const actor = requireActor(request);
      const wishlist = await wishlistService.listWishlist(actor);
      return reply.status(200).send(wishlist);
    });

    // POST /customer/wishlist: Add product to customer wishlist
    app.post(
      `${prefix}/customer/wishlist`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const body = request.body as {
          productId?: unknown;
          skuId?: unknown;
        };

        if (typeof body.productId !== 'string' || !body.productId.trim()) {
          throw new ValidationError('productId is required and must be a string');
        }

        const wishlistItem = await wishlistService.addToWishlist(actor, {
          productId: body.productId.trim(),
          skuId: typeof body.skuId === 'string' ? body.skuId.trim() : undefined,
        });

        return reply.status(201).send(wishlistItem);
      },
    );

    // DELETE /customer/wishlist/:productId: Remove product from customer wishlist
    app.delete(
      `${prefix}/customer/wishlist/:productId`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { productId } = request.params as { productId: string };

        await wishlistService.removeFromWishlist(actor, productId);
        return reply.status(204).send();
      },
    );

    // GET /customer/wishlist/check/:productId: Check whether product is in wishlist
    app.get(
      `${prefix}/customer/wishlist/check/:productId`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { productId } = request.params as { productId: string };

        const checkResult = await wishlistService.checkWishlistStatus(actor, productId);
        return reply.status(200).send(checkResult);
      },
    );

    // POST /customer/wishlist/save-for-later: Save cart item for later into wishlist
    app.post(
      `${prefix}/customer/wishlist/save-for-later`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const body = request.body as { cartItemId?: unknown };

        if (typeof body.cartItemId !== 'string' || !body.cartItemId.trim()) {
          throw new ValidationError('cartItemId is required and must be a string');
        }

        const result = await wishlistService.saveForLater(actor, {
          cartItemId: body.cartItemId.trim(),
        });

        return reply.status(200).send(result);
      },
    );

    // POST /customer/wishlist/:productId/move-to-cart: Move wishlist item to active cart
    app.post(
      `${prefix}/customer/wishlist/:productId/move-to-cart`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { productId } = request.params as { productId: string };
        const body = (request.body as { listingId?: unknown } | undefined) ?? {};

        const result = await wishlistService.moveToCart(actor, productId, {
          listingId: typeof body.listingId === 'string' ? body.listingId.trim() : undefined,
        });

        return reply.status(200).send(result);
      },
    );
  }
}
