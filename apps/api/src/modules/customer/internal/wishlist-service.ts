import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import { ValidationError, NotFoundError } from '../../../errors/app-error.js';
import { RbacPolicy, type AuthorizedActor } from '../../identity/rbac/policy.js';
import type { CartService, ICartService, CartDto } from '../../cart-checkout/index.js';
import type { OutboxService } from '../../events/index.js';
import { EventTypes, createDomainEvent } from '../../events/index.js';
import { WishlistRepository } from './wishlist-repository.js';
import type {
  WishlistItemDto,
  AddWishlistItemInput,
  SaveForLaterInput,
  MoveToCartInput,
  WishlistCheckResultDto,
} from './wishlist-models.js';

export class WishlistService {
  private readonly repo: WishlistRepository;

  constructor(
    private readonly db: DatabaseConnection,
    private readonly logger: Logger,
    private readonly cartService: ICartService | CartService,
    private readonly outboxService?: OutboxService | undefined,
  ) {
    this.repo = new WishlistRepository(db);
  }

  async listWishlist(actor: AuthorizedActor): Promise<WishlistItemDto[]> {
    RbacPolicy.requirePermission(actor, 'wishlist:read-own');

    const items = await this.repo.listItemsByCustomer(actor.userId, actor.tenantId);
    const dtos: WishlistItemDto[] = [];

    for (const item of items) {
      const dto = await this.repo.resolveWishlistItemDetails(item);
      dtos.push(dto);
    }

    return dtos;
  }

