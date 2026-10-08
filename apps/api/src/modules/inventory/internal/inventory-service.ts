import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { RbacPolicy } from '../../identity/index.js';
import type { ListingService } from '../../marketplace/index.js';
import {
  InventoryRepository,
  type InventoryItemRow,
  type InventoryReservationRow,
  type InventoryMovementRow,
  type ReservationStatus,
  type MovementType,
} from './inventory-repository.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  InvalidStateTransitionError,
  InsufficientInventoryError,
} from '../../../errors/app-error.js';
import { OutboxService, EventTypes, createDomainEvent } from '../../events/index.js';
import {
  inventoryItemTag,
  inventoryListingTag,
  inventoryMerchantTag,
} from '../../../infra/redis/cache-keys.js';

/**
 * Minimal invalidation surface the inventory context accepts from infra.
 * Fire-and-forget by contract: implementations must never throw.
 */
export interface InventoryCacheInvalidator {
  invalidateTags(...tags: string[]): Promise<void>;
}

export interface InventoryItemDto {
  id: string;
  tenantId: string;
  listingId: string;
  skuId: string;
  onHandQuantity: number;
  reservedQuantity: number;
  nonSellableQuantity: number;
  availableQuantity: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryAvailabilityDto {
  listingId: string;
  skuId: string;
  isAvailable: boolean;
  availableQuantity: number;
}

export interface InventoryReservationDto {
  id: string;
  inventoryId: string;
  tenantId: string;
  customerTenantId?: string | null;
  quantity: number;
  status: ReservationStatus;
  idempotencyKey?: string | null;
  expiresAt?: string | null;
  consumedAt?: string | null;
  releasedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryMovementDto {
  id: string;
  inventoryId: string;
  tenantId: string;
  movementType: MovementType;
  quantityDelta: number;
  previousOnHand: number;
  newOnHand: number;
  previousReserved: number;
  newReserved: number;
  previousNonSellable: number;
  newNonSellable: number;
  referenceId?: string | null;
  actorId: string;
  notes?: string | null;
  createdAt: string;
}

export interface InitializeInventoryInput {
  listingId: string;
  initialOnHandQuantity?: number | undefined;
  initialNonSellableQuantity?: number | undefined;
}

export interface CreateReservationInput {
  inventoryId?: string | undefined;
  listingId?: string | undefined;
  quantity: number;
  idempotencyKey?: string | null | undefined;
  expiresAt?: string | null | undefined;
}

export class InventoryService {
  private readonly repo: InventoryRepository;
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private isWorkerRunning = false;

  constructor(
    private readonly db: DatabaseConnection,
    private readonly logger: Logger,
    private readonly marketplaceService: ListingService,
    private readonly outboxService?: OutboxService,
    private readonly cacheInvalidator?: InventoryCacheInvalidator | undefined,
  ) {
    this.repo = new InventoryRepository();
  }

  private async emitStockChangedEvent(
    tx: DatabaseConnection,
    inv: InventoryItemRow,
    actorId?: string,
    previousAvailableQuantity: number = 0,
  ): Promise<void> {
    // Derived-cache invalidation runs on EVERY stock mutation, independent of
    // the outbox: over-invalidation only costs a recompute, while a missed
    // invalidation serves stale availability. Fire-and-forget so the
    // transaction never waits on cache infrastructure.
    if (this.cacheInvalidator) {
      void this.cacheInvalidator
        .invalidateTags(
          inventoryListingTag(inv.listing_id),
          inventoryItemTag(inv.id),
          inventoryMerchantTag(inv.tenant_id),
        )
        .catch(() => {});
    }

    if (!this.outboxService) return;

    const availableQuantity = Math.max(
      0,
      inv.on_hand_quantity - inv.reserved_quantity - inv.non_sellable_quantity,
    );

    const event = createDomainEvent({
      eventType: EventTypes.INVENTORY_STOCK_CHANGED,
      eventVersion: 1,
      aggregateType: 'InventoryItem',
      aggregateId: inv.id,
      tenantId: inv.tenant_id,
      payload: {
        inventoryId: inv.id,
        listingId: inv.listing_id,
        skuId: inv.sku_id,
        onHandQuantity: inv.on_hand_quantity,
        reservedQuantity: inv.reserved_quantity,
        nonSellableQuantity: inv.non_sellable_quantity,
        availableQuantity,
        isAvailable: availableQuantity > 0,
        sourceVersion: new Date(inv.updated_at).getTime(),
        updatedAt: inv.updated_at,
      },
      metadata: {
        actorId,
        source: 'inventory-service',
      },
    });

    await this.outboxService.recordEvent(tx, event);

    // INVENTORY_STOCK_AVAILABLE must only be emitted when stock transitions
    // from unavailable/out-of-stock (previous <= 0) to available (new > 0).
    const isTransitionToAvailable = previousAvailableQuantity <= 0 && availableQuantity > 0;

    if (isTransitionToAvailable) {
      let productId: string | undefined = undefined;
      try {
        const skuRow = await tx.query<{ product_id: string }>(
          'SELECT product_id FROM product_skus WHERE id = $1',
          [inv.sku_id],
        );
        productId = skuRow.rows[0]?.product_id;
      } catch {
        // non-blocking lookup failure
      }

      const availableEvent = createDomainEvent({
        eventType: EventTypes.INVENTORY_STOCK_AVAILABLE,
        eventVersion: 1,
        aggregateType: 'InventoryItem',
        aggregateId: inv.id,
        tenantId: inv.tenant_id,
        payload: {
          inventoryId: inv.id,
          listingId: inv.listing_id,
          skuId: inv.sku_id,
          productId,
          availableQuantity,
          previousAvailableQuantity,
          isAvailable: true,
          updatedAt: inv.updated_at,
        },
        metadata: {
          actorId,
          source: 'inventory-service',
        },
      });

      await this.outboxService.recordEvent(tx, availableEvent);
    }
  }

