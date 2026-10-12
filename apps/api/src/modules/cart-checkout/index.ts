import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { ListingService, IMarketplaceReader } from '../marketplace/index.js';
import type { CatalogService, ICatalogReader } from '../catalog/index.js';
import type { InventoryService, IInventoryService } from '../inventory/index.js';
import type { CustomerAddressService, ICustomerAddressReader } from '../customer/index.js';
import { CartService } from './internal/cart-service.js';
import { CheckoutService } from './internal/checkout-service.js';
import {
  InMemoryCartStore,
  InMemoryCheckoutStore,
} from './internal/in-memory-cart-checkout-store.js';
import {
  HttpCartClient,
  HttpCheckoutClient,
  type HttpCartClientOptions,
  type HttpCheckoutClientOptions,
} from './internal/http-cart-checkout-client.js';
import type {
  ICartReader,
  ICartService,
  ICheckoutReader,
  ICheckoutService,
  CartDto,
  CartItemDto,
  AddCartItemInput,
  UpdateCartItemQuantityInput,
  CheckoutSessionDto,
  CheckoutItemDto,
  CreateCheckoutSessionInput,
  CheckoutStatus,
  AddressSnapshot,
} from './internal/cart-checkout-models.js';

export type {
  ICartReader,
  ICartService,
  ICheckoutReader,
  ICheckoutService,
  CartDto,
  CartItemDto,
  AddCartItemInput,
  UpdateCartItemQuantityInput,
  CheckoutSessionDto,
  CheckoutItemDto,
  CreateCheckoutSessionInput,
  CheckoutStatus,
  AddressSnapshot,
  HttpCartClientOptions,
  HttpCheckoutClientOptions,
};

export {
  CartService,
  CheckoutService,
  InMemoryCartStore,
  InMemoryCheckoutStore,
  HttpCartClient,
  HttpCheckoutClient,
};

export interface CartCheckoutModule {
  readonly contextName: 'cart-checkout';
  createCartService(
    db: DatabaseConnection,
    logger: Logger,
    listingService: IMarketplaceReader | ListingService,
  ): CartService;
  createCheckoutService(
    db: DatabaseConnection,
    logger: Logger,
    listingService: IMarketplaceReader | ListingService,
    catalogService: ICatalogReader | CatalogService,
    inventoryService: IInventoryService | InventoryService,
    addressService?: ICustomerAddressReader | CustomerAddressService,
  ): CheckoutService;
  createInMemoryCartStore(): InMemoryCartStore;
  createInMemoryCheckoutStore(cartStore?: InMemoryCartStore): InMemoryCheckoutStore;
  createHttpCartClient(serviceUrl: string, options?: HttpCartClientOptions): HttpCartClient;
  createHttpCheckoutClient(
    serviceUrl: string,
    options?: HttpCheckoutClientOptions,
  ): HttpCheckoutClient;
}

export const cartCheckoutModule: CartCheckoutModule = {
  contextName: 'cart-checkout',
  createCartService(
    db: DatabaseConnection,
    logger: Logger,
    listingService: IMarketplaceReader | ListingService,
  ): CartService {
    return new CartService(db, logger, listingService);
  },
  createCheckoutService(
    db: DatabaseConnection,
    logger: Logger,
    listingService: IMarketplaceReader | ListingService,
    catalogService: ICatalogReader | CatalogService,
    inventoryService: IInventoryService | InventoryService,
    addressService?: ICustomerAddressReader | CustomerAddressService,
  ): CheckoutService {
    return new CheckoutService(
      db,
      logger,
      listingService,
      catalogService,
      inventoryService,
      addressService,
    );
  },
  createInMemoryCartStore(): InMemoryCartStore {
    return new InMemoryCartStore();
  },
  createInMemoryCheckoutStore(cartStore?: InMemoryCartStore): InMemoryCheckoutStore {
    return new InMemoryCheckoutStore(cartStore);
  },
  createHttpCartClient(serviceUrl: string, options?: HttpCartClientOptions): HttpCartClient {
    return new HttpCartClient(serviceUrl, options);
  },
  createHttpCheckoutClient(
    serviceUrl: string,
    options?: HttpCheckoutClientOptions,
  ): HttpCheckoutClient {
    return new HttpCheckoutClient(serviceUrl, options);
  },
};
