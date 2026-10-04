import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { ListingService } from '../marketplace/index.js';
import type { CatalogService } from '../catalog/index.js';
import type { InventoryService } from '../inventory/index.js';
import { CartService } from './internal/cart-service.js';
import { CheckoutService } from './internal/checkout-service.js';
import type {
  CartDto,
  CartItemDto,
  AddCartItemInput,
  UpdateCartItemQuantityInput,
} from './internal/cart-service.js';
import type {
  CheckoutSessionDto,
  CheckoutItemDto,
  CreateCheckoutSessionInput,
} from './internal/checkout-service.js';
import type { CheckoutStatus } from './internal/checkout-repository.js';

export type {
  CartDto,
  CartItemDto,
  AddCartItemInput,
  UpdateCartItemQuantityInput,
  CheckoutSessionDto,
  CheckoutItemDto,
  CreateCheckoutSessionInput,
  CheckoutStatus,
};

export interface CartCheckoutModule {
  readonly contextName: 'cart-checkout';
  createCartService(
    db: DatabaseConnection,
    logger: Logger,
    listingService: ListingService,
  ): CartService;
  createCheckoutService(
    db: DatabaseConnection,
    logger: Logger,
    listingService: ListingService,
    catalogService: CatalogService,
    inventoryService: InventoryService,
  ): CheckoutService;
}

export const cartCheckoutModule: CartCheckoutModule = {
  contextName: 'cart-checkout',
  createCartService(
    db: DatabaseConnection,
    logger: Logger,
    listingService: ListingService,
  ): CartService {
    return new CartService(db, logger, listingService);
  },
  createCheckoutService(
    db: DatabaseConnection,
    logger: Logger,
    listingService: ListingService,
    catalogService: CatalogService,
    inventoryService: InventoryService,
  ): CheckoutService {
    return new CheckoutService(db, logger, listingService, catalogService, inventoryService);
  },
};

export { CartService, CheckoutService };