  private readonly mutexLocks = new Map<string, Promise<void>>();

  private async acquireLock(key: string): Promise<() => void> {
    while (this.mutexLocks.has(key)) {
      try {
        await this.mutexLocks.get(key);
      } catch {
        // ignore errors
      }
    }
    let resolveLock!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    this.mutexLocks.set(key, promise);
    return () => {
      this.mutexLocks.delete(key);
      resolveLock();
    };
  }

  // --- Inventory Item Lifecycle ---

  async initializeInventory(
    actor: AuthorizedActor,
    input: InitializeInventoryInput,
  ): Promise<InventoryItemDto> {
    RbacPolicy.requirePermission(actor, 'inventory:create');

    const listingId = input.listingId?.trim();
    if (!listingId) throw new ValidationError('listingId is required');

    const onHand = input.initialOnHandQuantity ?? 0;
    if (typeof onHand !== 'number' || !Number.isInteger(onHand) || onHand < 0) {
      throw new ValidationError('initialOnHandQuantity must be a non-negative integer');
    }

    const nonSellable = input.initialNonSellableQuantity ?? 0;
    if (typeof nonSellable !== 'number' || !Number.isInteger(nonSellable) || nonSellable < 0) {
      throw new ValidationError('initialNonSellableQuantity must be a non-negative integer');
    }

    if (onHand - nonSellable < 0) {
      throw new ValidationError('initialNonSellableQuantity cannot exceed initialOnHandQuantity');
    }

    // Validate listing exists and belongs to the authorized merchant
    const listing = await this.marketplaceService.getListingById(actor, listingId);
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, listing.tenantId);
    }

    // Check uniqueness: only one inventory record per listing
    const existing = await this.repo.findInventoryByListingId(this.db, listingId);
    if (existing) {
      throw new ConflictError(
        `Inventory item already exists for listing '${listingId}'. Cannot initialize duplicate inventory.`,
      );
    }

    return this.db.withTransaction(async (tx) => {
      const row = await this.repo.createInventory(tx, {
        tenantId: listing.tenantId,
        listingId,
        skuId: listing.skuId,
        onHandQuantity: onHand,
        reservedQuantity: 0,
        nonSellableQuantity: nonSellable,
      });

      if (onHand > 0 || nonSellable > 0) {
        await this.repo.createMovement(tx, {
          inventoryId: row.id,
          tenantId: row.tenant_id,
          movementType: 'INITIAL_STOCK',
          quantityDelta: onHand,
          previousOnHand: 0,
          newOnHand: onHand,
          previousReserved: 0,
          newReserved: 0,
          previousNonSellable: 0,
          newNonSellable: nonSellable,
          actorId: actor.userId,
          notes: 'Initial inventory baseline',
        });
      }

      await this.emitStockChangedEvent(tx, row, actor.userId, 0);

      return this.toItemDto(row);
    });
  }

