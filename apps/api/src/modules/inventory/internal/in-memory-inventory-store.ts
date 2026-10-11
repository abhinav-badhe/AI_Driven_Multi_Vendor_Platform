import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import { RbacPolicy } from '../../identity/rbac/policy.js';
import type {
  IInventoryService,
  InventoryItemDto,
  InventoryAvailabilityDto,
  InventoryReservationDto,
  InventoryMovementDto,
  InitializeInventoryInput,
  CreateReservationInput,
} from './inventory-models.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  InvalidStateTransitionError,
  InsufficientInventoryError,
} from '../../../errors/app-error.js';

export class InMemoryInventoryStore implements IInventoryService {
  private readonly items = new Map<string, InventoryItemDto>();
  private readonly itemsByListingId = new Map<string, string>(); // listingId -> itemId
  private readonly reservations = new Map<string, InventoryReservationDto>();
  private readonly reservationsByIdempotency = new Map<string, string>(); // `${customerTenantId}:${key}` -> reservationId
  private readonly movements: InventoryMovementDto[] = [];
  private readonly referenceMovements = new Map<string, InventoryMovementDto>(); // `${inventoryId}:${refId}:${type}`

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

    if (this.itemsByListingId.has(listingId)) {
      throw new ConflictError(
        `Inventory item already exists for listing '${listingId}'. Cannot initialize duplicate inventory.`,
      );
    }

    const now = new Date().toISOString();
    const itemId = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const available = onHand - nonSellable;

