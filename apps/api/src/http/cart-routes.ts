import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { CartService, ICartService } from '../modules/cart-checkout/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import { ValidationError } from '../errors/app-error.js';

export function registerCartRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  cartService: ICartService | CartService,
): void {
  const authenticate = createAuthMiddleware(identityService);

  // GET /cart: Retrieve or initialize active cart for authenticated customer
  app.get(
    '/cart',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const cart = await cartService.getOrCreateCart(actor);
      return reply.status(200).send(cart);
    },
  );

  // POST /cart/items: Add item to cart
  app.post(
    '/cart/items',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = request.body as {
        listingId?: unknown;
        quantity?: unknown;
      };

      if (typeof body.listingId !== 'string') {
        throw new ValidationError('listingId is required');
      }
      if (typeof body.quantity !== 'number') {
        throw new ValidationError('quantity is required');
      }

      const cart = await cartService.addItem(actor, {
        listingId: body.listingId,
        quantity: body.quantity,
      });

      return reply.status(200).send(cart);
    },
  );

  // PATCH /cart/items/:itemId: Update cart item quantity
  app.patch(
    '/cart/items/:itemId',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { itemId } = request.params as { itemId: string };
      const body = request.body as { quantity?: unknown };

      if (typeof body.quantity !== 'number') {
        throw new ValidationError('quantity is required');
      }

      const cart = await cartService.updateItemQuantity(actor, itemId, {
        quantity: body.quantity,
      });

      return reply.status(200).send(cart);
    },
  );

  // DELETE /cart/items/:itemId: Remove item from cart
  app.delete(
    '/cart/items/:itemId',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { itemId } = request.params as { itemId: string };

      const cart = await cartService.removeItem(actor, itemId);
      return reply.status(200).send(cart);
    },
  );

  // DELETE /cart: Clear entire cart
  app.delete(
    '/cart',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const cart = await cartService.clearCart(actor);
      return reply.status(200).send(cart);
    },
  );
}
