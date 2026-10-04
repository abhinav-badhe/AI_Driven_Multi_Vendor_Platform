import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { CheckoutService } from '../cart-checkout/index.js';
import type { CatalogService } from '../catalog/index.js';
import type { InventoryService } from '../inventory/index.js';
import type { PaymentService } from '../payment/index.js';
import { OrderService } from './internal/order-service.js';
import type {
  CreateOrderInput,
  CustomerOrderDto,
  SellerOrderDto,
  OrderItemDto,
} from './internal/order-service.js';
import { OrderEventConsumer } from './internal/order-consumer.js';
import type { EventTransport } from '../events/index.js';
import { OutboxRepository } from '../events/index.js';
import type {
  CustomerOrderStatus,
  SellerOrderStatus,
} from './internal/order-repository.js';

export type {
  CreateOrderInput,
  CustomerOrderDto,
  SellerOrderDto,
  OrderItemDto,
  CustomerOrderStatus,
  SellerOrderStatus,
};

export interface OrdersModule {
  readonly contextName: 'orders';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    checkoutService: CheckoutService,
    catalogService: CatalogService,
    inventoryService: InventoryService,
    paymentService: PaymentService,
  ): OrderService;
  createConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    orderService: OrderService,
  ): OrderEventConsumer;
}

export const ordersModule: OrdersModule = {
  contextName: 'orders',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    checkoutService: CheckoutService,
    catalogService: CatalogService,
    inventoryService: InventoryService,
    paymentService: PaymentService,
  ): OrderService {
    return new OrderService(
      db,
      logger,
      checkoutService,
      catalogService,
      inventoryService,
      paymentService,
    );
  },
  createConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    orderService: OrderService,
  ): OrderEventConsumer {
    const outboxRepo = new OutboxRepository();
    const consumer = new OrderEventConsumer(db, outboxRepo, transport, logger, orderService);
    consumer.registerSubscriptions();
    return consumer;
  },
};

export { OrderService, OrderEventConsumer };
