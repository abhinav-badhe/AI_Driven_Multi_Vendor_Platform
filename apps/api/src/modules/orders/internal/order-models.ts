import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  CreateOrderInput,
  CustomerOrderDto,
  SellerOrderDto,
  OrderItemDto,
} from './order-service.js';
import type {
  CustomerOrderStatus,
  SellerOrderStatus,
} from './order-repository.js';

export type {
  CreateOrderInput,
  CustomerOrderDto,
  SellerOrderDto,
  OrderItemDto,
  CustomerOrderStatus,
  SellerOrderStatus,
};

/**
 * IOrderReader - Decoupled read interface for Customer Orders and Seller Orders.
 * Consumed by Fulfillment, Settlement & Ledger, AI orchestration, and Analytics domains.
 */
export interface IOrderReader {
  getCustomerOrder(actor: AuthorizedActor, id: string): Promise<CustomerOrderDto>;
  listCustomerOrders(
    actor: AuthorizedActor,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<CustomerOrderDto[]>;
  getSellerOrder(actor: AuthorizedActor, id: string): Promise<SellerOrderDto>;
  listSellerOrders(
    actor: AuthorizedActor,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<SellerOrderDto[]>;
}

/**
 * IOrderService - Full order management interface.
 * Implemented by local SQL OrderService, InMemoryOrderStore, and HttpOrderClient.
 */
export interface IOrderService extends IOrderReader {
  createOrderFromCheckout(
    actor: AuthorizedActor,
    input: CreateOrderInput,
  ): Promise<CustomerOrderDto>;
  updateCustomerOrderStatus(
    actor: AuthorizedActor,
    orderId: string,
    nextStatus: CustomerOrderStatus,
  ): Promise<CustomerOrderDto>;
  updateSellerOrderStatus(
    actor: AuthorizedActor,
    sellerOrderId: string,
    nextStatus: SellerOrderStatus,
  ): Promise<SellerOrderDto>;
}
