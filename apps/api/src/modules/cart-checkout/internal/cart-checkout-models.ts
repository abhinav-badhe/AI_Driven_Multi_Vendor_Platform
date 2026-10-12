import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  CartItemDto,
  CartDto,
  AddCartItemInput,
  UpdateCartItemQuantityInput,
} from './cart-service.js';
import type {
  CheckoutItemDto,
  CheckoutSessionDto,
  CreateCheckoutSessionInput,
} from './checkout-service.js';
import type { CheckoutStatus } from './checkout-repository.js';
import type { AddressSnapshot } from '../../customer/index.js';

export type {
  CartItemDto,
  CartDto,
  AddCartItemInput,
  UpdateCartItemQuantityInput,
  CheckoutItemDto,
  CheckoutSessionDto,
  CreateCheckoutSessionInput,
  CheckoutStatus,
  AddressSnapshot,
};

/**
 * ICartReader - Decoupled read interface for shopping cart.
 */
export interface ICartReader {
  getOrCreateCart(actor: AuthorizedActor): Promise<CartDto>;
}

/**
 * ICartService - Full shopping cart management interface.
 * Implemented by local SQL CartService, InMemoryCartStore, and HttpCartClient.
 */
export interface ICartService extends ICartReader {
  addItem(actor: AuthorizedActor, input: AddCartItemInput): Promise<CartDto>;
  updateItemQuantity(
    actor: AuthorizedActor,
    itemId: string,
    input: UpdateCartItemQuantityInput,
  ): Promise<CartDto>;
  removeItem(actor: AuthorizedActor, itemId: string): Promise<CartDto>;
  clearCart(actor: AuthorizedActor): Promise<CartDto>;
}

/**
 * ICheckoutReader - Decoupled read interface for checkout session lookup.
 * Consumed by Payment and Orders domains.
 */
export interface ICheckoutReader {
  getCheckoutSession(actor: AuthorizedActor, sessionId: string): Promise<CheckoutSessionDto>;
}

/**
 * ICheckoutService - Full checkout session lifecycle interface.
 * Implemented by local SQL CheckoutService, InMemoryCheckoutStore, and HttpCheckoutClient.
 */
export interface ICheckoutService extends ICheckoutReader {
  createCheckoutSession(
    actor: AuthorizedActor,
    input?: CreateCheckoutSessionInput,
  ): Promise<CheckoutSessionDto>;
  setShippingAddress(
    actor: AuthorizedActor,
    sessionId: string,
    input: {
      addressId?: string | null | undefined;
      shippingAddress?: AddressSnapshot | Record<string, unknown> | null | undefined;
    },
  ): Promise<CheckoutSessionDto>;
  reserveCheckoutInventory(actor: AuthorizedActor, sessionId: string): Promise<CheckoutSessionDto>;
  expireCheckoutSession(actor: AuthorizedActor, sessionId: string): Promise<CheckoutSessionDto>;
  cancelCheckoutSession(actor: AuthorizedActor, sessionId: string): Promise<CheckoutSessionDto>;
}
