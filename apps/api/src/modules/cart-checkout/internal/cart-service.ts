import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { RbacPolicy } from '../../identity/index.js';
import type { ListingService } from '../../marketplace/index.js';
import { CartRepository } from './cart-repository.js';
import {
  ValidationError,
  NotFoundError,
} from '../../../errors/app-error.js';

export interface CartItemDto {
  id: string;
  listingId: string;
  skuId: string;
  merchantTenantId: string;
  quantity: number;
  unitPriceAmount: number;
  lineTotalAmount: number;
  currency: string;
  listingStatus: string;
  isAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CartDto {
  id: string;
  tenantId: string;
  status: string;
  items: CartItemDto[];
  itemCount: number;
  subtotalAmount: number;
  currency: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AddCartItemInput {
  listingId: string;
  quantity: number;
}

export interface UpdateCartItemQuantityInput {
  quantity: number;
}

export class CartService {
  private readonly repo: CartRepository;

  constructor(
    db: DatabaseConnection,
    _logger: Logger,
    private readonly listingService: ListingService,
  ) {
    this.repo = new CartRepository(db);
  }

  async getOrCreateCart(actor: AuthorizedActor): Promise<CartDto> {
    RbacPolicy.requirePermission(actor, 'cart:read-own');
    const cart = await this.repo.findOrCreateCart(actor.tenantId);
    return this.buildCartDto(cart.id, cart.tenant_id, cart.status, cart.created_at, cart.updated_at, actor);
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

    // Authoritative verification against marketplace listing
    const listing = await this.listingService.getListingById(actor, listingId);
    if (listing.status !== 'ACTIVE') {
      throw new ValidationError(`Listing '${listingId}' is not active and cannot be added to cart`);
    }

    const cart = await this.repo.findOrCreateCart(actor.tenantId);

    // Add or increment item without reserving inventory
    await this.repo.addOrIncrementItem(
      cart.id,
      listing.id,
      listing.skuId,
      listing.tenantId,
      input.quantity,
    );

    return this.buildCartDto(cart.id, cart.tenant_id, cart.status, cart.created_at, cart.updated_at, actor);
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

    const cart = await this.repo.findOrCreateCart(actor.tenantId);
    const existing = await this.repo.findCartItemById(cart.id, itemId);
    if (!existing) {
      throw new NotFoundError(`Cart item '${itemId}' not found in cart`);
    }

    await this.repo.updateItemQuantity(cart.id, itemId, input.quantity);

    return this.buildCartDto(cart.id, cart.tenant_id, cart.status, cart.created_at, cart.updated_at, actor);
  }

  async removeItem(actor: AuthorizedActor, itemId: string): Promise<CartDto> {
    RbacPolicy.requirePermission(actor, 'cart:write-own');

    const cart = await this.repo.findOrCreateCart(actor.tenantId);
    const existing = await this.repo.findCartItemById(cart.id, itemId);
    if (!existing) {
      throw new NotFoundError(`Cart item '${itemId}' not found in cart`);
    }

    await this.repo.removeItem(cart.id, itemId);

    return this.buildCartDto(cart.id, cart.tenant_id, cart.status, cart.created_at, cart.updated_at, actor);
  }

  async clearCart(actor: AuthorizedActor): Promise<CartDto> {
    RbacPolicy.requirePermission(actor, 'cart:write-own');

    const cart = await this.repo.findOrCreateCart(actor.tenantId);
    await this.repo.clearCart(cart.id);

    return this.buildCartDto(cart.id, cart.tenant_id, cart.status, cart.created_at, cart.updated_at, actor);
  }

  private async buildCartDto(
    cartId: string,
    tenantId: string,
    status: string,
    createdAt: Date,
    updatedAt: Date,
    actor: AuthorizedActor,
  ): Promise<CartDto> {
    const rawItems = await this.repo.getCartItems(cartId);
    const itemDtos: CartItemDto[] = [];
    let subtotal = 0;
    let primaryCurrency: string | null = null;

    for (const item of rawItems) {
      let unitPrice = 0;
      let currency = 'INR';
      let listingStatus = 'UNKNOWN';
      let isAvailable = false;

      try {
        const listing = await this.listingService.getListingById(actor, item.listing_id);
        unitPrice = listing.priceAmount;
        currency = listing.currency;
        listingStatus = listing.status;
        isAvailable = listing.status === 'ACTIVE';
      } catch {
        listingStatus = 'UNAVAILABLE';
        isAvailable = false;
      }

      if (!primaryCurrency && currency) {
        primaryCurrency = currency;
      }

      const lineTotal = item.quantity * unitPrice;
      subtotal += lineTotal;

      itemDtos.push({
        id: item.id,
        listingId: item.listing_id,
        skuId: item.sku_id,
        merchantTenantId: item.merchant_tenant_id,
        quantity: item.quantity,
        unitPriceAmount: unitPrice,
        lineTotalAmount: lineTotal,
        currency,
        listingStatus,
        isAvailable,
        createdAt: item.created_at.toISOString(),
        updatedAt: item.updated_at.toISOString(),
      });
    }

    const totalCount = rawItems.reduce((acc, curr) => acc + curr.quantity, 0);

    return {
      id: cartId,
      tenantId,
      status,
      items: itemDtos,
      itemCount: totalCount,
      subtotalAmount: subtotal,
      currency: primaryCurrency ?? 'INR',
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    };
  }
}
