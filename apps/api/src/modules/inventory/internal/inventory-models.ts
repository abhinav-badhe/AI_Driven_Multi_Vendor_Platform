import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  InventoryItemDto,
  InventoryAvailabilityDto,
  InventoryReservationDto,
  InventoryMovementDto,
  InitializeInventoryInput,
  CreateReservationInput,
} from './inventory-service.js';
import type {
  ReservationStatus,
  MovementType,
} from './inventory-repository.js';

export type {
  InventoryItemDto,
  InventoryAvailabilityDto,
  InventoryReservationDto,
  InventoryMovementDto,
  InitializeInventoryInput,
  CreateReservationInput,
  ReservationStatus,
  MovementType,
};

/**
 * IInventoryReader - Decoupled read interface for stock availability and reservations.
 * Consumed by Cart/Checkout, Search, Orders, AI, and Recommendations domains.
 */
export interface IInventoryReader {
  getAvailabilityByListingId(listingId: string): Promise<InventoryAvailabilityDto>;
  getInventoryById(actor: AuthorizedActor, id: string): Promise<InventoryItemDto>;
  getInventoryByListingId(actor: AuthorizedActor, listingId: string): Promise<InventoryItemDto>;
  getReservationById(actor: AuthorizedActor, id: string): Promise<InventoryReservationDto>;
  findReservationByIdempotencyKey(
    actor: AuthorizedActor,
    idempotencyKey: string,
  ): Promise<InventoryReservationDto | null>;
}

/**
 * IInventoryService - Full inventory management interface.
 * Implemented by local SQL InventoryService, InMemoryInventoryStore, and HttpInventoryClient.
 */
export interface IInventoryService extends IInventoryReader {
  initializeInventory(
    actor: AuthorizedActor,
    input: InitializeInventoryInput,
  ): Promise<InventoryItemDto>;
  listInventory(
    actor: AuthorizedActor,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<InventoryItemDto[]>;
  listAllInventory?(
    actor: AuthorizedActor,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<InventoryItemDto[]>;
  increaseStock(
    actor: AuthorizedActor,
    inventoryId: string,
    quantity: number,
    notes?: string,
    referenceId?: string,
  ): Promise<InventoryItemDto>;
  decreaseStock(
    actor: AuthorizedActor,
    inventoryId: string,
    quantity: number,
    notes?: string,
  ): Promise<InventoryItemDto>;
  adjustNonSellable(
    actor: AuthorizedActor,
    inventoryId: string,
    newNonSellableQuantity: number,
    notes?: string,
    referenceId?: string,
  ): Promise<InventoryItemDto>;
  createReservation(
    actor: AuthorizedActor,
    input: CreateReservationInput,
  ): Promise<InventoryReservationDto>;
  releaseReservation(
    actor: AuthorizedActor,
    id: string,
    notes?: string,
  ): Promise<InventoryReservationDto>;
  consumeReservation(
    actor: AuthorizedActor,
    id: string,
    notes?: string,
  ): Promise<InventoryReservationDto>;
  expireReservation(id: string, notes?: string): Promise<InventoryReservationDto>;
  processExpirations(batchSize?: number): Promise<number>;
  getMovements(actor: AuthorizedActor, inventoryId: string): Promise<InventoryMovementDto[]>;
  startExpirationWorker?(intervalMs?: number): void;
  stopExpirationWorker?(): void;
}

