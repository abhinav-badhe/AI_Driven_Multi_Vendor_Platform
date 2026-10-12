import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { CheckoutService, ICheckoutReader } from '../cart-checkout/index.js';
import type { CatalogService, ICatalogReader } from '../catalog/index.js';
import type { InventoryService, IInventoryService } from '../inventory/index.js';
import type { PaymentService, IPaymentReader } from '../payment/index.js';
import { OrderService } from './internal/order-service.js';
import { InMemoryOrderStore } from './internal/in-memory-order-store.js';
import { HttpOrderClient, type HttpOrderClientOptions } from './internal/http-order-client.js';
import type { OutboxService } from '../events/index.js';
import type {
  IOrderReader,
  IOrderService,
  CreateOrderInput,
  CustomerOrderDto,
  SellerOrderDto,
  OrderItemDto,
  CustomerOrderStatus,
  SellerOrderStatus,
} from './internal/order-models.js';
import { OrderEventConsumer } from './internal/order-consumer.js';
import type { EventTransport } from '../events/index.js';
import { OutboxRepository } from '../events/index.js';
import type { PromotionService } from '../promotion-pricing/index.js';

export type {
  IOrderReader,
  IOrderService,
  CreateOrderInput,
  CustomerOrderDto,
  SellerOrderDto,
  OrderItemDto,
  CustomerOrderStatus,
  SellerOrderStatus,
  HttpOrderClientOptions,
};

export { OrderService, OrderEventConsumer, InMemoryOrderStore, HttpOrderClient };

export interface OrdersModule {
  readonly contextName: 'orders';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    checkoutService: ICheckoutReader | CheckoutService,
    catalogService: ICatalogReader | CatalogService,
    inventoryService: IInventoryService | InventoryService,
    paymentService: IPaymentReader | PaymentService,
    outboxService?: OutboxService | undefined,
    promotionService?: PromotionService | undefined,
  ): OrderService;
  createConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    orderService: IOrderService | OrderService,
  ): OrderEventConsumer;
  createInMemoryOrderStore(): InMemoryOrderStore;
  createHttpOrderClient(serviceUrl: string, options?: HttpOrderClientOptions): HttpOrderClient;
}

export const ordersModule: OrdersModule = {
  contextName: 'orders',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    checkoutService: ICheckoutReader | CheckoutService,
    catalogService: ICatalogReader | CatalogService,
    inventoryService: IInventoryService | InventoryService,
    paymentService: IPaymentReader | PaymentService,
    outboxService?: OutboxService | undefined,
    promotionService?: PromotionService | undefined,
  ): OrderService {
    return new OrderService(
      db,
      logger,
      checkoutService,
      catalogService,
      inventoryService,
      paymentService,
      outboxService,
      promotionService,
    );
  },
  createConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    orderService: IOrderService | OrderService,
  ): OrderEventConsumer {
    const outboxRepo = new OutboxRepository();
    const consumer = new OrderEventConsumer(db, outboxRepo, transport, logger, orderService);
    consumer.registerSubscriptions();
    return consumer;
  },
  createInMemoryOrderStore(): InMemoryOrderStore {
    return new InMemoryOrderStore();
  },
  createHttpOrderClient(serviceUrl: string, options?: HttpOrderClientOptions): HttpOrderClient {
    return new HttpOrderClient(serviceUrl, options);
  },
};