  async getInventoryById(actor: AuthorizedActor, id: string): Promise<InventoryItemDto> {
    const item = await this.repo.findInventoryById(this.db, id);
    if (!item) throw new NotFoundError(`Inventory item '${id}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'inventory:read-own');
      RbacPolicy.requireTenantMatch(actor, item.tenant_id);
    }

    return this.toItemDto(item);
  }

  async getInventoryByListingId(
    actor: AuthorizedActor,
    listingId: string,
  ): Promise<InventoryItemDto> {
    const item = await this.repo.findInventoryByListingId(this.db, listingId);
    if (!item) throw new NotFoundError(`Inventory item for listing '${listingId}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'inventory:read-own');
      RbacPolicy.requireTenantMatch(actor, item.tenant_id);
    }

    return this.toItemDto(item);
  }

  async getAvailabilityByListingId(listingId: string): Promise<InventoryAvailabilityDto> {
    const item = await this.repo.findInventoryByListingId(this.db, listingId);
    if (!item) throw new NotFoundError(`Inventory item for listing '${listingId}' not found`);

    const availableQuantity = Math.max(
      0,
      item.on_hand_quantity - item.reserved_quantity - item.non_sellable_quantity,
    );

    return {
      listingId: item.listing_id,
      skuId: item.sku_id,
      isAvailable: availableQuantity > 0,
      availableQuantity,
    };
  }

  async listInventory(
    actor: AuthorizedActor,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<InventoryItemDto[]> {
    RbacPolicy.requirePermission(actor, 'inventory:read-own');
    const rows = await this.repo.listInventoryByTenant(this.db, actor.tenantId, filter);
    return rows.map((r) => this.toItemDto(r));
  }

  // --- Controlled Stock Adjustments ---

  async increaseStock(
    actor: AuthorizedActor,
    inventoryId: string,
    quantity: number,
    notes?: string,
    referenceId?: string,
  ): Promise<InventoryItemDto> {
    const releaseLock = await this.acquireLock(`inv_adj_${inventoryId}`);
    try {
      return await this.increaseStockInternal(actor, inventoryId, quantity, notes, referenceId);
    } finally {
      releaseLock();
    }
  }

  private async increaseStockInternal(
    actor: AuthorizedActor,
    inventoryId: string,
    quantity: number,
    notes?: string,
    referenceId?: string,
  ): Promise<InventoryItemDto> {
    RbacPolicy.requirePermission(actor, 'inventory:adjust-own');

    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationError('quantity must be a positive integer');
    }

    const current = await this.repo.findInventoryById(this.db, inventoryId);
    if (!current) throw new NotFoundError(`Inventory item '${inventoryId}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, current.tenant_id);
    }

    return this.db.withTransaction(async (tx) => {
      // Database row-level lock on inventory item to serialize concurrent restocking across processes
      await tx.query('SELECT id FROM inventory_items WHERE id = $1 FOR UPDATE', [inventoryId]);

      // Idempotency check: if referenceId provided, verify if already applied
      if (referenceId) {
        const existingMovement = await this.repo.findMovementByReference(tx, referenceId, 'STOCK_INCREASE');
        if (existingMovement) {
          const latest = await this.repo.findInventoryById(tx, inventoryId);
          return this.toItemDto(latest!);
        }
      }

      let updated: InventoryItemRow | null = null;
      try {
        updated = await this.repo.atomicStockIncrease(tx, inventoryId, quantity);
        if (!updated) throw new ConflictError('Concurrent inventory update conflict');

        await this.repo.createMovement(tx, {
          inventoryId,
          tenantId: current.tenant_id,
          movementType: 'STOCK_INCREASE',
          quantityDelta: quantity,
          previousOnHand: current.on_hand_quantity,
          newOnHand: updated.on_hand_quantity,
          previousReserved: current.reserved_quantity,
          newReserved: updated.reserved_quantity,
          previousNonSellable: current.non_sellable_quantity,
          newNonSellable: updated.non_sellable_quantity,
          referenceId: referenceId ?? null,
          actorId: actor.userId,
          notes: notes ?? null,
        });
      } catch (err: unknown) {
        if (
          referenceId &&
          err instanceof Error &&
          (err.message.includes('uq_inventory_movement') ||
            (err as { code?: string }).code === '23505')
        ) {
          const latest = await this.repo.findInventoryById(tx, inventoryId);
          return this.toItemDto(latest!);
        }
        throw err;
      }

      const previousAvailable = Math.max(
        0,
        current.on_hand_quantity - current.reserved_quantity - current.non_sellable_quantity,
      );
      await this.emitStockChangedEvent(tx, updated, actor.userId, previousAvailable);

      return this.toItemDto(updated);
    });
  }

  async decreaseStock(
    actor: AuthorizedActor,
    inventoryId: string,
    quantity: number,
    notes?: string,
  ): Promise<InventoryItemDto> {
    RbacPolicy.requirePermission(actor, 'inventory:adjust-own');

    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationError('quantity must be a positive integer');
    }

    const current = await this.repo.findInventoryById(this.db, inventoryId);
    if (!current) throw new NotFoundError(`Inventory item '${inventoryId}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, current.tenant_id);
    }

    // Availability validation: cannot decrease below reserved + non-sellable stock
    if (current.on_hand_quantity - quantity < current.reserved_quantity + current.non_sellable_quantity) {
      throw new InsufficientInventoryError(
        `Cannot decrease stock by ${quantity}: current on-hand (${current.on_hand_quantity}) has ${current.reserved_quantity} reserved and ${current.non_sellable_quantity} non-sellable units.`,
      );
    }

    return this.db.withTransaction(async (tx) => {
      const updated = await this.repo.atomicStockDecrease(tx, inventoryId, quantity);
      if (!updated) {
        throw new InsufficientInventoryError('Insufficient stock available for decrease');
      }

      await this.repo.createMovement(tx, {
        inventoryId,
        tenantId: current.tenant_id,
        movementType: 'STOCK_DECREASE',
        quantityDelta: -quantity,
        previousOnHand: current.on_hand_quantity,
        newOnHand: updated.on_hand_quantity,
        previousReserved: current.reserved_quantity,
        newReserved: updated.reserved_quantity,
        previousNonSellable: current.non_sellable_quantity,
        newNonSellable: updated.non_sellable_quantity,
        actorId: actor.userId,
        notes: notes ?? null,
      });

      const previousAvailable = Math.max(
        0,
        current.on_hand_quantity - current.reserved_quantity - current.non_sellable_quantity,
      );
      await this.emitStockChangedEvent(tx, updated, actor.userId, previousAvailable);

      return this.toItemDto(updated);
    });
  }

