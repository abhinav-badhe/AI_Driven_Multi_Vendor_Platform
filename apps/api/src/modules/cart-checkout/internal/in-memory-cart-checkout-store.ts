import { randomUUID } from 'node:crypto';
import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import { RbacPolicy } from '../../identity/rbac/policy.js';
import type {
  ICartService,
  ICheckoutService,
  CartDto,
  CartItemDto,
  AddCartItemInput,
  UpdateCartItemQuantityInput,
  CheckoutSessionDto,
  CheckoutItemDto,
  CreateCheckoutSessionInput,
  AddressSnapshot,
} from './cart-checkout-models.js';
import {
  ValidationError,
  NotFoundError,
  EmptyCartError,
  InvalidStateTransitionError,
  CheckoutExpiredError,
} from '../../../errors/app-error.js';

interface InMemoryCartRecord {
  id: string;
  tenantId: string;
  status: string;
  items: CartItemDto[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * InMemoryCartStore - Zero-DB in-memory shopping cart implementation.
 * Used for isolated testing, offline resilience, and HTTP client fallback.
 */
export class InMemoryCartStore implements ICartService {
  private readonly carts = new Map<string, InMemoryCartRecord>();

  private calculateCartDto(cart: InMemoryCartRecord): CartDto {
    const itemCount = cart.items.reduce((acc, curr) => acc + curr.quantity, 0);
    const subtotalAmount = cart.items.reduce((acc, curr) => acc + curr.lineTotalAmount, 0);
    const primaryCurrency = cart.items.length > 0 ? (cart.items[0]?.currency ?? 'INR') : 'INR';

    return {
      id: cart.id,
      tenantId: cart.tenantId,
      status: cart.status,
      items: [...cart.items],
      itemCount,
      subtotalAmount,
      currency: primaryCurrency,
      createdAt: cart.createdAt.toISOString(),
      updatedAt: cart.updatedAt.toISOString(),
    };
  }

  async getOrCreateCart(actor: AuthorizedActor): Promise<CartDto> {
    RbacPolicy.requirePermission(actor, 'cart:read-own');
    let cart = this.carts.get(actor.tenantId);
    if (!cart) {
      cart = {
        id: randomUUID(),
        tenantId: actor.tenantId,
        status: 'ACTIVE',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.carts.set(actor.tenantId, cart);
    }
    return this.calculateCartDto(cart);
  }

  async addItem(actor: AuthorizedActor, input: AddCartItemInput): Promise<CartDto> {
    RbacPolicy.requirePermission(actor, 'cart:write-own');
    const listingId = input.listingId?.trim();
    if (!listingId) throw new ValidationError('listingId is required');

    if (
      typeof input.quantity !== 'number' ||
      !Number.isInteger(input.quantity) ||
      input.quantity <= 0
    ) {
      throw new ValidationError('quantity must be a positive integer');
    }

    let cart = this.carts.get(actor.tenantId);
    if (!cart) {
      cart = {
        id: randomUUID(),
        tenantId: actor.tenantId,
        status: 'ACTIVE',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.carts.set(actor.tenantId, cart);
    }

    const existingIndex = cart.items.findIndex((item) => item.listingId === listingId);
    const now = new Date();

    if (existingIndex >= 0) {
      const existing = cart.items[existingIndex]!;
      const newQty = existing.quantity + input.quantity;
      cart.items[existingIndex] = {
        ...existing,
        quantity: newQty,
        lineTotalAmount: newQty * existing.unitPriceAmount,
        updatedAt: now.toISOString(),
      };
    } else {
      const newItem: CartItemDto = {
        id: randomUUID(),
        listingId,
        skuId: `sku-${listingId}`,
        merchantTenantId: 'merchant-default',
        productId: `prod-${listingId}`,
        productTitle: `Product for ${listingId}`,
        productBrand: 'Brand',
        productThumbnailUrl: null,
        quantity: input.quantity,
        unitPriceAmount: 1000,
        lineTotalAmount: input.quantity * 1000,
        currency: 'INR',
        listingStatus: 'ACTIVE',
        isAvailable: true,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      cart.items.push(newItem);
    }

    cart.updatedAt = now;
    return this.calculateCartDto(cart);
  }

  async updateItemQuantity(
    actor: AuthorizedActor,
    itemId: string,
    input: UpdateCartItemQuantityInput,
  ): Promise<CartDto> {
    RbacPolicy.requirePermission(actor, 'cart:write-own');
    if (
      typeof input.quantity !== 'number' ||
      !Number.isInteger(input.quantity) ||
      input.quantity < 0
    ) {
      throw new ValidationError('quantity must be a non-negative integer');
    }

    const cart = this.carts.get(actor.tenantId);
    if (!cart) {
      throw new NotFoundError(`Cart item '${itemId}' not found in cart`);
    }

    const index = cart.items.findIndex((item) => item.id === itemId);
    if (index === -1) {
      throw new NotFoundError(`Cart item '${itemId}' not found in cart`);
    }

    const now = new Date();
    if (input.quantity === 0) {
      cart.items.splice(index, 1);
    } else {
      const existing = cart.items[index]!;
      cart.items[index] = {
        ...existing,
        quantity: input.quantity,
        lineTotalAmount: input.quantity * existing.unitPriceAmount,
        updatedAt: now.toISOString(),
      };
    }

    cart.updatedAt = now;
    return this.calculateCartDto(cart);
  }

  async removeItem(actor: AuthorizedActor, itemId: string): Promise<CartDto> {
    RbacPolicy.requirePermission(actor, 'cart:write-own');
    const cart = this.carts.get(actor.tenantId);
    if (!cart) {
      throw new NotFoundError(`Cart item '${itemId}' not found in cart`);
    }

    const index = cart.items.findIndex((item) => item.id === itemId);
    if (index === -1) {
      throw new NotFoundError(`Cart item '${itemId}' not found in cart`);
    }

    cart.items.splice(index, 1);
    cart.updatedAt = new Date();
    return this.calculateCartDto(cart);
  }

  async clearCart(actor: AuthorizedActor): Promise<CartDto> {
    RbacPolicy.requirePermission(actor, 'cart:write-own');
    let cart = this.carts.get(actor.tenantId);
    if (!cart) {
      cart = {
        id: randomUUID(),
        tenantId: actor.tenantId,
        status: 'ACTIVE',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.carts.set(actor.tenantId, cart);
    } else {
      cart.items = [];
      cart.updatedAt = new Date();
    }
    return this.calculateCartDto(cart);
  }

  // Test helpers
  seedCart(tenantId: string, items: CartItemDto[]): void {
    this.carts.set(tenantId, {
      id: randomUUID(),
      tenantId,
      status: 'ACTIVE',
      items: [...items],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  clear(): void {
    this.carts.clear();
  }
}

/**
 * InMemoryCheckoutStore - Zero-DB in-memory checkout session implementation.
 * Used for isolated testing, offline resilience, and HTTP client fallback.
 */
export class InMemoryCheckoutStore implements ICheckoutService {
  private readonly sessions = new Map<string, CheckoutSessionDto>();
  private readonly idempotencyKeys = new Map<string, string>(); // tenantId:key -> sessionId

  constructor(private readonly cartStore?: InMemoryCartStore | undefined) {}

  async createCheckoutSession(
    actor: AuthorizedActor,
    input?: CreateCheckoutSessionInput,
  ): Promise<CheckoutSessionDto> {
    RbacPolicy.requirePermission(actor, 'checkout:create-own');

    if (input?.idempotencyKey) {
      const cacheKey = `${actor.tenantId}:${input.idempotencyKey}`;
      const existingId = this.idempotencyKeys.get(cacheKey);
      if (existingId) {
        const existing = this.sessions.get(existingId);
        if (existing) return existing;
      }
    }

    // Resolve items from cartStore if available
    let cartItems: CartItemDto[] = [];
    if (this.cartStore) {
      const cart = await this.cartStore.getOrCreateCart(actor);
      cartItems = cart.items;
    }

    if (cartItems.length === 0) {
      throw new EmptyCartError('Cannot checkout an empty cart');
    }

    const sessionId = randomUUID();
    const now = new Date();
    const expiresInMinutes = input?.expiresInMinutes ?? 15;
    const expiresAt = new Date(now.getTime() + expiresInMinutes * 60000);

    const items: CheckoutItemDto[] = cartItems.map((ci) => ({
      id: randomUUID(),
      checkoutSessionId: sessionId,
      listingId: ci.listingId,
      skuId: ci.skuId,
      merchantTenantId: ci.merchantTenantId,
      productId: ci.productId ?? null,
      productTitle: ci.productTitle ?? null,
      productBrand: ci.productBrand ?? null,
      productThumbnailUrl: ci.productThumbnailUrl ?? null,
      quantity: ci.quantity,
      unitPriceAmount: ci.unitPriceAmount,
      lineTotalAmount: ci.lineTotalAmount,
      currency: ci.currency,
      inventoryReservationId: null,
      createdAt: now.toISOString(),
    }));

    const subtotal = items.reduce((acc, it) => acc + it.lineTotalAmount, 0);

    let addressSnapshot: AddressSnapshot | null = null;
    if (input?.shippingAddress) {
      const raw = input.shippingAddress as Record<string, unknown>;
      addressSnapshot = {
        sourceType: 'MANUAL_ENTRY',
        label: 'Other',
        recipientName: String(raw.recipientName ?? 'Customer'),
        phone: String(raw.phone ?? '9999999999'),
        addressLine1: String(raw.addressLine1 ?? '123 Main St'),
        addressLine2: raw.addressLine2 ? String(raw.addressLine2) : null,
        landmark: raw.landmark ? String(raw.landmark) : null,
        city: String(raw.city ?? 'City'),
        state: String(raw.state ?? 'State'),
        postalCode: String(raw.postalCode ?? '123456'),
        country: String(raw.country ?? 'US'),
        latitude: typeof raw.latitude === 'number' ? raw.latitude : null,
        longitude: typeof raw.longitude === 'number' ? raw.longitude : null,
        googlePlaceId: raw.googlePlaceId ? String(raw.googlePlaceId) : null,
        formattedAddress: raw.formattedAddress ? String(raw.formattedAddress) : null,
      };
    }

    const sessionDto: CheckoutSessionDto = {
      id: sessionId,
      cartId: randomUUID(),
      customerTenantId: actor.tenantId,
      status: 'OPEN',
      currency: items[0]?.currency ?? 'INR',
      subtotalAmount: subtotal,
      discountAmount: 0,
      shippingAmount: 0,
      taxAmount: 0,
      totalAmount: subtotal,
      idempotencyKey: input?.idempotencyKey ?? null,
      expiresAt: expiresAt.toISOString(),
      reservedAt: null,
      cancelledAt: null,
      failedAt: null,
      failureReason: null,
      couponCode: null,
      appliedPromotions: [],
      shippingAddress: addressSnapshot,
      items,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    this.sessions.set(sessionId, sessionDto);
    if (input?.idempotencyKey) {
      this.idempotencyKeys.set(`${actor.tenantId}:${input.idempotencyKey}`, sessionId);
    }

    return sessionDto;
  }

  async getCheckoutSession(actor: AuthorizedActor, sessionId: string): Promise<CheckoutSessionDto> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundError(`Checkout session '${sessionId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'checkout:read-own');
      RbacPolicy.requireTenantMatch(actor, session.customerTenantId);
    }

    return session;
  }

  async setShippingAddress(
    actor: AuthorizedActor,
    sessionId: string,
    input: {
      addressId?: string | null | undefined;
      shippingAddress?: AddressSnapshot | Record<string, unknown> | null | undefined;
    },
  ): Promise<CheckoutSessionDto> {
    RbacPolicy.requirePermission(actor, 'checkout:create-own');
    const session = await this.getCheckoutSession(actor, sessionId);

    if (
      session.status === 'CANCELLED' ||
      session.status === 'EXPIRED' ||
      session.status === 'FAILED'
    ) {
      throw new InvalidStateTransitionError(
        `Cannot update address on session with status '${session.status}'`,
      );
    }

    let snapshot: AddressSnapshot | null = null;
    if (input.shippingAddress) {
      const raw = input.shippingAddress as Record<string, unknown>;
      snapshot = {
        sourceType: 'MANUAL_ENTRY',
        label: 'Other',
        recipientName: String(raw.recipientName ?? 'Customer'),
        phone: String(raw.phone ?? '9999999999'),
        addressLine1: String(raw.addressLine1 ?? '123 Main St'),
        addressLine2: raw.addressLine2 ? String(raw.addressLine2) : null,
        landmark: raw.landmark ? String(raw.landmark) : null,
        city: String(raw.city ?? 'City'),
        state: String(raw.state ?? 'State'),
        postalCode: String(raw.postalCode ?? '123456'),
        country: String(raw.country ?? 'US'),
        latitude: typeof raw.latitude === 'number' ? raw.latitude : null,
        longitude: typeof raw.longitude === 'number' ? raw.longitude : null,
        googlePlaceId: raw.googlePlaceId ? String(raw.googlePlaceId) : null,
        formattedAddress: raw.formattedAddress ? String(raw.formattedAddress) : null,
      };
    }

    const updated: CheckoutSessionDto = {
      ...session,
      shippingAddress: snapshot,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  async reserveCheckoutInventory(
    actor: AuthorizedActor,
    sessionId: string,
  ): Promise<CheckoutSessionDto> {
    RbacPolicy.requirePermission(actor, 'checkout:create-own');
    const session = await this.getCheckoutSession(actor, sessionId);

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      await this.expireCheckoutSession(actor, sessionId);
      throw new CheckoutExpiredError('Checkout session has expired');
    }

    if (session.status === 'READY' || session.status === 'RESERVED') {
      return session;
    }

    if (
      session.status === 'CANCELLED' ||
      session.status === 'EXPIRED' ||
      session.status === 'FAILED'
    ) {
      throw new InvalidStateTransitionError(
        `Cannot reserve inventory for checkout session in status '${session.status}'`,
      );
    }

    const updatedItems = session.items.map((it) => ({
      ...it,
      inventoryReservationId: it.inventoryReservationId ?? randomUUID(),
    }));

    const updated: CheckoutSessionDto = {
      ...session,
      status: 'READY',
      reservedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: updatedItems,
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  async expireCheckoutSession(
    actor: AuthorizedActor,
    sessionId: string,
  ): Promise<CheckoutSessionDto> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundError(`Checkout session '${sessionId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'checkout:create-own');
      RbacPolicy.requireTenantMatch(actor, session.customerTenantId);
    }

    if (session.status === 'EXPIRED') {
      return session;
    }

    if (session.status === 'CANCELLED') {
      throw new InvalidStateTransitionError('Cannot expire a cancelled checkout session');
    }

    const updated: CheckoutSessionDto = {
      ...session,
      status: 'EXPIRED',
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  async cancelCheckoutSession(
    actor: AuthorizedActor,
    sessionId: string,
  ): Promise<CheckoutSessionDto> {
    RbacPolicy.requirePermission(actor, 'checkout:create-own');
    const session = await this.getCheckoutSession(actor, sessionId);

    if (session.status === 'CANCELLED') {
      return session;
    }

    if (session.status === 'EXPIRED') {
      throw new InvalidStateTransitionError('Cannot cancel an expired checkout session');
    }

    const updated: CheckoutSessionDto = {
      ...session,
      status: 'CANCELLED',
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  // Test helpers
  seedSession(session: CheckoutSessionDto): void {
    this.sessions.set(session.id, session);
    if (session.idempotencyKey) {
      this.idempotencyKeys.set(`${session.customerTenantId}:${session.idempotencyKey}`, session.id);
    }
  }

  clear(): void {
    this.sessions.clear();
    this.idempotencyKeys.clear();
  }
}
