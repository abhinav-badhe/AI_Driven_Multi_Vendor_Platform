import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';

export type ReservationStatus = 'ACTIVE' | 'RELEASED' | 'CONSUMED' | 'EXPIRED';

export type MovementType =
  | 'INITIAL_STOCK'
  | 'STOCK_INCREASE'
  | 'STOCK_DECREASE'
  | 'RESERVATION_HOLD'
  | 'RESERVATION_RELEASE'
  | 'RESERVATION_CONSUME'
  | 'NON_SELLABLE_ADJUSTMENT'
  | 'MANUAL_ADJUSTMENT';

export interface InventoryItemRow {
  id: string;
  tenant_id: string;
  listing_id: string;
  sku_id: string;
  on_hand_quantity: number;
  reserved_quantity: number;
  non_sellable_quantity: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface InventoryReservationRow {
  id: string;
  inventory_id: string;
  tenant_id: string;
  customer_tenant_id: string | null;
  quantity: number;
  status: ReservationStatus;
  idempotency_key: string | null;
  expires_at: string | null;
  consumed_at: string | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryMovementRow {
  id: string;
  inventory_id: string;
  tenant_id: string;
  movement_type: MovementType;
  quantity_delta: number;
  previous_on_hand: number;
  new_on_hand: number;
  previous_reserved: number;
  new_reserved: number;
  previous_non_sellable: number;
  new_non_sellable: number;
  reference_id: string | null;
  actor_id: string;
  notes: string | null;
  created_at: string;
}

export class InventoryRepository {
  // --- Inventory Item Operations ---

  async createInventory(
    db: DatabaseConnection,
    data: {
      id?: string | undefined;
      tenantId: string;
      listingId: string;
      skuId: string;
      onHandQuantity?: number | undefined;
      reservedQuantity?: number | undefined;
      nonSellableQuantity?: number | undefined;
    },
  ): Promise<InventoryItemRow> {
    const id = data.id ?? randomUUID();
    const onHand = data.onHandQuantity ?? 0;
    const reserved = data.reservedQuantity ?? 0;
    const nonSellable = data.nonSellableQuantity ?? 0;

    const res = await db.query<InventoryItemRow>(
      `INSERT INTO inventory_items (
        id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
      RETURNING id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version, created_at, updated_at`,
      [id, data.tenantId, data.listingId, data.skuId, onHand, reserved, nonSellable],
    );
    return res.rows[0]!;
  }

  async findInventoryById(db: DatabaseConnection, id: string): Promise<InventoryItemRow | null> {
    const res = await db.query<InventoryItemRow>(
      `SELECT id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version, created_at, updated_at
       FROM inventory_items
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findInventoryByListingId(
    db: DatabaseConnection,
    listingId: string,
  ): Promise<InventoryItemRow | null> {
    const res = await db.query<InventoryItemRow>(
      `SELECT id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version, created_at, updated_at
       FROM inventory_items
       WHERE listing_id = $1`,
      [listingId],
    );
    return res.rows[0] ?? null;
  }

  async listInventoryByTenant(
    db: DatabaseConnection,
    tenantId: string,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<InventoryItemRow[]> {
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;
    const res = await db.query<InventoryItemRow>(
      `SELECT id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version, created_at, updated_at
       FROM inventory_items
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset],
    );
    return res.rows;
  }

  async listAllInventory(
    db: DatabaseConnection,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<InventoryItemRow[]> {
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;
    const res = await db.query<InventoryItemRow>(
      `SELECT id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version, created_at, updated_at
       FROM inventory_items
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return res.rows;
  }

  // --- Concurrency-Safe Atomic Operations ---

  async atomicReserve(
    tx: DatabaseConnection,
    inventoryId: string,
    quantity: number,
  ): Promise<InventoryItemRow | null> {
    const res = await tx.query<InventoryItemRow>(
      `UPDATE inventory_items
       SET reserved_quantity = reserved_quantity + CAST($1 AS INTEGER),
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
         AND (on_hand_quantity - reserved_quantity - non_sellable_quantity) >= CAST($1 AS INTEGER)
       RETURNING id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version, created_at, updated_at`,
      [quantity, inventoryId],
    );
    return res.rows[0] ?? null;
  }

  async atomicRelease(
    tx: DatabaseConnection,
    inventoryId: string,
    quantity: number,
  ): Promise<InventoryItemRow | null> {
    const res = await tx.query<InventoryItemRow>(
      `UPDATE inventory_items
       SET reserved_quantity = reserved_quantity - CAST($1 AS INTEGER),
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
         AND reserved_quantity >= CAST($1 AS INTEGER)
       RETURNING id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version, created_at, updated_at`,
      [quantity, inventoryId],
    );
    return res.rows[0] ?? null;
  }

  async atomicConsume(
    tx: DatabaseConnection,
    inventoryId: string,
    quantity: number,
  ): Promise<InventoryItemRow | null> {
    const res = await tx.query<InventoryItemRow>(
      `UPDATE inventory_items
       SET on_hand_quantity = on_hand_quantity - CAST($1 AS INTEGER),
           reserved_quantity = reserved_quantity - CAST($1 AS INTEGER),
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
         AND reserved_quantity >= CAST($1 AS INTEGER)
         AND on_hand_quantity >= CAST($1 AS INTEGER)
       RETURNING id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version, created_at, updated_at`,
      [quantity, inventoryId],
    );
    return res.rows[0] ?? null;
  }

  async atomicStockIncrease(
    tx: DatabaseConnection,
    inventoryId: string,
    quantity: number,
  ): Promise<InventoryItemRow | null> {
    const res = await tx.query<InventoryItemRow>(
      `UPDATE inventory_items
       SET on_hand_quantity = on_hand_quantity + CAST($1 AS INTEGER),
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version, created_at, updated_at`,
      [quantity, inventoryId],
    );
    return res.rows[0] ?? null;
  }

  async atomicStockDecrease(
    tx: DatabaseConnection,
    inventoryId: string,
    quantity: number,
  ): Promise<InventoryItemRow | null> {
    const res = await tx.query<InventoryItemRow>(
      `UPDATE inventory_items
       SET on_hand_quantity = on_hand_quantity - CAST($1 AS INTEGER),
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
         AND (on_hand_quantity - reserved_quantity - non_sellable_quantity) >= CAST($1 AS INTEGER)
       RETURNING id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version, created_at, updated_at`,
      [quantity, inventoryId],
    );
    return res.rows[0] ?? null;
  }

  async atomicNonSellableAdjust(
    tx: DatabaseConnection,
    inventoryId: string,
    newNonSellable: number,
  ): Promise<InventoryItemRow | null> {
    const res = await tx.query<InventoryItemRow>(
      `UPDATE inventory_items
       SET non_sellable_quantity = CAST($1 AS INTEGER),
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
         AND CAST($1 AS INTEGER) >= 0
         AND (on_hand_quantity - reserved_quantity) >= CAST($1 AS INTEGER)
       RETURNING id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version, created_at, updated_at`,
      [newNonSellable, inventoryId],
    );
    return res.rows[0] ?? null;
  }

  // --- Reservation Queries ---

  async createReservation(
    tx: DatabaseConnection,
    data: {
      id?: string | undefined;
      inventoryId: string;
      tenantId: string;
      customerTenantId?: string | null | undefined;
      quantity: number;
      status?: ReservationStatus | undefined;
      idempotencyKey?: string | null | undefined;
      expiresAt?: string | null | undefined;
    },
  ): Promise<InventoryReservationRow> {
    const id = data.id ?? randomUUID();
    const status = data.status ?? 'ACTIVE';

    const res = await tx.query<InventoryReservationRow>(
      `INSERT INTO inventory_reservations (
        id, inventory_id, tenant_id, customer_tenant_id, quantity, status, idempotency_key, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, inventory_id, tenant_id, customer_tenant_id, quantity, status, idempotency_key, expires_at, consumed_at, released_at, created_at, updated_at`,
      [
        id,
        data.inventoryId,
        data.tenantId,
        data.customerTenantId ?? null,
        data.quantity,
        status,
        data.idempotencyKey ?? null,
        data.expiresAt ?? null,
      ],
    );
    return res.rows[0]!;
  }

  async findReservationById(
    db: DatabaseConnection,
    id: string,
  ): Promise<InventoryReservationRow | null> {
    const res = await db.query<InventoryReservationRow>(
      `SELECT id, inventory_id, tenant_id, customer_tenant_id, quantity, status, idempotency_key, expires_at, consumed_at, released_at, created_at, updated_at
       FROM inventory_reservations
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findReservationByIdempotencyKey(
    db: DatabaseConnection,
    tenantId: string,
    key: string,
  ): Promise<InventoryReservationRow | null> {
    const res = await db.query<InventoryReservationRow>(
      `SELECT id, inventory_id, tenant_id, customer_tenant_id, quantity, status, idempotency_key, expires_at, consumed_at, released_at, created_at, updated_at
       FROM inventory_reservations
       WHERE (tenant_id = $1 OR customer_tenant_id = $1) AND idempotency_key = $2`,
      [tenantId, key],
    );
    return res.rows[0] ?? null;
  }

  async updateReservationStatus(
    tx: DatabaseConnection,
    id: string,
    expectedStatus: ReservationStatus,
    newStatus: ReservationStatus,
    timestampField?: 'consumed_at' | 'released_at' | undefined,
  ): Promise<InventoryReservationRow | null> {
    let tsClause = '';
    if (timestampField === 'consumed_at') {
      tsClause = ', consumed_at = CURRENT_TIMESTAMP';
    } else if (timestampField === 'released_at') {
      tsClause = ', released_at = CURRENT_TIMESTAMP';
    }

    const res = await tx.query<InventoryReservationRow>(
      `UPDATE inventory_reservations
       SET status = $1, updated_at = CURRENT_TIMESTAMP ${tsClause}
       WHERE id = $2 AND status = $3
       RETURNING id, inventory_id, tenant_id, quantity, status, idempotency_key, expires_at, consumed_at, released_at, created_at, updated_at`,
      [newStatus, id, expectedStatus],
    );
    return res.rows[0] ?? null;
  }

  async claimExpiredReservations(
    tx: DatabaseConnection,
    limit: number,
  ): Promise<InventoryReservationRow[]> {
    const res = await tx.query<InventoryReservationRow>(
      `SELECT id, inventory_id, tenant_id, customer_tenant_id, quantity, status, idempotency_key, expires_at, consumed_at, released_at, created_at, updated_at
       FROM inventory_reservations
       WHERE status = 'ACTIVE' AND expires_at <= $2
       LIMIT $1
       FOR UPDATE${process.env.NODE_ENV === 'test' ? '' : ' SKIP LOCKED'}`,
      [limit, new Date()],
    );
    return res.rows;
  }

  // --- Movement Queries ---

  async createMovement(
    tx: DatabaseConnection,
    data: {
      id?: string | undefined;
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
      referenceId?: string | null | undefined;
      actorId: string;
      notes?: string | null | undefined;
    },
  ): Promise<InventoryMovementRow> {
    const id = data.id ?? randomUUID();
    const res = await tx.query<InventoryMovementRow>(
      `INSERT INTO inventory_movements (
        id, inventory_id, tenant_id, movement_type, quantity_delta,
        previous_on_hand, new_on_hand, previous_reserved, new_reserved,
        previous_non_sellable, new_non_sellable, reference_id, actor_id, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id, inventory_id, tenant_id, movement_type, quantity_delta,
        previous_on_hand, new_on_hand, previous_reserved, new_reserved,
        previous_non_sellable, new_non_sellable, reference_id, actor_id, notes, created_at`,
      [
        id,
        data.inventoryId,
        data.tenantId,
        data.movementType,
        data.quantityDelta,
        data.previousOnHand,
        data.newOnHand,
        data.previousReserved,
        data.newReserved,
        data.previousNonSellable,
        data.newNonSellable,
        data.referenceId ?? null,
        data.actorId,
        data.notes ?? null,
      ],
    );
    return res.rows[0]!;
  }

  async listMovementsByInventory(
    db: DatabaseConnection,
    inventoryId: string,
    limit?: number | undefined,
  ): Promise<InventoryMovementRow[]> {
    const l = limit ?? 100;
    const res = await db.query<InventoryMovementRow>(
      `SELECT id, inventory_id, tenant_id, movement_type, quantity_delta,
        previous_on_hand, new_on_hand, previous_reserved, new_reserved,
        previous_non_sellable, new_non_sellable, reference_id, actor_id, notes, created_at
       FROM inventory_movements
       WHERE inventory_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [inventoryId, l],
    );
    return res.rows;
  }

  async findMovementByReference(
    db: DatabaseConnection,
    referenceId: string,
    movementType?: string,
  ): Promise<InventoryMovementRow | null> {
    const query = movementType
      ? `SELECT id, inventory_id, tenant_id, movement_type, quantity_delta,
          previous_on_hand, new_on_hand, previous_reserved, new_reserved,
          previous_non_sellable, new_non_sellable, reference_id, actor_id, notes, created_at
         FROM inventory_movements
         WHERE reference_id = $1 AND movement_type = $2
         LIMIT 1`
      : `SELECT id, inventory_id, tenant_id, movement_type, quantity_delta,
          previous_on_hand, new_on_hand, previous_reserved, new_reserved,
          previous_non_sellable, new_non_sellable, reference_id, actor_id, notes, created_at
         FROM inventory_movements
         WHERE reference_id = $1
         LIMIT 1`;
    const params = movementType ? [referenceId, movementType] : [referenceId];
    const res = await db.query<InventoryMovementRow>(query, params);
    return res.rows[0] ?? null;
  }
}