  async adjustNonSellable(
    actor: AuthorizedActor,
    inventoryId: string,
    newNonSellableQuantity: number,
    notes?: string,
    referenceId?: string,
  ): Promise<InventoryItemDto> {
    const releaseLock = await this.acquireLock(`inv_adj_${inventoryId}`);
    try {
      return await this.adjustNonSellableInternal(
        actor,
        inventoryId,
        newNonSellableQuantity,
        notes,
        referenceId,
      );
    } finally {
      releaseLock();
    }
  }

  private async adjustNonSellableInternal(
    actor: AuthorizedActor,
    inventoryId: string,
    newNonSellableQuantity: number,
    notes?: string,
    referenceId?: string,
  ): Promise<InventoryItemDto> {
    RbacPolicy.requirePermission(actor, 'inventory:adjust-own');

    if (
      typeof newNonSellableQuantity !== 'number' ||
      !Number.isInteger(newNonSellableQuantity) ||
      newNonSellableQuantity < 0
    ) {
      throw new ValidationError('newNonSellableQuantity must be a non-negative integer');
    }

    const current = await this.repo.findInventoryById(this.db, inventoryId);
    if (!current) throw new NotFoundError(`Inventory item '${inventoryId}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, current.tenant_id);
    }

    return this.db.withTransaction(async (tx) => {
      // Database row-level lock on inventory item to serialize concurrent non-sellable adjustments
      await tx.query('SELECT id FROM inventory_items WHERE id = $1 FOR UPDATE', [inventoryId]);

      if (referenceId) {
        const existingMovement = await this.repo.findMovementByReference(
          tx,
          referenceId,
          'NON_SELLABLE_ADJUSTMENT',
        );
        if (existingMovement) {
          const latest = await this.repo.findInventoryById(tx, inventoryId);
          return this.toItemDto(latest!);
        }
      }

      // Invariant: On Hand - Reserved >= newNonSellable
      if (current.on_hand_quantity - current.reserved_quantity < newNonSellableQuantity) {
        throw new InsufficientInventoryError(
          `Cannot adjust non-sellable to ${newNonSellableQuantity}: unreserved stock is only ${current.on_hand_quantity - current.reserved_quantity}.`,
        );
      }

      let updated: InventoryItemRow | null = null;
      try {
        updated = await this.repo.atomicNonSellableAdjust(
          tx,
          inventoryId,
          newNonSellableQuantity,
        );
        if (!updated) {
          throw new InsufficientInventoryError('Insufficient unreserved inventory for non-sellable adjustment');
        }

        const delta = newNonSellableQuantity - current.non_sellable_quantity;
        await this.repo.createMovement(tx, {
          inventoryId,
          tenantId: current.tenant_id,
          movementType: 'NON_SELLABLE_ADJUSTMENT',
          quantityDelta: delta,
          previousOnHand: current.on_hand_quantity,
          newOnHand: updated.on_hand_quantity,
          previousReserved: current.reserved_quantity,
          newReserved: updated.reserved_quantity,
          previousNonSellable: current.non_sellable_quantity,
          newNonSellable: updated.non_sellable_quantity,
          referenceId: referenceId ?? null,
          actorId: actor.userId,
          notes: notes ?? null,
        });
      } catch (err: unknown) {
        if (
          referenceId &&
          err instanceof Error &&
          (err.message.includes('uq_inventory_movement') ||
            (err as { code?: string }).code === '23505')
        ) {
          const latest = await this.repo.findInventoryById(tx, inventoryId);
          return this.toItemDto(latest!);
        }
        throw err;
      }

      const previousAvailable = Math.max(
        0,
        current.on_hand_quantity - current.reserved_quantity - current.non_sellable_quantity,
      );
      await this.emitStockChangedEvent(tx, updated, actor.userId, previousAvailable);

      return this.toItemDto(updated);
    });
  }

  // --- Concurrency-Safe Reservations ---

  async createReservation(
    actor: AuthorizedActor,
    input: CreateReservationInput,
  ): Promise<InventoryReservationDto> {
    RbacPolicy.requirePermission(actor, 'inventory:reserve');

    if (typeof input.quantity !== 'number' || !Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new ValidationError('quantity must be a positive integer');
    }

    // Resolve inventory ID
    let inventoryId = input.inventoryId;
    if (!inventoryId && input.listingId) {
      const item = await this.repo.findInventoryByListingId(this.db, input.listingId);
      if (!item) throw new NotFoundError(`Inventory for listing '${input.listingId}' not found`);
      inventoryId = item.id;
    }

    if (!inventoryId) {
      throw new ValidationError('Either inventoryId or listingId must be provided');
    }

    // Idempotency check: if client supplied idempotencyKey and it was already processed, return existing
    if (input.idempotencyKey) {
      const existing = await this.repo.findReservationByIdempotencyKey(
        this.db,
        actor.tenantId,
        input.idempotencyKey,
      );
      if (existing) {
        return this.toReservationDto(existing);
      }
    }

    try {
      return await this.db.withTransaction(async (tx) => {
        // Atomic conditional update guarantees no overselling under concurrency:
        // UPDATE inventory_items SET reserved_quantity = reserved_quantity + $qty WHERE (on_hand - reserved - non_sellable) >= $qty
        const updatedInv = await this.repo.atomicReserve(tx, inventoryId, input.quantity);

        if (!updatedInv) {
          // If concurrent request already acquired reservation with the same idempotency key, return it
          if (input.idempotencyKey) {
            const concurrent = await this.repo.findReservationByIdempotencyKey(
              this.db,
              actor.tenantId,
              input.idempotencyKey,
            );
            if (concurrent) {
              return this.toReservationDto(concurrent);
            }
          }

          // Distinguish between item not existing vs insufficient available inventory
          const item = await this.repo.findInventoryById(tx, inventoryId);
          if (!item) throw new NotFoundError(`Inventory item '${inventoryId}' not found`);

          const available = item.on_hand_quantity - item.reserved_quantity - item.non_sellable_quantity;
          throw new InsufficientInventoryError(
            `Insufficient inventory available: requested ${input.quantity}, available ${available}`,
          );
        }

        // Record reservation
        const reservation = await this.repo.createReservation(tx, {
          inventoryId,
          tenantId: updatedInv.tenant_id,
          customerTenantId: actor.tenantId,
          quantity: input.quantity,
          status: 'ACTIVE',
          idempotencyKey: input.idempotencyKey ?? null,
          expiresAt: input.expiresAt ?? null,
        });

        // Record movement
        await this.repo.createMovement(tx, {
          inventoryId,
          tenantId: updatedInv.tenant_id,
          movementType: 'RESERVATION_HOLD',
          quantityDelta: input.quantity,
          previousOnHand: updatedInv.on_hand_quantity,
          newOnHand: updatedInv.on_hand_quantity,
          previousReserved: updatedInv.reserved_quantity - input.quantity,
          newReserved: updatedInv.reserved_quantity,
          previousNonSellable: updatedInv.non_sellable_quantity,
          newNonSellable: updatedInv.non_sellable_quantity,
          referenceId: reservation.id,
          actorId: actor.userId,
          notes: `Reservation ${reservation.id} hold`,
        });

        const previousAvailable = Math.max(
          0,
          updatedInv.on_hand_quantity - (updatedInv.reserved_quantity - input.quantity) - updatedInv.non_sellable_quantity,
        );
        await this.emitStockChangedEvent(tx, updatedInv, actor.userId, previousAvailable);

        return this.toReservationDto(reservation);
      });
    } catch (err: unknown) {
      if (input.idempotencyKey) {
        const concurrent = await this.repo.findReservationByIdempotencyKey(
          this.db,
          actor.tenantId,
          input.idempotencyKey,
        );
        if (concurrent) {
          return this.toReservationDto(concurrent);
        }
      }
      throw err;
    }
  }

  async getReservationById(
    actor: AuthorizedActor,
    id: string,
  ): Promise<InventoryReservationDto> {
    const res = await this.repo.findReservationById(this.db, id);
    if (!res) throw new NotFoundError(`Reservation '${id}' not found`);

    if (
      actor.role !== 'ADMINISTRATOR' &&
      actor.tenantId !== res.tenant_id &&
      actor.tenantId !== res.customer_tenant_id
    ) {
      RbacPolicy.requireTenantMatch(actor, res.tenant_id);
    }

    return this.toReservationDto(res);
  }

  async findReservationByIdempotencyKey(
    actor: AuthorizedActor,
    idempotencyKey: string,
  ): Promise<InventoryReservationDto | null> {
    const res = await this.repo.findReservationByIdempotencyKey(
      this.db,
      actor.tenantId,
      idempotencyKey,
    );
    if (!res) return null;
    return this.toReservationDto(res);
  }

  async releaseReservation(
    actor: AuthorizedActor,
    id: string,
    notes?: string,
  ): Promise<InventoryReservationDto> {
    RbacPolicy.requirePermission(actor, 'inventory:release-own');

    return this.db.withTransaction(async (tx) => {
      const res = await this.repo.findReservationById(tx, id);
      if (!res) throw new NotFoundError(`Reservation '${id}' not found`);

      if (
        actor.role !== 'ADMINISTRATOR' &&
        actor.tenantId !== res.tenant_id &&
        actor.tenantId !== res.customer_tenant_id
      ) {
        RbacPolicy.requireTenantMatch(actor, res.tenant_id);
      }

      if (res.status !== 'ACTIVE') {
        throw new InvalidStateTransitionError(
          `Cannot release reservation in status '${res.status}'. Only ACTIVE reservations can be released.`,
        );
      }

      const updatedRes = await this.repo.updateReservationStatus(
        tx,
        id,
        'ACTIVE',
        'RELEASED',
        'released_at',
      );
      if (!updatedRes) {
        throw new ConflictError('Concurrent reservation modification conflict');
      }

      const updatedInv = await this.repo.atomicRelease(tx, res.inventory_id, res.quantity);
      if (!updatedInv) {
        throw new ConflictError('Failed to decrement reserved quantity on inventory item');
      }

      await this.repo.createMovement(tx, {
        inventoryId: res.inventory_id,
        tenantId: updatedInv.tenant_id,
        movementType: 'RESERVATION_RELEASE',
        quantityDelta: -res.quantity,
        previousOnHand: updatedInv.on_hand_quantity,
        newOnHand: updatedInv.on_hand_quantity,
        previousReserved: updatedInv.reserved_quantity + res.quantity,
        newReserved: updatedInv.reserved_quantity,
        previousNonSellable: updatedInv.non_sellable_quantity,
        newNonSellable: updatedInv.non_sellable_quantity,
        referenceId: id,
        actorId: actor.userId,
        notes: notes ?? 'Reservation released',
      });

      const previousAvailable = Math.max(
        0,
        updatedInv.on_hand_quantity - (updatedInv.reserved_quantity + res.quantity) - updatedInv.non_sellable_quantity,
      );
      await this.emitStockChangedEvent(tx, updatedInv, actor.userId, previousAvailable);

      return this.toReservationDto(updatedRes);
    });
  }

  async consumeReservation(
    actor: AuthorizedActor,
    id: string,
    notes?: string,
  ): Promise<InventoryReservationDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'inventory:consume-own');
    }

    return this.db.withTransaction(async (tx) => {
      const res = await this.repo.findReservationById(tx, id);
      if (!res) throw new NotFoundError(`Reservation '${id}' not found`);

      if (actor.role !== 'ADMINISTRATOR') {
        RbacPolicy.requireTenantMatch(actor, res.tenant_id);
      }

      if (res.status === 'CONSUMED') {
        return this.toReservationDto(res);
      }
      if (res.status !== 'ACTIVE') {
        throw new InvalidStateTransitionError(
          `Cannot consume reservation in status '${res.status}'. Only ACTIVE reservations can be consumed.`,
        );
      }

      const updatedRes = await this.repo.updateReservationStatus(
        tx,
        id,
        'ACTIVE',
        'CONSUMED',
        'consumed_at',
      );
      if (!updatedRes) {
        throw new ConflictError('Concurrent reservation modification conflict');
      }

      // Decrement both reserved_quantity and on_hand_quantity atomically
      const updatedInv = await this.repo.atomicConsume(tx, res.inventory_id, res.quantity);
      if (!updatedInv) {
        throw new ConflictError('Failed to decrement on-hand and reserved quantity on inventory item');
      }

      await this.repo.createMovement(tx, {
        inventoryId: res.inventory_id,
        tenantId: updatedInv.tenant_id,
        movementType: 'RESERVATION_CONSUME',
        quantityDelta: -res.quantity,
        previousOnHand: updatedInv.on_hand_quantity + res.quantity,
        newOnHand: updatedInv.on_hand_quantity,
        previousReserved: updatedInv.reserved_quantity + res.quantity,
        newReserved: updatedInv.reserved_quantity,
        previousNonSellable: updatedInv.non_sellable_quantity,
        newNonSellable: updatedInv.non_sellable_quantity,
        referenceId: id,
        actorId: actor.userId,
        notes: notes ?? 'Reservation consumed by order/checkout',
      });

      const previousAvailable = Math.max(
        0,
        updatedInv.on_hand_quantity - updatedInv.reserved_quantity - updatedInv.non_sellable_quantity,
      );
      await this.emitStockChangedEvent(tx, updatedInv, actor.userId, previousAvailable);

      return this.toReservationDto(updatedRes);
    });
  }

  async expireReservation(id: string, notes?: string): Promise<InventoryReservationDto> {
    return this.db.withTransaction(async (tx) => {
      const res = await this.repo.findReservationById(tx, id);
      if (!res) throw new NotFoundError(`Reservation '${id}' not found`);

      if (res.status === 'EXPIRED' || res.status === 'RELEASED' || res.status === 'CONSUMED') {
        return this.toReservationDto(res);
      }

      if (res.status !== 'ACTIVE') {
        throw new InvalidStateTransitionError(
          `Cannot expire reservation in status '${res.status}'. Only ACTIVE reservations can be expired.`,
        );
      }

      const updatedRes = await this.repo.updateReservationStatus(
        tx,
        id,
        'ACTIVE',
        'EXPIRED',
        'released_at',
      );
      if (!updatedRes) {
        throw new ConflictError('Concurrent reservation modification conflict');
      }

      const updatedInv = await this.repo.atomicRelease(tx, res.inventory_id, res.quantity);
      if (!updatedInv) {
        throw new ConflictError('Failed to decrement reserved quantity on inventory item');
      }

      await this.repo.createMovement(tx, {
        inventoryId: res.inventory_id,
        tenantId: updatedInv.tenant_id,
        movementType: 'RESERVATION_RELEASE',
        quantityDelta: -res.quantity,
        previousOnHand: updatedInv.on_hand_quantity,
        newOnHand: updatedInv.on_hand_quantity,
        previousReserved: updatedInv.reserved_quantity + res.quantity,
        newReserved: updatedInv.reserved_quantity,
        previousNonSellable: updatedInv.non_sellable_quantity,
        newNonSellable: updatedInv.non_sellable_quantity,
        referenceId: id,
        actorId: 'SYSTEM_EXPIRATION',
        notes: notes ?? 'Reservation expired',
      });

      const previousAvailable = Math.max(
        0,
        updatedInv.on_hand_quantity - (updatedInv.reserved_quantity + res.quantity) - updatedInv.non_sellable_quantity,
      );
      await this.emitStockChangedEvent(tx, updatedInv, 'SYSTEM_EXPIRATION', previousAvailable);

      return this.toReservationDto(updatedRes);
    });
  }

  async processExpirations(batchSize: number = 50): Promise<number> {
    try {
      return await this.db.withTransaction(async (tx) => {
        const expiredRows = await this.repo.claimExpiredReservations(tx, batchSize);
        if (expiredRows.length === 0) return 0;

      let processedCount = 0;
      for (const res of expiredRows) {
        // Atomic status transition
        const updatedRes = await this.repo.updateReservationStatus(
          tx,
          res.id,
          'ACTIVE',
          'EXPIRED',
          'released_at',
        );
        if (!updatedRes) {
          continue; // Concurrent modification resolved safely
        }

        const updatedInv = await this.repo.atomicRelease(tx, res.inventory_id, res.quantity);
        if (!updatedInv) {
          throw new ConflictError(`Failed to decrement reserved quantity on inventory item ${res.inventory_id}`);
        }

        await this.repo.createMovement(tx, {
          inventoryId: res.inventory_id,
          tenantId: updatedInv.tenant_id,
          movementType: 'RESERVATION_RELEASE',
          quantityDelta: -res.quantity,
          previousOnHand: updatedInv.on_hand_quantity,
          newOnHand: updatedInv.on_hand_quantity,
          previousReserved: updatedInv.reserved_quantity + res.quantity,
          newReserved: updatedInv.reserved_quantity,
          previousNonSellable: updatedInv.non_sellable_quantity,
          newNonSellable: updatedInv.non_sellable_quantity,
          referenceId: res.id,
          actorId: 'SYSTEM_EXPIRATION',
          notes: 'Automatic background expiration',
        });
        const previousAvailable = Math.max(
          0,
          updatedInv.on_hand_quantity - (updatedInv.reserved_quantity + res.quantity) - updatedInv.non_sellable_quantity,
        );
        await this.emitStockChangedEvent(tx, updatedInv, 'SYSTEM_EXPIRATION', previousAvailable);
        processedCount++;
      }
      return processedCount;
    });
    } catch(err) {
      console.error('PROCESSEXPIRATIONS ERROR:', err);
      throw err;
    }
  }

  startExpirationWorker(intervalMs: number = 60000): void {
    if (this.workerTimer) {
      this.logger.warn('Inventory expiration worker is already running');
      return;
    }

    this.logger.info(`Starting inventory expiration worker (interval: ${intervalMs}ms)`);
    this.workerTimer = setInterval(async () => {
      if (this.isWorkerRunning) return;
      this.isWorkerRunning = true;
      try {
        let totalProcessed = 0;
        let count = 0;
        do {
          count = await this.processExpirations(100);
          totalProcessed += count;
        } while (count > 0);

        if (totalProcessed > 0) {
          this.logger.info(`Inventory expiration worker processed ${totalProcessed} reservations`);
        }
      } catch (err) {
        this.logger.error('Inventory expiration worker failed during execution', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.isWorkerRunning = false;
      }
    }, intervalMs);
  }

  stopExpirationWorker(): void {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
      this.logger.info('Inventory expiration worker stopped');
    }
  }

  // --- Audit Movement History ---

  async getMovements(actor: AuthorizedActor, inventoryId: string): Promise<InventoryMovementDto[]> {
    RbacPolicy.requirePermission(actor, 'inventory:read-own');

    const item = await this.repo.findInventoryById(this.db, inventoryId);
    if (!item) throw new NotFoundError(`Inventory item '${inventoryId}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, item.tenant_id);
    }

    const rows = await this.repo.listMovementsByInventory(this.db, inventoryId);
    return rows.map((r) => this.toMovementDto(r));
  }