  async addToWishlist(
    actor: AuthorizedActor,
    input: AddWishlistItemInput,
  ): Promise<WishlistItemDto> {
    RbacPolicy.requirePermission(actor, 'wishlist:write-own');

    const productId = input.productId?.trim();
    if (!productId) {
      throw new ValidationError('productId is required');
    }

    // 1. Authoritative validation: canonical product must exist
    const prodRes = await this.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM products WHERE id = $1`,
      [productId],
    );
    if (prodRes.rows.length === 0) {
      throw new NotFoundError(`Product '${productId}' not found`);
    }

    // 2. Validate SKU if provided
    let skuId: string | null = null;
    if (input.skuId) {
      const trimmedSkuId = input.skuId.trim();
      const skuRes = await this.db.query<{ id: string; product_id: string }>(
        `SELECT id, product_id FROM product_skus WHERE id = $1`,
        [trimmedSkuId],
      );
      if (skuRes.rows.length === 0 || skuRes.rows[0]?.product_id !== productId) {
        throw new ValidationError(
          `SKU '${trimmedSkuId}' does not belong to product '${productId}'`,
        );
      }
      skuId = trimmedSkuId;
    }

    // 3. Atomically add or idempotently update wishlist entry
    const saved = await this.repo.addItem(actor.userId, actor.tenantId, productId, skuId);

    const dto = await this.repo.resolveWishlistItemDetails(saved);

    // 4. Record transactional outbox signal
    if (this.outboxService) {
      try {
        const domainEvent = createDomainEvent({
          eventType: EventTypes.WISHLIST_ITEM_ADDED,
          aggregateType: 'WISHLIST',
          aggregateId: saved.id,
          tenantId: actor.tenantId,
          payload: {
            wishlistItemId: saved.id,
            customerId: actor.userId,
            productId: saved.product_id,
            skuId: saved.sku_id,
          },
          metadata: {
            actorId: actor.userId,
            source: 'customer-wishlist',
          },
        });
        await this.outboxService.recordEvent(this.db, domainEvent);
      } catch (err) {
        this.logger.error('Failed to publish WISHLIST_ITEM_ADDED event', {
          error: (err as Error).message,
          customerId: actor.userId,
          productId,
        });
      }
    }

    return dto;
  }

  async removeFromWishlist(actor: AuthorizedActor, productIdOrId: string): Promise<void> {
    RbacPolicy.requirePermission(actor, 'wishlist:write-own');

    const identifier = productIdOrId?.trim();
    if (!identifier) {
      throw new ValidationError('productId or wishlistItemId is required');
    }

    // Attempt removal by product_id first, then by primary id
    let removed = await this.repo.removeItemByProduct(actor.userId, identifier);
    if (!removed) {
      removed = await this.repo.removeItemById(actor.userId, identifier);
    }

    if (removed && this.outboxService) {
      try {
        const domainEvent = createDomainEvent({
          eventType: EventTypes.WISHLIST_ITEM_REMOVED,
          aggregateType: 'WISHLIST',
          aggregateId: removed.id,
          tenantId: actor.tenantId,
          payload: {
            wishlistItemId: removed.id,
            customerId: actor.userId,
            productId: removed.product_id,
          },
          metadata: {
            actorId: actor.userId,
            source: 'customer-wishlist',
          },
        });
        await this.outboxService.recordEvent(this.db, domainEvent);
      } catch (err) {
        this.logger.error('Failed to publish WISHLIST_ITEM_REMOVED event', {
          error: (err as Error).message,
          customerId: actor.userId,
          productId: removed.product_id,
        });
      }
    }
  }

  async checkWishlistStatus(
    actor: AuthorizedActor,
    productId: string,
  ): Promise<WishlistCheckResultDto> {
    RbacPolicy.requirePermission(actor, 'wishlist:read-own');

    const cleanProductId = productId?.trim();
    if (!cleanProductId) {
      throw new ValidationError('productId is required');
    }

    const item = await this.repo.findItemByCustomerAndProduct(actor.userId, cleanProductId);
    return {
      isWishlisted: !!item,
      wishlistItemId: item?.id ?? null,
    };
  }

  async saveForLater(
    actor: AuthorizedActor,
    input: SaveForLaterInput,
  ): Promise<{ wishlistItem: WishlistItemDto; cart: CartDto }> {
    RbacPolicy.requirePermission(actor, 'wishlist:write-own');
    RbacPolicy.requirePermission(actor, 'cart:write-own');

    const cartItemId = input.cartItemId?.trim();
    if (!cartItemId) {
      throw new ValidationError('cartItemId is required');
    }

    const cart = await this.cartService.getOrCreateCart(actor);
    const cartItem = cart.items.find((it) => it.id === cartItemId);
    if (!cartItem) {
      throw new NotFoundError(`Cart item '${cartItemId}' not found in cart`);
    }

    // Resolve product ID for the cart item
    let productId = cartItem.productId;
    if (!productId) {
      const prodRes = await this.db.query<{ product_id: string }>(
        `SELECT product_id FROM product_skus WHERE id = $1`,
        [cartItem.skuId],
      );
      if (prodRes.rows[0]) {
        productId = prodRes.rows[0].product_id;
      }
    }

    if (!productId) {
      throw new NotFoundError(
        `Canonical product for cart item '${cartItemId}' could not be resolved`,
      );
    }

    // Add to wishlist
    const wishlistItemRow = await this.repo.addItem(
      actor.userId,
      actor.tenantId,
      productId,
      cartItem.skuId,
    );

    // Remove from active shopping cart
    const updatedCart = await this.cartService.removeItem(actor, cartItemId);

    const wishlistItemDto = await this.repo.resolveWishlistItemDetails(wishlistItemRow);

    // Transactional outbox event
    if (this.outboxService) {
      try {
        const domainEvent = createDomainEvent({
          eventType: EventTypes.WISHLIST_ITEM_ADDED,
          aggregateType: 'WISHLIST',
          aggregateId: wishlistItemRow.id,
          tenantId: actor.tenantId,
          payload: {
            wishlistItemId: wishlistItemRow.id,
            customerId: actor.userId,
            productId,
            skuId: cartItem.skuId,
          },
          metadata: {
            actorId: actor.userId,
            source: 'save-for-later',
          },
        });
        await this.outboxService.recordEvent(this.db, domainEvent);
      } catch (err) {
        this.logger.error('Failed to publish save-for-later outbox event', {
          error: (err as Error).message,
        });
      }
    }

    return {
      wishlistItem: wishlistItemDto,
      cart: updatedCart,
    };
  }

  async moveToCart(
    actor: AuthorizedActor,
    productIdOrId: string,
    input?: MoveToCartInput,
  ): Promise<{ cart: CartDto; message: string }> {
    RbacPolicy.requirePermission(actor, 'wishlist:write-own');
    RbacPolicy.requirePermission(actor, 'cart:write-own');

    const identifier = productIdOrId?.trim();
    if (!identifier) {
      throw new ValidationError('productId or wishlistItemId is required');
    }

    let item = await this.repo.findItemByCustomerAndProduct(actor.userId, identifier);
    if (!item) {
      item = await this.repo.findItemById(actor.userId, identifier);
    }
    if (!item) {
      throw new NotFoundError(`Wishlist item for '${identifier}' not found`);
    }

    // Resolve an active listing to add to cart
    let targetListingId: string | null = null;

    if (input?.listingId) {
      const explicitListing = await this.db.query<{ id: string; status: string }>(
        `SELECT ml.id, ml.status
         FROM merchant_listings ml
         JOIN product_skus ps ON ps.id = ml.sku_id
         WHERE ml.id = $1 AND ps.product_id = $2 AND ml.status = 'ACTIVE'`,
        [input.listingId.trim(), item.product_id],
      );
      if (explicitListing.rows[0]) {
        targetListingId = explicitListing.rows[0].id;
      } else {
        throw new ValidationError(
          `Provided listing '${input.listingId}' is not an active offer for this product`,
        );
      }
    } else {
      // Find the best in-stock active listing for this product/sku
      let query = `
        SELECT ml.id
        FROM merchant_listings ml
        JOIN product_skus ps ON ps.id = ml.sku_id
        LEFT JOIN inventory_items ii ON ii.listing_id = ml.id
        WHERE ps.product_id = $1
          AND ml.status = 'ACTIVE'
          AND COALESCE(ii.on_hand_quantity - ii.reserved_quantity - ii.non_sellable_quantity, 0) > 0
      `;
      const params: unknown[] = [item.product_id];

      if (item.sku_id) {
        query += ` AND ml.sku_id = $2`;
        params.push(item.sku_id);
      }

      query += ` ORDER BY ml.price_amount ASC LIMIT 1`;

      const inStockListing = await this.db.query<{ id: string }>(query, params);
      if (inStockListing.rows[0]) {
        targetListingId = inStockListing.rows[0].id;
      } else {
        // Fallback: any active listing
        let anyListingQuery = `
          SELECT ml.id
          FROM merchant_listings ml
          JOIN product_skus ps ON ps.id = ml.sku_id
          WHERE ps.product_id = $1 AND ml.status = 'ACTIVE'
        `;
        const anyParams: unknown[] = [item.product_id];
        if (item.sku_id) {
          anyListingQuery += ` AND ml.sku_id = $2`;
          anyParams.push(item.sku_id);
        }
        anyListingQuery += ` ORDER BY ml.price_amount ASC LIMIT 1`;

        const fallback = await this.db.query<{ id: string }>(anyListingQuery, anyParams);
        if (fallback.rows[0]) {
          targetListingId = fallback.rows[0].id;
        }
      }
    }

    if (!targetListingId) {
      throw new ValidationError(
        'Cannot move item to cart: No active seller listings are currently available for this product.',
      );
    }

    // Authoritative Cart Service executes full pricing and listing verification
    const updatedCart = await this.cartService.addItem(actor, {
      listingId: targetListingId,
      quantity: 1,
    });

    // Remove item from wishlist
    await this.repo.removeItemByProduct(actor.userId, item.product_id);

    // Record outbox event
    if (this.outboxService) {
      try {
        const domainEvent = createDomainEvent({
          eventType: EventTypes.WISHLIST_ITEM_REMOVED,
          aggregateType: 'WISHLIST',
          aggregateId: item.id,
          tenantId: actor.tenantId,
          payload: {
            wishlistItemId: item.id,
            customerId: actor.userId,
            productId: item.product_id,
          },
          metadata: {
            actorId: actor.userId,
            source: 'move-to-cart',
          },
        });
        await this.outboxService.recordEvent(this.db, domainEvent);
      } catch (err) {
        this.logger.error('Failed to publish move-to-cart outbox event', {
          error: (err as Error).message,
        });
      }
    }

    return {
      cart: updatedCart,
      message: 'Item moved to cart successfully',
    };
  }
}