    const item: InventoryItemDto = {
      id: itemId,
      tenantId: actor.tenantId,
      listingId,
      skuId: `sku-${listingId}`,
      onHandQuantity: onHand,
      reservedQuantity: 0,
      nonSellableQuantity: nonSellable,
      availableQuantity: available,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.items.set(itemId, item);
    this.itemsByListingId.set(listingId, itemId);

    if (onHand > 0 || nonSellable > 0) {
      const movement: InventoryMovementDto = {
        id: `mov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        inventoryId: itemId,
        tenantId: actor.tenantId,
        movementType: 'INITIAL_STOCK',
        quantityDelta: onHand,
        previousOnHand: 0,
        newOnHand: onHand,
        previousReserved: 0,
        newReserved: 0,
        previousNonSellable: 0,
        newNonSellable: nonSellable,
        referenceId: null,
        actorId: actor.userId,
        notes: 'Initial inventory baseline',
        createdAt: now,
      };
      this.movements.push(movement);
    }

    return item;
  }

  async getInventoryById(actor: AuthorizedActor, id: string): Promise<InventoryItemDto> {
    const item = this.items.get(id);
    if (!item) throw new NotFoundError(`Inventory item '${id}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'inventory:read-own');
      RbacPolicy.requireTenantMatch(actor, item.tenantId);
    }

    return item;
  }

  async getInventoryByListingId(
    actor: AuthorizedActor,
    listingId: string,
  ): Promise<InventoryItemDto> {
    const itemId = this.itemsByListingId.get(listingId);
    if (!itemId) throw new NotFoundError(`Inventory item for listing '${listingId}' not found`);
    const item = this.items.get(itemId);
    if (!item) throw new NotFoundError(`Inventory item for listing '${listingId}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'inventory:read-own');
      RbacPolicy.requireTenantMatch(actor, item.tenantId);
    }

    return item;
  }

  async getAvailabilityByListingId(listingId: string): Promise<InventoryAvailabilityDto> {
    const itemId = this.itemsByListingId.get(listingId);
    if (!itemId) throw new NotFoundError(`Inventory item for listing '${listingId}' not found`);
    const item = this.items.get(itemId);
    if (!item) throw new NotFoundError(`Inventory item for listing '${listingId}' not found`);

    const availableQuantity = Math.max(
      0,
      item.onHandQuantity - item.reservedQuantity - item.nonSellableQuantity,
    );

    return {
      listingId: item.listingId,
      skuId: item.skuId,
      isAvailable: availableQuantity > 0,
      availableQuantity,
    };
  }

  async listInventory(
    actor: AuthorizedActor,
    filter?: { limit?: number | undefined; offset?: number | undefined },
  ): Promise<InventoryItemDto[]> {
    RbacPolicy.requirePermission(actor, 'inventory:read-own');
    let results = Array.from(this.items.values()).filter((i) => i.tenantId === actor.tenantId);

    if (filter?.offset) {
      results = results.slice(filter.offset);
    }
    if (filter?.limit) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  async listAllInventory(
    actor: AuthorizedActor,
    filter?: { limit?: number | undefined; offset?: number | undefined },
  ): Promise<InventoryItemDto[]> {
    RbacPolicy.requirePermission(actor, 'inventory:manage-any');
    let results = Array.from(this.items.values());

    if (filter?.offset) {
      results = results.slice(filter.offset);
    }
    if (filter?.limit) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  async increaseStock(
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

    const current = this.items.get(inventoryId);
    if (!current) throw new NotFoundError(`Inventory item '${inventoryId}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, current.tenantId);
    }

    if (referenceId) {
      const refKey = `${inventoryId}:${referenceId}:STOCK_INCREASE`;
      if (this.referenceMovements.has(refKey)) {
        return current;
      }
    }

    const now = new Date().toISOString();
    const newOnHand = current.onHandQuantity + quantity;
    const newAvailable = newOnHand - current.reservedQuantity - current.nonSellableQuantity;

    const updated: InventoryItemDto = {
      ...current,
      onHandQuantity: newOnHand,
      availableQuantity: newAvailable,
      version: current.version + 1,
      updatedAt: now,
    };
    this.items.set(inventoryId, updated);

    const movement: InventoryMovementDto = {
      id: `mov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      inventoryId,
      tenantId: current.tenantId,
      movementType: 'STOCK_INCREASE',
      quantityDelta: quantity,
      previousOnHand: current.onHandQuantity,
      newOnHand,
      previousReserved: current.reservedQuantity,
      newReserved: current.reservedQuantity,
      previousNonSellable: current.nonSellableQuantity,
      newNonSellable: current.nonSellableQuantity,
      referenceId: referenceId ?? null,
      actorId: actor.userId,
      notes: notes ?? null,
      createdAt: now,
    };
    this.movements.push(movement);
    if (referenceId) {
      this.referenceMovements.set(`${inventoryId}:${referenceId}:STOCK_INCREASE`, movement);
    }

    return updated;
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

    const current = this.items.get(inventoryId);
    if (!current) throw new NotFoundError(`Inventory item '${inventoryId}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, current.tenantId);
    }

    if (
      current.onHandQuantity - quantity <
      current.reservedQuantity + current.nonSellableQuantity
    ) {
      throw new InsufficientInventoryError(
        `Cannot decrease stock by ${quantity}: current on-hand (${current.onHandQuantity}) has ${current.reservedQuantity} reserved and ${current.nonSellableQuantity} non-sellable units.`,
      );
    }

    const now = new Date().toISOString();
    const newOnHand = current.onHandQuantity - quantity;
    const newAvailable = newOnHand - current.reservedQuantity - current.nonSellableQuantity;

    const updated: InventoryItemDto = {
      ...current,
      onHandQuantity: newOnHand,
      availableQuantity: newAvailable,
      version: current.version + 1,
      updatedAt: now,
    };
    this.items.set(inventoryId, updated);

    const movement: InventoryMovementDto = {
      id: `mov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      inventoryId,
      tenantId: current.tenantId,
      movementType: 'STOCK_DECREASE',
      quantityDelta: -quantity,
      previousOnHand: current.onHandQuantity,
      newOnHand,
      previousReserved: current.reservedQuantity,
      newReserved: current.reservedQuantity,
      previousNonSellable: current.nonSellableQuantity,
      newNonSellable: current.nonSellableQuantity,
      referenceId: null,
      actorId: actor.userId,
      notes: notes ?? null,
      createdAt: now,
    };
    this.movements.push(movement);

    return updated;
  }

  async adjustNonSellable(
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

    const current = this.items.get(inventoryId);
    if (!current) throw new NotFoundError(`Inventory item '${inventoryId}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, current.tenantId);
    }

    if (referenceId) {
      const refKey = `${inventoryId}:${referenceId}:NON_SELLABLE_ADJUSTMENT`;
      if (this.referenceMovements.has(refKey)) {
        return current;
      }
    }

    if (current.onHandQuantity - current.reservedQuantity < newNonSellableQuantity) {
      throw new InsufficientInventoryError(
        `Cannot adjust non-sellable to ${newNonSellableQuantity}: unreserved stock is only ${current.onHandQuantity - current.reservedQuantity}.`,
      );
    }

    const now = new Date().toISOString();
    const delta = newNonSellableQuantity - current.nonSellableQuantity;
    const newAvailable =
      current.onHandQuantity - current.reservedQuantity - newNonSellableQuantity;

    const updated: InventoryItemDto = {
      ...current,
      nonSellableQuantity: newNonSellableQuantity,
      availableQuantity: newAvailable,
      version: current.version + 1,
      updatedAt: now,
    };
    this.items.set(inventoryId, updated);

    const movement: InventoryMovementDto = {
      id: `mov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      inventoryId,
      tenantId: current.tenantId,
      movementType: 'NON_SELLABLE_ADJUSTMENT',
      quantityDelta: delta,
      previousOnHand: current.onHandQuantity,
      newOnHand: current.onHandQuantity,
      previousReserved: current.reservedQuantity,
      newReserved: current.reservedQuantity,
      previousNonSellable: current.nonSellableQuantity,
      newNonSellable: newNonSellableQuantity,
      referenceId: referenceId ?? null,
      actorId: actor.userId,
      notes: notes ?? null,
      createdAt: now,
    };
    this.movements.push(movement);
    if (referenceId) {
      this.referenceMovements.set(
        `${inventoryId}:${referenceId}:NON_SELLABLE_ADJUSTMENT`,
        movement,
      );
    }

    return updated;
  }

  async createReservation(
    actor: AuthorizedActor,
    input: CreateReservationInput,
  ): Promise<InventoryReservationDto> {
    RbacPolicy.requirePermission(actor, 'inventory:reserve');

    if (
      typeof input.quantity !== 'number' ||
      !Number.isInteger(input.quantity) ||
      input.quantity <= 0
    ) {
      throw new ValidationError('quantity must be a positive integer');
    }

    let inventoryId = input.inventoryId;
    if (!inventoryId && input.listingId) {
      const resolvedId = this.itemsByListingId.get(input.listingId);
      if (!resolvedId) {
        throw new NotFoundError(`Inventory for listing '${input.listingId}' not found`);
      }
      inventoryId = resolvedId;
    }

    if (!inventoryId) {
      throw new ValidationError('Either inventoryId or listingId must be provided');
    }

    if (input.idempotencyKey) {
      const idmpKey = `${actor.tenantId}:${input.idempotencyKey}`;
      const existingId = this.reservationsByIdempotency.get(idmpKey);
      if (existingId) {
        const existing = this.reservations.get(existingId);
        if (existing) return existing;
      }
    }

    const current = this.items.get(inventoryId);
    if (!current) throw new NotFoundError(`Inventory item '${inventoryId}' not found`);

    const available =
      current.onHandQuantity - current.reservedQuantity - current.nonSellableQuantity;
    if (available < input.quantity) {
      throw new InsufficientInventoryError(
        `Insufficient inventory available: requested ${input.quantity}, available ${available}`,
      );
    }

    const now = new Date().toISOString();
    const newReserved = current.reservedQuantity + input.quantity;
    const newAvailable = current.onHandQuantity - newReserved - current.nonSellableQuantity;

    const updatedItem: InventoryItemDto = {
      ...current,
      reservedQuantity: newReserved,
      availableQuantity: newAvailable,
      version: current.version + 1,
      updatedAt: now,
    };
    this.items.set(inventoryId, updatedItem);

    const reservationId = `res-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reservation: InventoryReservationDto = {
      id: reservationId,
      inventoryId,
      tenantId: current.tenantId,
      customerTenantId: actor.tenantId,
      quantity: input.quantity,
      status: 'ACTIVE',
      idempotencyKey: input.idempotencyKey ?? null,
      expiresAt: input.expiresAt ?? null,
      consumedAt: null,
      releasedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.reservations.set(reservationId, reservation);

    if (input.idempotencyKey) {
      this.reservationsByIdempotency.set(
        `${actor.tenantId}:${input.idempotencyKey}`,
        reservationId,
      );
    }

    const movement: InventoryMovementDto = {
      id: `mov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      inventoryId,
      tenantId: current.tenantId,
      movementType: 'RESERVATION_HOLD',
      quantityDelta: input.quantity,
      previousOnHand: current.onHandQuantity,
      newOnHand: current.onHandQuantity,
      previousReserved: current.reservedQuantity,
      newReserved,
      previousNonSellable: current.nonSellableQuantity,
      newNonSellable: current.nonSellableQuantity,
      referenceId: reservationId,
      actorId: actor.userId,
      notes: `Reservation ${reservationId} hold`,
      createdAt: now,
    };
    this.movements.push(movement);

    return reservation;
  }

  async getReservationById(
    actor: AuthorizedActor,
    id: string,
  ): Promise<InventoryReservationDto> {
    const res = this.reservations.get(id);
    if (!res) throw new NotFoundError(`Reservation '${id}' not found`);

    if (
      actor.role !== 'ADMINISTRATOR' &&
      actor.tenantId !== res.tenantId &&
      actor.tenantId !== res.customerTenantId
    ) {
      RbacPolicy.requireTenantMatch(actor, res.tenantId);
    }

    return res;
  }

  async findReservationByIdempotencyKey(
    actor: AuthorizedActor,
    idempotencyKey: string,
  ): Promise<InventoryReservationDto | null> {
    const idmpKey = `${actor.tenantId}:${idempotencyKey}`;
    const id = this.reservationsByIdempotency.get(idmpKey);
    if (!id) return null;
    return this.reservations.get(id) ?? null;
  }

  async releaseReservation(
    actor: AuthorizedActor,
    id: string,
    notes?: string,
  ): Promise<InventoryReservationDto> {
    RbacPolicy.requirePermission(actor, 'inventory:release-own');

    const res = this.reservations.get(id);
    if (!res) throw new NotFoundError(`Reservation '${id}' not found`);

    if (
      actor.role !== 'ADMINISTRATOR' &&
      actor.tenantId !== res.tenantId &&
      actor.tenantId !== res.customerTenantId
    ) {
      RbacPolicy.requireTenantMatch(actor, res.tenantId);
    }

    if (res.status !== 'ACTIVE') {
      throw new InvalidStateTransitionError(
        `Cannot release reservation in status '${res.status}'. Only ACTIVE reservations can be released.`,
      );
    }

    const currentItem = this.items.get(res.inventoryId);
    if (!currentItem) throw new NotFoundError(`Inventory item '${res.inventoryId}' not found`);

    const now = new Date().toISOString();
    const updatedRes: InventoryReservationDto = {
      ...res,
      status: 'RELEASED',
      releasedAt: now,
      updatedAt: now,
    };
    this.reservations.set(id, updatedRes);

    const newReserved = Math.max(0, currentItem.reservedQuantity - res.quantity);
    const newAvailable =
      currentItem.onHandQuantity - newReserved - currentItem.nonSellableQuantity;
    const updatedItem: InventoryItemDto = {
      ...currentItem,
      reservedQuantity: newReserved,
      availableQuantity: newAvailable,
      version: currentItem.version + 1,
      updatedAt: now,
    };
    this.items.set(res.inventoryId, updatedItem);

    const movement: InventoryMovementDto = {
      id: `mov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      inventoryId: res.inventoryId,
      tenantId: currentItem.tenantId,
      movementType: 'RESERVATION_RELEASE',
      quantityDelta: -res.quantity,
      previousOnHand: currentItem.onHandQuantity,
      newOnHand: currentItem.onHandQuantity,
      previousReserved: currentItem.reservedQuantity,
      newReserved,
      previousNonSellable: currentItem.nonSellableQuantity,
      newNonSellable: currentItem.nonSellableQuantity,
      referenceId: id,
      actorId: actor.userId,
      notes: notes ?? 'Reservation released',
      createdAt: now,
    };
    this.movements.push(movement);

    return updatedRes;
  }

  async consumeReservation(
    actor: AuthorizedActor,
    id: string,
    notes?: string,
  ): Promise<InventoryReservationDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'inventory:consume-own');
    }

    const res = this.reservations.get(id);
    if (!res) throw new NotFoundError(`Reservation '${id}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, res.tenantId);
    }

    if (res.status === 'CONSUMED') {
      return res;
    }
    if (res.status !== 'ACTIVE') {
      throw new InvalidStateTransitionError(
        `Cannot consume reservation in status '${res.status}'. Only ACTIVE reservations can be consumed.`,
      );
    }

    const currentItem = this.items.get(res.inventoryId);
    if (!currentItem) throw new NotFoundError(`Inventory item '${res.inventoryId}' not found`);

    const now = new Date().toISOString();
    const updatedRes: InventoryReservationDto = {
      ...res,
      status: 'CONSUMED',
      consumedAt: now,
      updatedAt: now,
    };
    this.reservations.set(id, updatedRes);

    const newReserved = Math.max(0, currentItem.reservedQuantity - res.quantity);
    const newOnHand = Math.max(0, currentItem.onHandQuantity - res.quantity);
    const newAvailable = newOnHand - newReserved - currentItem.nonSellableQuantity;

    const updatedItem: InventoryItemDto = {
      ...currentItem,
      onHandQuantity: newOnHand,
      reservedQuantity: newReserved,
      availableQuantity: newAvailable,
      version: currentItem.version + 1,
      updatedAt: now,
    };
    this.items.set(res.inventoryId, updatedItem);

    const movement: InventoryMovementDto = {
      id: `mov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      inventoryId: res.inventoryId,
      tenantId: currentItem.tenantId,
      movementType: 'RESERVATION_CONSUME',
      quantityDelta: -res.quantity,
      previousOnHand: currentItem.onHandQuantity,
      newOnHand,
      previousReserved: currentItem.reservedQuantity,
      newReserved,
      previousNonSellable: currentItem.nonSellableQuantity,
      newNonSellable: currentItem.nonSellableQuantity,
      referenceId: id,
      actorId: actor.userId,
      notes: notes ?? 'Reservation consumed by order/checkout',
      createdAt: now,
    };
    this.movements.push(movement);

    return updatedRes;
  }

