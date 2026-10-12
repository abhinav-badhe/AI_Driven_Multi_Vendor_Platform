import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { RbacPolicy } from '../../identity/index.js';
import type { ListingService, IMarketplaceReader } from '../../marketplace/index.js';
import type { CatalogService, ICatalogReader } from '../../catalog/index.js';
import type { InventoryService, IInventoryService } from '../../inventory/index.js';
import { CartRepository } from './cart-repository.js';
import {
  CheckoutRepository,
  type CheckoutStatus,
  type CheckoutItemRow,
  type CheckoutSessionRow,
} from './checkout-repository.js';
import {
  NotFoundError,
  EmptyCartError,
  CheckoutValidationError,
  CheckoutExpiredError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';
import { randomUUID } from 'node:crypto';

import type {
  CustomerAddressService,
  AddressSnapshot,
  ICustomerAddressReader,
} from '../../customer/index.js';

export interface CheckoutItemDto {
  id: string;
  checkoutSessionId: string;
  listingId: string;
  skuId: string;
  merchantTenantId: string;
  productId?: string | null;
  productTitle?: string | null;
  productBrand?: string | null;
  productThumbnailUrl?: string | null;
  quantity: number;
  unitPriceAmount: number;
  lineTotalAmount: number;
  currency: string;
  inventoryReservationId?: string | null;
  createdAt: string;
}

export interface CheckoutSessionDto {
  id: string;
  cartId: string;
  customerTenantId: string;
  status: CheckoutStatus;
  currency: string;
  subtotalAmount: number;
  discountAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  idempotencyKey?: string | null;
  expiresAt: string;
  reservedAt?: string | null;
  cancelledAt?: string | null;
  failedAt?: string | null;
  failureReason?: string | null;
  couponCode?: string | null;
  appliedPromotions?: unknown[];
  shippingAddress?: AddressSnapshot | null;
  items: CheckoutItemDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateCheckoutSessionInput {
  idempotencyKey?: string | null | undefined;
  expiresInMinutes?: number | undefined;
  addressId?: string | null | undefined;
  shippingAddress?: AddressSnapshot | Record<string, unknown> | null | undefined;
}

import type { ICheckoutService } from './cart-checkout-models.js';

export class CheckoutService implements ICheckoutService {
  private readonly cartRepo: CartRepository;
  private readonly checkoutRepo: CheckoutRepository;

  constructor(
    db: DatabaseConnection,
    private readonly logger: Logger,
    private readonly listingService: IMarketplaceReader | ListingService,
    private readonly catalogService: ICatalogReader | CatalogService,
    private readonly inventoryService: IInventoryService | InventoryService,
    private readonly addressService?: ICustomerAddressReader | CustomerAddressService | undefined,
  ) {
    this.cartRepo = new CartRepository(db);
    this.checkoutRepo = new CheckoutRepository(db);
  }

  async createCheckoutSession(
    actor: AuthorizedActor,
    input?: CreateCheckoutSessionInput | undefined,
  ): Promise<CheckoutSessionDto> {
    RbacPolicy.requirePermission(actor, 'checkout:create-own');

    // 1. Idempotency Check with cart fingerprint verification
    if (input?.idempotencyKey) {
      const existing = await this.checkoutRepo.findSessionByIdempotency(
        actor.tenantId,
        input.idempotencyKey,
      );
      if (existing) {
        const existingItems = await this.checkoutRepo.getCheckoutItems(existing.id);
        const currentCart = await this.cartRepo.findCartByTenantId(actor.tenantId);
        const currentCartItems = currentCart
          ? await this.cartRepo.getCartItems(currentCart.id)
          : [];

        // Verify that the request has not materially changed
        const matches =
          existingItems.length === currentCartItems.length &&
          existingItems.every((eItem) => {
            const cItem = currentCartItems.find((c) => c.listing_id === eItem.listing_id);
            return cItem && cItem.quantity === eItem.quantity;
          });

        if (!matches) {
          throw new CheckoutValidationError(
            'Idempotency key reuse detected with different cart contents',
          );
        }

        return this.toSessionDto(existing, existingItems);
      }
    }

    // 2. Fetch Customer Cart
    const cart = await this.cartRepo.findCartByTenantId(actor.tenantId);
    if (!cart) {
      throw new EmptyCartError('Cannot checkout without an active cart');
    }

    const cartItems = await this.cartRepo.getCartItems(cart.id);
    if (cartItems.length === 0) {
      throw new EmptyCartError('Cannot checkout an empty cart');
    }

    // 3. Re-validate all cart items against authoritative sources
    let subtotalAmount = 0;
    let primaryCurrency: string | null = null;
    const validatedItemsData: Array<{
      listingId: string;
      skuId: string;
      merchantTenantId: string;
      quantity: number;
      unitPriceAmount: number;
      lineTotalAmount: number;
      currency: string;
    }> = [];

    for (const item of cartItems) {
      // 3.1. Listing verification
      let listing;
      try {
        listing = await this.listingService.getListingById(actor, item.listing_id);
      } catch {
        throw new CheckoutValidationError(
          `Listing '${item.listing_id}' is not active or no longer exists in marketplace`,
        );
      }

      if (listing.status !== 'ACTIVE') {
        throw new CheckoutValidationError(
          `Listing '${item.listing_id}' is not active (current status: ${listing.status})`,
        );
      }

      // 3.2. Canonical SKU verification
      const sku = await this.catalogService.getSkuById(listing.skuId);
      if (sku.status !== 'ACTIVE') {
        throw new CheckoutValidationError(
          `Canonical SKU '${listing.skuId}' for listing '${listing.id}' is not active`,
        );
      }

      // 3.3. Currency uniformity
      if (!primaryCurrency) {
        primaryCurrency = listing.currency;
      } else if (primaryCurrency !== listing.currency) {
        throw new CheckoutValidationError(
          `Inconsistent currencies in cart: expected ${primaryCurrency}, found ${listing.currency} for listing ${listing.id}`,
        );
      }

      // 3.4. Inventory availability check
      const availability = await this.inventoryService.getAvailabilityByListingId(item.listing_id);
      if (availability.availableQuantity < item.quantity) {
        throw new CheckoutValidationError(
          `Insufficient inventory for listing '${item.listing_id}': requested ${item.quantity}, available ${availability.availableQuantity}`,
        );
      }

      // 3.5. Authoritative price calculation (integer minor units)
      const unitPriceAmount = listing.priceAmount;
      const lineTotalAmount = item.quantity * unitPriceAmount;
      subtotalAmount += lineTotalAmount;

      validatedItemsData.push({
        listingId: listing.id,
        skuId: listing.skuId,
        merchantTenantId: listing.tenantId,
        quantity: item.quantity,
        unitPriceAmount,
        lineTotalAmount,
        currency: listing.currency,
      });
    }

    const sessionId = randomUUID();
    const expiresInMin = input?.expiresInMinutes ?? 15;
    const expiresAt = new Date(Date.now() + expiresInMin * 60 * 1000);

    // Controlled pricing calculation: no discounts, shipping, or tax in Phase 5
    const discountAmount = 0;
    const shippingAmount = 0;
    const taxAmount = 0;
    const totalAmount = subtotalAmount + shippingAmount + taxAmount - discountAmount;

    // Resolve shipping address securely
    const resolvedShippingAddress = await this.resolveShippingAddress(actor, input);

    // 4. Persist Checkout Session in OPEN status (with constraint conflict recovery)
    let sessionRow: CheckoutSessionRow;
    try {
      sessionRow = await this.checkoutRepo.createSession({
        id: sessionId,
        cartId: cart.id,
        customerTenantId: actor.tenantId,
        status: 'OPEN',
        currency: primaryCurrency!,
        subtotalAmount,
        discountAmount,
        shippingAmount,
        taxAmount,
        totalAmount,
        idempotencyKey: input?.idempotencyKey ?? null,
        expiresAt,
        shippingAddress: resolvedShippingAddress ? JSON.stringify(resolvedShippingAddress) : null,
      });
    } catch (err: unknown) {
      if (
        input?.idempotencyKey &&
        err instanceof Error &&
        (err.message.includes('uq_checkout_idempotency') ||
          (err as { code?: string }).code === '23505')
      ) {
        const existing = await this.checkoutRepo.findSessionByIdempotency(
          actor.tenantId,
          input.idempotencyKey,
        );
        if (existing) {
          const items = await this.checkoutRepo.getCheckoutItems(existing.id);
          return this.toSessionDto(existing, items);
        }
      }
      throw err;
    }

    // 5. Persist Immutable Line Item Snapshots
    const itemsToCreate = validatedItemsData.map((d) => ({
      id: randomUUID(),
      checkoutSessionId: sessionId,
      listingId: d.listingId,
      skuId: d.skuId,
      merchantTenantId: d.merchantTenantId,
      quantity: d.quantity,
      unitPriceAmount: d.unitPriceAmount,
      lineTotalAmount: d.lineTotalAmount,
      currency: d.currency,
    }));

    const itemRows = await this.checkoutRepo.createCheckoutItems(itemsToCreate);

    return this.toSessionDto(sessionRow, itemRows);
  }

  async reserveCheckoutInventory(
    actor: AuthorizedActor,
    sessionId: string,
  ): Promise<CheckoutSessionDto> {
    RbacPolicy.requirePermission(actor, 'checkout:create-own');

    const session = await this.checkoutRepo.findSessionById(sessionId);
    if (!session) {
      throw new NotFoundError(`Checkout session '${sessionId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, session.customer_tenant_id);
    }

    // Check expiration server-side
    if (session.expires_at.getTime() <= Date.now()) {
      await this.expireCheckoutSession(actor, sessionId);
      throw new CheckoutExpiredError('Checkout session has expired');
    }

    // Idempotency: if already RESERVED or READY, return immediately
    if (session.status === 'READY' || session.status === 'RESERVED') {
      const items = await this.checkoutRepo.getCheckoutItems(sessionId);
      return this.toSessionDto(session, items);
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

    // Atomic CAS transition:
    // If OPEN -> try transition to VALIDATING.
    // If already VALIDATING -> check if an active worker is finishing, else proceed with recovery.
    let activeSession = session;
    if (session.status === 'OPEN') {
      const casResult = await this.checkoutRepo.updateSessionStatus(
        sessionId,
        'OPEN',
        'VALIDATING',
      );

      if (!casResult) {
        // Lost CAS race to another concurrent request. Fetch latest state or await completion.
        const current = await this.checkoutRepo.findSessionById(sessionId);
        if (!current) throw new NotFoundError(`Checkout session '${sessionId}' not found`);

        if (current.status === 'READY' || current.status === 'RESERVED') {
          const items = await this.checkoutRepo.getCheckoutItems(sessionId);
          return this.toSessionDto(current, items);
        }

        if (
          current.status === 'CANCELLED' ||
          current.status === 'EXPIRED' ||
          current.status === 'FAILED'
        ) {
          throw new InvalidStateTransitionError(
            `Cannot reserve inventory for checkout session in status '${current.status}'`,
          );
        }

        // Another request is actively validating. Await completion before assuming recovery
        const completed = await this.tryAwaitRecentValidation(sessionId, 15, 30);
        if (completed) {
          const items = await this.checkoutRepo.getCheckoutItems(sessionId);
          return this.toSessionDto(completed, items);
        }

        activeSession = current;
      } else {
        activeSession = casResult;
      }
    } else if (session.status === 'VALIDATING') {
      const isRecentlyActive =
        session.failure_reason?.startsWith('RECOVERY_CLAIM:') &&
        Date.now() - session.updated_at.getTime() < 350;

      if (isRecentlyActive) {
        const completed = await this.tryAwaitRecentValidation(sessionId, 15, 30);
        if (completed) {
          const items = await this.checkoutRepo.getCheckoutItems(sessionId);
          return this.toSessionDto(completed, items);
        }
      }

      // Atomic recovery claim using database synchronization
      const claimToken = randomUUID();
      const staleCutoff = new Date(Date.now() - 350);
      const claimed = await this.checkoutRepo.claimValidationRecovery(
        sessionId,
        claimToken,
        staleCutoff,
      );

      if (!claimed) {
        // Lost claim race to a concurrent recovery worker. Await its completion.
        const completed = await this.tryAwaitRecentValidation(sessionId, 20, 25);
        if (completed) {
          const items = await this.checkoutRepo.getCheckoutItems(sessionId);
          return this.toSessionDto(completed, items);
        }
        const current = await this.checkoutRepo.findSessionById(sessionId);
        if (current && (current.status === 'READY' || current.status === 'RESERVED')) {
          const items = await this.checkoutRepo.getCheckoutItems(sessionId);
          return this.toSessionDto(current, items);
        }
        throw new InvalidStateTransitionError(
          `Checkout session validation could not be completed (current status: ${current?.status})`,
        );
      }

      activeSession = claimed;
    }

    const items = await this.checkoutRepo.getCheckoutItems(sessionId);

    // Pre-Reservation & Pre-Recovery Validation: Re-verify Authoritative Pricing & Listing Status
    for (const item of items) {
      let listing;
      try {
        listing = await this.listingService.getListingById(actor, item.listing_id);
      } catch {
        const failReason = `Listing '${item.listing_id}' is no longer active in marketplace`;
        await this.rollbackExistingSessionHolds(actor, sessionId, items);
        await this.checkoutRepo.updateSessionStatus(sessionId, 'VALIDATING', 'FAILED', {
          failureReason: failReason,
          failedAt: new Date(),
        });
        throw new CheckoutValidationError(failReason);
      }

      if (listing.status !== 'ACTIVE') {
        const failReason = `Listing '${item.listing_id}' is not active (current status: ${listing.status})`;
        await this.rollbackExistingSessionHolds(actor, sessionId, items);
        await this.checkoutRepo.updateSessionStatus(sessionId, 'VALIDATING', 'FAILED', {
          failureReason: failReason,
          failedAt: new Date(),
        });
        throw new CheckoutValidationError(failReason);
      }

      if (listing.priceAmount !== item.unit_price_amount || listing.currency !== item.currency) {
        const failReason = `Listing price has changed for listing '${item.listing_id}'. Previous price: ${item.unit_price_amount}, current price: ${listing.priceAmount}`;
        await this.rollbackExistingSessionHolds(actor, sessionId, items);
        await this.checkoutRepo.updateSessionStatus(sessionId, 'VALIDATING', 'FAILED', {
          failureReason: failReason,
          failedAt: new Date(),
        });
        throw new CheckoutValidationError(
          `${failReason}. Please review cart and create a new checkout session.`,
        );
      }

      const sku = await this.catalogService.getSkuById(listing.skuId);
      if (sku.status !== 'ACTIVE') {
        const failReason = `Canonical SKU '${listing.skuId}' for listing '${listing.id}' is not active`;
        await this.rollbackExistingSessionHolds(actor, sessionId, items);
        await this.checkoutRepo.updateSessionStatus(sessionId, 'VALIDATING', 'FAILED', {
          failureReason: failReason,
          failedAt: new Date(),
        });
        throw new CheckoutValidationError(failReason);
      }
    }

    // Server-side expiration check before holding inventory
    if (activeSession.expires_at.getTime() <= Date.now()) {
      await this.expireCheckoutSession(actor, sessionId);
      throw new CheckoutExpiredError('Checkout session has expired');
    }

    const acquiredReservations: Array<{ itemId: string; reservationId: string }> = [];

    try {
      for (const item of items) {
        const resKey = `chk-${sessionId}-${item.id}`;
        let reservationId: string | null = null;

        // 1. Check if checkout line item already has a linked reservation
        if (item.inventory_reservation_id) {
          try {
            const existing = await this.inventoryService.getReservationById(
              actor,
              item.inventory_reservation_id,
            );
            if (existing && existing.status === 'ACTIVE') {
              reservationId = existing.id;
            }
          } catch {
            // Stale or unresolvable reservation reference, fallback to idempotency key lookup
          }
        }

        // 2. If not linked, check if deterministic reservation exists in Inventory
        if (!reservationId) {
          const existing = await this.inventoryService.findReservationByIdempotencyKey(
            actor,
            resKey,
          );
          if (existing && existing.status === 'ACTIVE') {
            reservationId = existing.id;
            await this.checkoutRepo.setCheckoutItemReservation(item.id, existing.id);
          }
        }

        // 3. If still not resolved, create the reservation deterministically
        if (!reservationId) {
          try {
            const reservation = await this.inventoryService.createReservation(actor, {
              listingId: item.listing_id,
              quantity: item.quantity,
              idempotencyKey: resKey,
            });
            reservationId = reservation.id;
            await this.checkoutRepo.setCheckoutItemReservation(item.id, reservation.id);
          } catch (createErr: unknown) {
            const existing = await this.inventoryService.findReservationByIdempotencyKey(
              actor,
              resKey,
            );
            if (existing && existing.status === 'ACTIVE') {
              reservationId = existing.id;
              await this.checkoutRepo.setCheckoutItemReservation(item.id, existing.id);
            } else {
              throw createErr;
            }
          }
        }

        acquiredReservations.push({
          itemId: item.id,
          reservationId,
        });
      }

      // Atomic transition: VALIDATING -> READY
      const readySession = await this.checkoutRepo.updateSessionStatus(
        sessionId,
        'VALIDATING',
        'READY',
        { failureReason: null, reservedAt: new Date() },
      );

      if (!readySession) {
        const current = await this.checkoutRepo.findSessionById(sessionId);
        if (current && (current.status === 'READY' || current.status === 'RESERVED')) {
          const updatedItems = await this.checkoutRepo.getCheckoutItems(sessionId);
          return this.toSessionDto(current, updatedItems);
        }

        // Concurrently CANCELLED or EXPIRED! Roll back all holds
        this.logger.warn(
          `Checkout session '${sessionId}' was concurrently modified to ${current?.status} during reservation; rolling back holds`,
        );

        for (const acq of acquiredReservations) {
          try {
            await this.inventoryService.releaseReservation(
              actor,
              acq.reservationId,
              'Rollback due to concurrent checkout cancellation/expiration',
            );
            await this.checkoutRepo.setCheckoutItemReservation(acq.itemId, null);
          } catch (relErr) {
            this.logger.error('Failed to release reservation hold during race rollback', {
              reservationId: acq.reservationId,
              error: relErr instanceof Error ? relErr.message : String(relErr),
            });
          }
        }

        throw new InvalidStateTransitionError(
          `Checkout session was ${current?.status?.toLowerCase() ?? 'modified'} during reservation; acquired reservations were released`,
        );
      }

      const updatedItems = await this.checkoutRepo.getCheckoutItems(sessionId);
      return this.toSessionDto(readySession, updatedItems);
    } catch (err: unknown) {
      if (err instanceof InvalidStateTransitionError || err instanceof CheckoutValidationError) {
        throw err;
      }

      // Check if session was already completed (READY or RESERVED) by a concurrent request
      const latestSession = await this.checkoutRepo.findSessionById(sessionId);
      if (
        latestSession &&
        (latestSession.status === 'READY' || latestSession.status === 'RESERVED')
      ) {
        const updatedItems = await this.checkoutRepo.getCheckoutItems(sessionId);
        return this.toSessionDto(latestSession, updatedItems);
      }

      // Multi-Item Compensation:
      const baseReason = err instanceof Error ? err.message : 'Unknown reservation error';
      this.logger.warn(`Checkout reservation failed; rolling back acquired holds: ${baseReason}`, {
        sessionId,
        acquiredCount: acquiredReservations.length,
      });

      const uncompensatedReservations: string[] = [];

      for (const acq of acquiredReservations) {
        try {
          await this.inventoryService.releaseReservation(
            actor,
            acq.reservationId,
            'Checkout reservation failure compensation',
          );
          await this.checkoutRepo.setCheckoutItemReservation(acq.itemId, null);
        } catch (releaseErr) {
          uncompensatedReservations.push(acq.reservationId);
          this.logger.error('Failed to compensate reservation hold during checkout failure', {
            reservationId: acq.reservationId,
            error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
          });
        }
      }

      let failureReason = baseReason;
      if (uncompensatedReservations.length > 0) {
        failureReason = `${baseReason} [CRITICAL: Compensation partially failed for reservations: ${uncompensatedReservations.join(', ')}]`;
      }

      await this.checkoutRepo.updateSessionStatus(sessionId, 'VALIDATING', 'FAILED', {
        failureReason,
        failedAt: new Date(),
      });

      throw err;
    }
  }

  private async rollbackExistingSessionHolds(
    actor: AuthorizedActor,
    sessionId: string,
    items: CheckoutItemRow[],
  ): Promise<void> {
    for (const it of items) {
      const resKey = `chk-${sessionId}-${it.id}`;
      let existingResId = it.inventory_reservation_id;
      if (!existingResId) {
        const found = await this.inventoryService.findReservationByIdempotencyKey(actor, resKey);
        if (found && found.status === 'ACTIVE') {
          existingResId = found.id;
        }
      }
      if (existingResId) {
        try {
          await this.inventoryService.releaseReservation(
            actor,
            existingResId,
            'Rollback due to checkout validation failure',
          );
          await this.checkoutRepo.setCheckoutItemReservation(it.id, null);
        } catch (err) {
          this.logger.warn(`Failed to release hold on validation failure: ${existingResId}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  private async tryAwaitRecentValidation(
    sessionId: string,
    maxAttempts = 4,
    intervalMs = 50,
  ): Promise<CheckoutSessionRow | null> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const current = await this.checkoutRepo.findSessionById(sessionId);
      if (!current) return null;
      if (current.status === 'READY' || current.status === 'RESERVED') {
        return current;
      }
      if (
        current.status === 'FAILED' ||
        current.status === 'CANCELLED' ||
        current.status === 'EXPIRED'
      ) {
        throw new InvalidStateTransitionError(
          `Checkout session transitioned to ${current.status} during validation`,
        );
      }
    }
    return null;
  }

  async getCheckoutSession(actor: AuthorizedActor, sessionId: string): Promise<CheckoutSessionDto> {
    const session = await this.checkoutRepo.findSessionById(sessionId);
    if (!session) {
      throw new NotFoundError(`Checkout session '${sessionId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'checkout:read-own');
      RbacPolicy.requireTenantMatch(actor, session.customer_tenant_id);
    }

    const items = await this.checkoutRepo.getCheckoutItems(sessionId);
    return this.toSessionDto(session, items);
  }

  async expireCheckoutSession(
    actor: AuthorizedActor,
    sessionId: string,
  ): Promise<CheckoutSessionDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'checkout:create-own');
    }

    const session = await this.checkoutRepo.findSessionById(sessionId);
    if (!session) {
      throw new NotFoundError(`Checkout session '${sessionId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, session.customer_tenant_id);
    }

    if (session.status === 'EXPIRED') {
      const items = await this.checkoutRepo.getCheckoutItems(sessionId);
      return this.toSessionDto(session, items);
    }

    if (session.status === 'CANCELLED') {
      throw new InvalidStateTransitionError('Cannot expire a cancelled checkout session');
    }

    // Atomic CAS transition: only transition from non-terminal states
    const updated = await this.checkoutRepo.updateSessionStatus(
      sessionId,
      ['OPEN', 'VALIDATING', 'RESERVED', 'READY', 'FAILED'],
      'EXPIRED',
    );

    if (!updated) {
      const current = await this.checkoutRepo.findSessionById(sessionId);
      if (current?.status === 'EXPIRED') {
        const items = await this.checkoutRepo.getCheckoutItems(sessionId);
        return this.toSessionDto(current, items);
      }
      if (current?.status === 'CANCELLED') {
        throw new InvalidStateTransitionError('Cannot expire a cancelled checkout session');
      }
      throw new InvalidStateTransitionError(
        `Cannot expire checkout session in status '${current?.status}'`,
      );
    }

    // Release any acquired reservations
    const items = await this.checkoutRepo.getCheckoutItems(sessionId);
    for (const item of items) {
      if (item.inventory_reservation_id) {
        try {
          await this.inventoryService.releaseReservation(
            actor,
            item.inventory_reservation_id,
            'Checkout session expired',
          );
          await this.checkoutRepo.setCheckoutItemReservation(item.id, null);
        } catch (err) {
          this.logger.warn(
            `Notice while releasing reservation on expired session: ${item.inventory_reservation_id}`,
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }

    const updatedItems = await this.checkoutRepo.getCheckoutItems(sessionId);
    return this.toSessionDto(updated, updatedItems);
  }

  async cancelCheckoutSession(
    actor: AuthorizedActor,
    sessionId: string,
  ): Promise<CheckoutSessionDto> {
    RbacPolicy.requirePermission(actor, 'checkout:create-own');

    const session = await this.checkoutRepo.findSessionById(sessionId);
    if (!session) {
      throw new NotFoundError(`Checkout session '${sessionId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, session.customer_tenant_id);
    }

    if (session.status === 'CANCELLED') {
      const items = await this.checkoutRepo.getCheckoutItems(sessionId);
      return this.toSessionDto(session, items);
    }

    if (session.status === 'EXPIRED') {
      throw new InvalidStateTransitionError('Cannot cancel an expired checkout session');
    }

    // Atomic CAS transition: only transition from non-terminal states
    const updated = await this.checkoutRepo.updateSessionStatus(
      sessionId,
      ['OPEN', 'VALIDATING', 'RESERVED', 'READY'],
      'CANCELLED',
      { cancelledAt: new Date() },
    );

    if (!updated) {
      const current = await this.checkoutRepo.findSessionById(sessionId);
      if (current?.status === 'CANCELLED') {
        const items = await this.checkoutRepo.getCheckoutItems(sessionId);
        return this.toSessionDto(current, items);
      }
      if (current?.status === 'EXPIRED') {
        throw new InvalidStateTransitionError('Cannot cancel an expired checkout session');
      }
      throw new InvalidStateTransitionError(
        `Cannot cancel checkout session in status '${current?.status}'`,
      );
    }

    // Release any acquired reservations
    const items = await this.checkoutRepo.getCheckoutItems(sessionId);
    for (const item of items) {
      if (item.inventory_reservation_id) {
        try {
          await this.inventoryService.releaseReservation(
            actor,
            item.inventory_reservation_id,
            'Checkout session cancelled by customer',
          );
          await this.checkoutRepo.setCheckoutItemReservation(item.id, null);
        } catch (err) {
          this.logger.warn(
            `Notice while releasing reservation on cancelled session: ${item.inventory_reservation_id}`,
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }

    const updatedItems = await this.checkoutRepo.getCheckoutItems(sessionId);
    return this.toSessionDto(updated, updatedItems);
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

    const session = await this.checkoutRepo.findSessionById(sessionId);
    if (!session) {
      throw new NotFoundError(`Checkout session '${sessionId}' not found`);
    }

    if (session.customer_tenant_id !== actor.tenantId) {
      throw new NotFoundError(`Checkout session '${sessionId}' not found`);
    }

    if (
      session.status === 'CANCELLED' ||
      session.status === 'EXPIRED' ||
      session.status === 'FAILED'
    ) {
      throw new InvalidStateTransitionError(
        `Cannot update address on session with status '${session.status}'`,
      );
    }

    const snapshot = await this.resolveShippingAddress(actor, input);

    const updated = await this.checkoutRepo.updateShippingAddress(
      sessionId,
      snapshot ? JSON.stringify(snapshot) : null,
    );
    if (!updated) {
      throw new NotFoundError(`Checkout session '${sessionId}' not found`);
    }

    const items = await this.checkoutRepo.getCheckoutItems(sessionId);
    return this.toSessionDto(updated, items);
  }

  private validateManualAddressSnapshot(raw: unknown): AddressSnapshot {
    if (!raw || typeof raw !== 'object') {
      throw new CheckoutValidationError('Manual shipping address must be an object');
    }
    const input = raw as Record<string, unknown>;

    const recipientName = typeof input.recipientName === 'string' ? input.recipientName.trim() : '';
    if (!recipientName) {
      throw new CheckoutValidationError('recipientName is required in shipping address');
    }
    if (recipientName.length > 100) {
      throw new CheckoutValidationError('recipientName exceeds maximum length of 100');
    }

    const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
    if (!phone) {
      throw new CheckoutValidationError('phone is required in shipping address');
    }
    if (phone.length > 30) {
      throw new CheckoutValidationError('phone exceeds maximum length of 30');
    }

    const addressLine1 = typeof input.addressLine1 === 'string' ? input.addressLine1.trim() : '';
    if (!addressLine1) {
      throw new CheckoutValidationError('addressLine1 is required in shipping address');
    }
    if (addressLine1.length > 200) {
      throw new CheckoutValidationError('addressLine1 exceeds maximum length of 200');
    }

    const addressLine2 = typeof input.addressLine2 === 'string' ? input.addressLine2.trim() : null;
    if (addressLine2 && addressLine2.length > 200) {
      throw new CheckoutValidationError('addressLine2 exceeds maximum length of 200');
    }

    const landmark = typeof input.landmark === 'string' ? input.landmark.trim() : null;
    if (landmark && landmark.length > 100) {
      throw new CheckoutValidationError('landmark exceeds maximum length of 100');
    }

    const city = typeof input.city === 'string' ? input.city.trim() : '';
    if (!city) {
      throw new CheckoutValidationError('city is required in shipping address');
    }
    if (city.length > 100) {
      throw new CheckoutValidationError('city exceeds maximum length of 100');
    }

    const state = typeof input.state === 'string' ? input.state.trim() : '';
    if (!state) {
      throw new CheckoutValidationError('state is required in shipping address');
    }
    if (state.length > 100) {
      throw new CheckoutValidationError('state exceeds maximum length of 100');
    }

    const postalCode = typeof input.postalCode === 'string' ? input.postalCode.trim() : '';
    if (!postalCode) {
      throw new CheckoutValidationError('postalCode is required in shipping address');
    }
    if (postalCode.length > 20) {
      throw new CheckoutValidationError('postalCode exceeds maximum length of 20');
    }

    const country =
      typeof input.country === 'string' && input.country.trim() ? input.country.trim() : 'US';
    if (country.length > 50) {
      throw new CheckoutValidationError('country exceeds maximum length of 50');
    }

    let latitude: number | null = null;
    if (input.latitude !== undefined && input.latitude !== null) {
      const latNum = Number(input.latitude);
      if (Number.isNaN(latNum) || latNum < -90 || latNum > 90) {
        throw new CheckoutValidationError('latitude must be a valid number between -90 and 90');
      }
      latitude = latNum;
    }

    let longitude: number | null = null;
    if (input.longitude !== undefined && input.longitude !== null) {
      const lngNum = Number(input.longitude);
      if (Number.isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
        throw new CheckoutValidationError('longitude must be a valid number between -180 and 180');
      }
      longitude = lngNum;
    }

    const googlePlaceId =
      typeof input.googlePlaceId === 'string' ? input.googlePlaceId.trim() : null;
    const formattedAddress =
      typeof input.formattedAddress === 'string' ? input.formattedAddress.trim() : null;

    // Strict security rule: Manual entry CANNOT claim an existing addressId or another customer's data
    return {
      sourceType: 'MANUAL_ENTRY',
      label: 'Other',
      recipientName,
      phone,
      addressLine1,
      addressLine2,
      landmark,
      city,
      state,
      postalCode,
      country,
      latitude,
      longitude,
      googlePlaceId,
      formattedAddress,
    };
  }

  private async resolveShippingAddress(
    actor: AuthorizedActor,
    input?:
      | {
          addressId?: string | null | undefined;
          shippingAddress?: AddressSnapshot | Record<string, unknown> | null | undefined;
        }
      | undefined,
  ): Promise<AddressSnapshot | null> {
    // 1. Preferred secure flow: addressId -> authenticated ownership check -> PostgreSQL lookup -> server snapshot
    if (input?.addressId) {
      if (!this.addressService) {
        throw new CheckoutValidationError('Address service unavailable');
      }
      const addr = await this.addressService.getAddressById(actor, input.addressId);
      return this.addressService.toSnapshot(addr);
    }

    // 2. Manual entry: fully validated, sanitized, server-authoritative
    if (input?.shippingAddress) {
      return this.validateManualAddressSnapshot(input.shippingAddress);
    }

    // 3. Fallback: default customer address if exists
    if (this.addressService) {
      try {
        const defaultAddr = await this.addressService.getDefaultAddress(actor);
        if (defaultAddr) {
          return this.addressService.toSnapshot(defaultAddr);
        }
      } catch {
        // Non-blocking if default address cannot be fetched
      }
    }

    return null;
  }

  private toSessionDto(
    session: {
      id: string;
      cart_id: string;
      customer_tenant_id: string;
      status: CheckoutStatus;
      currency: string;
      subtotal_amount: number;
      discount_amount: number;
      shipping_amount: number;
      tax_amount: number;
      total_amount: number;
      idempotency_key: string | null;
      expires_at: Date;
      reserved_at: Date | null;
      cancelled_at: Date | null;
      failed_at: Date | null;
      failure_reason: string | null;
      coupon_code?: string | null | undefined;
      applied_promotions?: unknown;
      shipping_address?: unknown;
      created_at: Date;
      updated_at: Date;
    },
    items: CheckoutItemRow[],
  ): CheckoutSessionDto {
    return {
      id: session.id,
      cartId: session.cart_id,
      customerTenantId: session.customer_tenant_id,
      status: session.status,
      currency: session.currency,
      subtotalAmount: session.subtotal_amount,
      discountAmount: session.discount_amount,
      shippingAmount: session.shipping_amount,
      taxAmount: session.tax_amount,
      totalAmount: session.total_amount,
      idempotencyKey: session.idempotency_key,
      expiresAt: session.expires_at.toISOString(),
      reservedAt: session.reserved_at ? session.reserved_at.toISOString() : null,
      cancelledAt: session.cancelled_at ? session.cancelled_at.toISOString() : null,
      failedAt: session.failed_at ? session.failed_at.toISOString() : null,
      failureReason: session.failure_reason,
      couponCode: session.coupon_code ?? null,
      appliedPromotions:
        typeof session.applied_promotions === 'string'
          ? JSON.parse(session.applied_promotions)
          : Array.isArray(session.applied_promotions)
            ? session.applied_promotions
            : [],
      shippingAddress: session.shipping_address
        ? typeof session.shipping_address === 'string'
          ? JSON.parse(session.shipping_address)
          : (session.shipping_address as AddressSnapshot)
        : null,
      items: items.map((i) => ({
        id: i.id,
        checkoutSessionId: i.checkout_session_id,
        listingId: i.listing_id,
        skuId: i.sku_id,
        merchantTenantId: i.merchant_tenant_id,
        productId: i.product_id ?? null,
        productTitle: i.product_title ?? null,
        productBrand: i.product_brand ?? null,
        productThumbnailUrl: i.product_thumbnail_url ?? null,
        quantity: i.quantity,
        unitPriceAmount: i.unit_price_amount,
        lineTotalAmount: i.line_total_amount,
        currency: i.currency,
        inventoryReservationId: i.inventory_reservation_id,
        createdAt: i.created_at.toISOString(),
      })),
      createdAt: session.created_at.toISOString(),
      updatedAt: session.updated_at.toISOString(),
    };
  }
}