  // --- DTO Mappers ---

  private toItemDto(row: InventoryItemRow): InventoryItemDto {
    const available = Math.max(
      0,
      row.on_hand_quantity - row.reserved_quantity - row.non_sellable_quantity,
    );
    return {
      id: row.id,
      tenantId: row.tenant_id,
      listingId: row.listing_id,
      skuId: row.sku_id,
      onHandQuantity: row.on_hand_quantity,
      reservedQuantity: row.reserved_quantity,
      nonSellableQuantity: row.non_sellable_quantity,
      availableQuantity: available,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toReservationDto(row: InventoryReservationRow): InventoryReservationDto {
    return {
      id: row.id,
      inventoryId: row.inventory_id,
      tenantId: row.tenant_id,
      customerTenantId: row.customer_tenant_id,
      quantity: row.quantity,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      releasedAt: row.released_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toMovementDto(row: InventoryMovementRow): InventoryMovementDto {
    return {
      id: row.id,
      inventoryId: row.inventory_id,
      tenantId: row.tenant_id,
      movementType: row.movement_type,
      quantityDelta: row.quantity_delta,
      previousOnHand: row.previous_on_hand,
      newOnHand: row.new_on_hand,
      previousReserved: row.previous_reserved,
      newReserved: row.new_reserved,
      previousNonSellable: row.previous_non_sellable,
      newNonSellable: row.new_non_sellable,
      referenceId: row.reference_id,
      actorId: row.actor_id,
      notes: row.notes,
      createdAt: row.created_at,
    };
  }
}