  async expireReservation(id: string, notes?: string): Promise<InventoryReservationDto> {
    const res = this.reservations.get(id);
    if (!res) throw new NotFoundError(`Reservation '${id}' not found`);

    if (res.status === 'EXPIRED' || res.status === 'RELEASED' || res.status === 'CONSUMED') {
      return res;
    }

    if (res.status !== 'ACTIVE') {
      throw new InvalidStateTransitionError(
        `Cannot expire reservation in status '${res.status}'. Only ACTIVE reservations can be expired.`,
      );
    }

    const currentItem = this.items.get(res.inventoryId);
    if (!currentItem) throw new NotFoundError(`Inventory item '${res.inventoryId}' not found`);

    const now = new Date().toISOString();
    const updatedRes: InventoryReservationDto = {
      ...res,
      status: 'EXPIRED',
      releasedAt: now,
      updatedAt: now,
    };
    this.reservations.set(id, updatedRes);

    const newReserved = Math.max(0, currentItem.reservedQuantity - res.quantity);
    const newAvailable =
      currentItem.onHandQuantity - newReserved - currentItem.nonSellableQuantity;
    const updatedItem: InventoryItemDto = {
      ...currentItem,
      reservedQuantity: newReserved,
      availableQuantity: newAvailable,
      version: currentItem.version + 1,
      updatedAt: now,
    };
    this.items.set(res.inventoryId, updatedItem);

    const movement: InventoryMovementDto = {
      id: `mov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      inventoryId: res.inventoryId,
      tenantId: currentItem.tenantId,
      movementType: 'RESERVATION_RELEASE',
      quantityDelta: -res.quantity,
      previousOnHand: currentItem.onHandQuantity,
      newOnHand: currentItem.onHandQuantity,
      previousReserved: currentItem.reservedQuantity,
      newReserved,
      previousNonSellable: currentItem.nonSellableQuantity,
      newNonSellable: currentItem.nonSellableQuantity,
      referenceId: id,
      actorId: 'SYSTEM_EXPIRATION',
      notes: notes ?? 'Reservation expired',
      createdAt: now,
    };
    this.movements.push(movement);

    return updatedRes;
  }

  async processExpirations(batchSize: number = 50): Promise<number> {
    const now = new Date();
    const expiredToProcess: InventoryReservationDto[] = [];

    for (const res of this.reservations.values()) {
      if (res.status === 'ACTIVE' && res.expiresAt) {
        if (new Date(res.expiresAt) <= now) {
          expiredToProcess.push(res);
          if (expiredToProcess.length >= batchSize) break;
        }
      }
    }

    for (const res of expiredToProcess) {
      await this.expireReservation(res.id, 'Automatic background expiration');
    }

    return expiredToProcess.length;
  }

  async getMovements(
    actor: AuthorizedActor,
    inventoryId: string,
  ): Promise<InventoryMovementDto[]> {
    RbacPolicy.requirePermission(actor, 'inventory:read-own');

    const item = this.items.get(inventoryId);
    if (!item) throw new NotFoundError(`Inventory item '${inventoryId}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, item.tenantId);
    }

    return this.movements.filter((m) => m.inventoryId === inventoryId);
  }
}
