/**
 * BOUNDED CONTEXT: Customer
 * Ownership: Customer-specific data (delivery addresses, wishlist, preferences, reviews, consent records).
 */

import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { CartService, ICartService } from '../cart-checkout/index.js';
import type { OutboxService } from '../events/index.js';
import { CustomerAddressService } from './internal/customer-address-service.js';
import { CustomerAddressRepository } from './internal/customer-address-repository.js';
import { WishlistService } from './internal/wishlist-service.js';
import { WishlistRepository } from './internal/wishlist-repository.js';
import type {
  AddressLabel,
  CustomerAddressRow,
  CustomerAddressDto,
  CreateAddressInput,
  UpdateAddressInput,
  AddressSnapshot,
  ICustomerAddressReader,
} from './internal/customer-address-models.js';
import type {
  WishlistItemRow,
  WishlistItemDto,
  WishlistProductSummary,
  WishlistSkuSummary,
  WishlistOfferSummary,
  WishlistAvailabilitySummary,
  AddWishlistItemInput,
  SaveForLaterInput,
  MoveToCartInput,
  WishlistCheckResultDto,
} from './internal/wishlist-models.js';

import { BackInStockService } from './internal/back-in-stock-service.js';
import { BackInStockRepository } from './internal/back-in-stock-repository.js';
import { BackInStockEventConsumer } from './internal/back-in-stock-consumer.js';
import type {
  BackInStockSubscriptionStatus,
  BackInStockSubscriptionRow,
  BackInStockSubscriptionDto,
  CreateBackInStockInput,
  BackInStockCheckResultDto,
} from './internal/back-in-stock-models.js';
import type { EventTransport } from '../events/index.js';
import { OutboxRepository } from '../events/index.js';
import type { INotificationClient } from '../notifications/index.js';

export type {
  AddressLabel,
  CustomerAddressRow,
  CustomerAddressDto,
  CreateAddressInput,
  UpdateAddressInput,
  AddressSnapshot,
  WishlistItemRow,
  WishlistItemDto,
  WishlistProductSummary,
  WishlistSkuSummary,
  WishlistOfferSummary,
  WishlistAvailabilitySummary,
  AddWishlistItemInput,
  SaveForLaterInput,
  MoveToCartInput,
  WishlistCheckResultDto,
  BackInStockSubscriptionStatus,
  BackInStockSubscriptionRow,
  BackInStockSubscriptionDto,
  CreateBackInStockInput,
  BackInStockCheckResultDto,
  ICustomerAddressReader,
};

import { InMemoryCustomerAddressStore } from './internal/in-memory-customer-address-store.js';
import {
  HttpCustomerAddressClient,
  type HttpCustomerAddressClientOptions,
} from './internal/http-customer-address-client.js';

export {
  CustomerAddressService,
  CustomerAddressRepository,
  WishlistService,
  WishlistRepository,
  BackInStockService,
  BackInStockRepository,
  BackInStockEventConsumer,
  InMemoryCustomerAddressStore,
  HttpCustomerAddressClient,
  type HttpCustomerAddressClientOptions,
};

export interface CustomerModule {
  readonly contextName: 'customer';
  createAddressService(db: DatabaseConnection, logger: Logger): CustomerAddressService;
  createInMemoryAddressStore(): InMemoryCustomerAddressStore;
  createHttpAddressClient(
    serviceUrl: string,
    options?: HttpCustomerAddressClientOptions,
  ): HttpCustomerAddressClient;
  createWishlistService(
    db: DatabaseConnection,
    logger: Logger,
    cartService: ICartService | CartService,
    outboxService?: OutboxService | undefined,
  ): WishlistService;
  createBackInStockService(
    db: DatabaseConnection,
    logger: Logger,
    notificationService?: INotificationClient | undefined,
    outboxService?: OutboxService | undefined,
    frontendUrl?: string | undefined,
  ): BackInStockService;
  createBackInStockConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    service: BackInStockService,
  ): BackInStockEventConsumer;
}

export const customerModule: CustomerModule = {
  contextName: 'customer',
  createAddressService(db: DatabaseConnection, logger: Logger): CustomerAddressService {
    return new CustomerAddressService(db, logger);
  },
  createInMemoryAddressStore(): InMemoryCustomerAddressStore {
    return new InMemoryCustomerAddressStore();
  },
  createHttpAddressClient(
    serviceUrl: string,
    options?: HttpCustomerAddressClientOptions,
  ): HttpCustomerAddressClient {
    return new HttpCustomerAddressClient(serviceUrl, options);
  },
  createWishlistService(
    db: DatabaseConnection,
    logger: Logger,
    cartService: ICartService | CartService,
    outboxService?: OutboxService | undefined,
  ): WishlistService {
    return new WishlistService(db, logger, cartService, outboxService);
  },
  createBackInStockService(
    db: DatabaseConnection,
    logger: Logger,
    notificationService?: INotificationClient | undefined,
    outboxService?: OutboxService | undefined,
    frontendUrl?: string | undefined,
  ): BackInStockService {
    return new BackInStockService(db, logger, notificationService, outboxService, frontendUrl);
  },
  createBackInStockConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    service: BackInStockService,
  ): BackInStockEventConsumer {
    const outboxRepo = new OutboxRepository();
    const consumer = new BackInStockEventConsumer(db, outboxRepo, transport, logger, service);
    consumer.registerSubscriptions();
    return consumer;
  },
};
