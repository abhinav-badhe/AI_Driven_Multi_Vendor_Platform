import { z } from 'zod';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../errors/app-error.js';
import { RbacPolicy } from '../../identity/index.js';
import type { AiTool, ToolCallResult, ToolDefinition, ToolExecutionContext } from './ai-types.js';
import type { OrderService, IOrderService } from '../../orders/index.js';
import type { CatalogService, ICatalogReader } from '../../catalog/index.js';
import type { ListingService, IMarketplaceReader } from '../../marketplace/index.js';
import type { InventoryService, IInventoryReader } from '../../inventory/index.js';
import type { RecommendationService, RecommendationItemDto } from '../../recommendations/index.js';
import type { IMlSignalReader } from '../../analytics-ml/index.js';
import type { FulfillmentService, IFulfillmentService } from '../../fulfillment/index.js';
import type { PaymentService, IPaymentService } from '../../payment/index.js';
import type { SearchService } from '../../search/index.js';
import type {
  CartService,
  ICartService,
  CheckoutService,
  ICheckoutService,
} from '../../cart-checkout/index.js';

export interface ToolRegistryDependencies {
  orderService?: IOrderService | OrderService | undefined;
  catalogService?: ICatalogReader | CatalogService | undefined;
  listingService?: IMarketplaceReader | ListingService | undefined;
  inventoryService?: IInventoryReader | InventoryService | undefined;
  recommendationsService?: RecommendationService | undefined;
  mlSignalReader?: IMlSignalReader | undefined;
  fulfillmentService?: IFulfillmentService | FulfillmentService | undefined;
  paymentService?: IPaymentService | PaymentService | undefined;
  searchService?: SearchService | undefined;
  cartService?: ICartService | CartService | undefined;
  checkoutService?: ICheckoutService | CheckoutService | undefined;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AiTool<unknown, unknown>>();

  constructor(private readonly deps: ToolRegistryDependencies) {
    this.registerDefaultTools();
  }

  registerTool<TInput, TOutput>(tool: AiTool<TInput, TOutput>): void {
    this.tools.set(tool.name, tool as unknown as AiTool<unknown, unknown>);
  }

  getTool(name: string): AiTool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  getToolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      definitions.push({
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: {}, // schemas can be converted to JSON Schema if desired
        },
      });
    }
    return definitions;
  }

  /**
   * Pre-execution authorization check:
   * Verifies that the actor has the required permission and satisfies tenant/customer boundaries.
   * Throws ForbiddenError if unauthorized BEFORE executing the tool.
   */
  async authorizeAndExecute(
    context: ToolExecutionContext,
    toolName: string,
    rawArgs: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        toolCallId: '',
        name: toolName,
        output: null,
        error: `Tool '${toolName}' not found in registry`,
      };
    }

    // 1. Validate Input Schema
    const parseResult = tool.inputSchema.safeParse(rawArgs);
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid arguments for tool '${toolName}': ${parseResult.error.message}`,
      );
    }

    // 2. Pre-execution Authorization Check
    this.enforceAuthorization(context, tool, parseResult.data);

    // 3. Execute Tool
    try {
      const result = await tool.execute(context, parseResult.data);
      // 4. Validate Output Schema
      const validatedOutput = tool.outputSchema.parse(result);
      return {
        toolCallId: '',
        name: toolName,
        output: validatedOutput,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        err instanceof ForbiddenError ||
        err instanceof NotFoundError ||
        err instanceof ValidationError
      ) {
        throw err;
      }
      return {
        toolCallId: '',
        name: toolName,
        output: null,
        error: msg,
      };
    }
  }

  private enforceAuthorization(
    context: ToolExecutionContext,
    tool: AiTool<unknown, unknown>,
    input: unknown,
  ): void {
    const { actor, tenantId } = context;

    // Rule 1: Tenant boundary enforcement (no actor may access a foreign tenant)
    if (actor.tenantId !== tenantId) {
      throw new ForbiddenError(
        `Cross-tenant violation: Actor in tenant '${actor.tenantId}' cannot invoke tool '${tool.name}' on tenant '${tenantId}'`,
      );
    }

    // Rule 2: RBAC permission check
    RbacPolicy.requirePermission(actor, tool.requiredPermission);

    // Rule 3: Customer scoping for customer-specific tools
    const recordInput = (input && typeof input === 'object' ? input : {}) as Record<
      string,
      unknown
    >;
    if (tool.name === 'get_customer_orders' || tool.name === 'get_customer_profile') {
      const targetCustomerId = recordInput['customerId'] as string | undefined;
      if (
        actor.role === 'CUSTOMER' &&
        targetCustomerId &&
        targetCustomerId !== actor.userId &&
        targetCustomerId !== 'current-customer' &&
        targetCustomerId !== 'me' &&
        targetCustomerId !== 'self'
      ) {
        throw new ForbiddenError(
          `Cross-customer violation: Customer '${actor.userId}' cannot access records of customer '${targetCustomerId}'`,
        );
      }
      if (actor.role === 'MERCHANT') {
        throw new ForbiddenError(
          `Permission denied: Merchant cannot directly inspect private customer order collections`,
        );
      }
    }
  }

  private registerDefaultTools(): void {
    // --- 1. Customer Tools ---

    this.registerTool({
      name: 'get_customer_orders',
      description: 'Retrieves the list of recent orders placed by the authenticated customer',
      inputSchema: z.object({
        customerId: z.string(),
        limit: z.number().optional().default(5),
      }),
      outputSchema: z.array(
        z.object({
          orderId: z.string(),
          status: z.string(),
          totalAmount: z.number(),
          currency: z.string(),
          createdAt: z.string(),
        }),
      ),
      requiredPermission: 'order:read-own',
      owningContext: 'orders',
      auditClassification: 'READ_SENSITIVE',
      execute: async (ctx, input) => {
        if (!this.deps.orderService) return [];
        const orders = await this.deps.orderService.listCustomerOrders(ctx.actor, {
          limit: input.limit,
        });
        return orders.map((o) => ({
          orderId: o.id,
          status: o.status,
          totalAmount: o.totalAmount,
          currency: o.currency,
          createdAt: o.createdAt,
        }));
      },
    });

    this.registerTool({
      name: 'get_order_status',
      description: 'Fetches the current live status and item summary of a specific customer order',
      inputSchema: z.object({
        orderId: z.string(),
      }),
      outputSchema: z.object({
        orderId: z.string(),
        status: z.string(),
        totalAmount: z.number(),
        currency: z.string(),
        sellerOrderCount: z.number(),
        createdAt: z.string(),
      }),
      requiredPermission: 'order:read-own',
      owningContext: 'orders',
      auditClassification: 'READ_SENSITIVE',
      execute: async (ctx, input) => {
        if (!this.deps.orderService) {
          throw new NotFoundError(`Order '${input.orderId}' not found`);
        }
        const order = await this.deps.orderService.getCustomerOrder(ctx.actor, input.orderId);
        return {
          orderId: order.id,
          status: order.status,
          totalAmount: order.totalAmount,
          currency: order.currency,
          sellerOrderCount: order.sellerOrders?.length ?? 0,
          createdAt: order.createdAt,
        };
      },
    });

    // --- 2. Catalog & Marketplace Tools ---

    this.registerTool({
      name: 'get_product',
      description: 'Retrieves canonical product details and attributes by product ID',
      inputSchema: z.object({
        productId: z.string(),
      }),
      outputSchema: z.object({
        id: z.string(),
        title: z.string(),
        description: z.string(),
        brand: z.string().nullable().optional(),
        categoryPath: z.string().nullable().optional(),
      }),
      requiredPermission: 'catalog:read',
      owningContext: 'catalog',
      auditClassification: 'READ_PUBLIC',
      execute: async (_ctx, input) => {
        if (!this.deps.catalogService) {
          throw new NotFoundError(`Product '${input.productId}' not found`);
        }
        const prod = await this.deps.catalogService.getProductById(input.productId);
        return {
          id: prod.id,
          title: prod.title,
          description: prod.description ?? '',
          brand: prod.brand,
          categoryPath: null,
        };
      },
    });

    this.registerTool({
      name: 'get_current_listing',
      description: 'Fetches live listing pricing and merchant commercial terms',
      inputSchema: z.object({
        listingId: z.string(),
      }),
      outputSchema: z.object({
        listingId: z.string(),
        priceAmount: z.number(),
        currency: z.string(),
        compareAtPrice: z.number().nullable().optional(),
        status: z.string(),
      }),
      requiredPermission: 'listing:read-any',
      owningContext: 'marketplace',
      auditClassification: 'READ_PUBLIC',
      execute: async (ctx, input) => {
        if (!this.deps.listingService) {
          throw new NotFoundError(`Listing '${input.listingId}' not found`);
        }
        const listing = await this.deps.listingService.getListingById(ctx.actor, input.listingId);
        return {
          listingId: listing.id,
          priceAmount: listing.priceAmount,
          currency: listing.currency,
          compareAtPrice: listing.compareAtPrice,
          status: listing.status,
        };
      },
    });

    // --- 3. Inventory Tools ---

    this.registerTool({
      name: 'check_inventory',
      description: 'Checks live real-time available stock quantity for a product listing',
      inputSchema: z.object({
        listingId: z.string(),
      }),
      outputSchema: z.object({
        listingId: z.string(),
        skuId: z.string(),
        isAvailable: z.boolean(),
        availableQuantity: z.number(),
      }),
      requiredPermission: 'listing:read-any',
      owningContext: 'inventory',
      auditClassification: 'READ_PUBLIC',
      execute: async (_ctx, input) => {
        if (!this.deps.inventoryService) {
          return {
            listingId: input.listingId,
            skuId: 'unknown',
            isAvailable: false,
            availableQuantity: 0,
          };
        }
        return this.deps.inventoryService.getAvailabilityByListingId(input.listingId);
      },
    });

    // --- 4. Recommendations Tools ---

    this.registerTool({
      name: 'get_recommendations',
      description: 'Retrieves personalized product recommendations based on collaborative signals',
      inputSchema: z.object({
        customerId: z.string().optional(),
        productId: z.string().optional(),
        limit: z.number().optional().default(5),
      }),
      outputSchema: z.array(
        z.object({
          productId: z.string(),
          score: z.number(),
          reason: z.string(),
        }),
      ),
      requiredPermission: 'recommendations:read',
      owningContext: 'recommendations',
      auditClassification: 'READ_PUBLIC',
      execute: async (ctx, input) => {
        if (!this.deps.recommendationsService) return [];
        let res;
        if (input.productId) {
          res = await this.deps.recommendationsService.getSimilarProducts(
            ctx.actor,
            input.productId,
            {
              limit: input.limit,
            },
          );
        } else if (ctx.actor.role === 'CUSTOMER') {
          res = await this.deps.recommendationsService.getPersonalizedRecommendations(ctx.actor, {
            limit: input.limit,
          });
        } else {
          res = await this.deps.recommendationsService.getTrendingRecommendations(ctx.actor, {
            limit: input.limit,
          });
        }
        return res.items.map((it: RecommendationItemDto) => ({
          productId: it.productId,
          title: it.title,
          score: it.score,
          reason: it.explanation,
        }));
      },
    });

    // --- 5. Predictive ML Tools ---

    this.registerTool({
      name: 'get_demand_forecast',
      description: 'Reads derived demand forecasting prediction for a product',
      inputSchema: z.object({
        productId: z.string(),
      }),
      outputSchema: z.object({
        productId: z.string(),
        forecastUnits: z.number().nullable(),
      }),
      requiredPermission: 'ml:read-own',
      owningContext: 'analytics-ml',
      auditClassification: 'READ_PUBLIC',
      execute: async (ctx, input) => {
        if (!this.deps.mlSignalReader) {
          return { productId: input.productId, forecastUnits: null };
        }
        const forecast = await this.deps.mlSignalReader.getDemandForecast(
          ctx.tenantId,
          input.productId,
        );
        const units =
          typeof forecast === 'object' && forecast !== null && 'forecastDemandUnits' in forecast
            ? Number((forecast as Record<string, unknown>).forecastDemandUnits)
            : typeof forecast === 'number'
              ? forecast
              : null;
        return {
          productId: input.productId,
          forecastUnits: units,
        };
      },
    });

    this.registerTool({
      name: 'get_stockout_risk',
      description: 'Reads derived stockout probability for an inventory SKU',
      inputSchema: z.object({
        sku: z.string(),
      }),
      outputSchema: z.object({
        sku: z.string(),
        stockoutRiskProbability: z.number().nullable(),
      }),
      requiredPermission: 'ml:read-own',
      owningContext: 'analytics-ml',
      auditClassification: 'READ_PUBLIC',
      execute: async (ctx, input) => {
        if (!this.deps.mlSignalReader) {
          return { sku: input.sku, stockoutRiskProbability: null };
        }
        const risk = await this.deps.mlSignalReader.getStockoutRisk(ctx.tenantId, input.sku);
        return {
          sku: input.sku,
          stockoutRiskProbability: risk,
        };
      },
    });

    // --- 6. Fulfillment Tools ---

    this.registerTool({
      name: 'get_shipment_status',
      description: 'Checks shipping carrier tracking and dispatch status for an order shipment',
      inputSchema: z.object({
        shipmentId: z.string(),
      }),
      outputSchema: z.object({
        shipmentId: z.string(),
        status: z.string(),
        carrier: z.string().nullable().optional(),
        trackingNumber: z.string().nullable().optional(),
        trackingUrl: z.string().nullable().optional(),
      }),
      requiredPermission: 'fulfillment:read-own',
      owningContext: 'fulfillment',
      auditClassification: 'READ_SENSITIVE',
      execute: async (ctx, input) => {
        if (!this.deps.fulfillmentService) {
          throw new NotFoundError(`Shipment '${input.shipmentId}' not found`);
        }
        const shipment = await this.deps.fulfillmentService.getShipment(
          ctx.actor,
          input.shipmentId,
        );
        return {
          shipmentId: shipment.id,
          status: shipment.status,
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          trackingUrl: shipment.trackingUrl,
        };
      },
    });

    // --- 7. Payment Tools ---

    this.registerTool({
      name: 'get_payment_status',
      description: 'Checks payment transaction status without exposing card credentials or secrets',
      inputSchema: z.object({
        paymentIntentId: z.string(),
      }),
      outputSchema: z.object({
        paymentIntentId: z.string(),
        status: z.string(),
        amount: z.number(),
        currency: z.string(),
        createdAt: z.string(),
      }),
      requiredPermission: 'payment:read-own',
      owningContext: 'payment',
      auditClassification: 'READ_SENSITIVE',
      execute: async (ctx, input) => {
        if (!this.deps.paymentService) {
          throw new NotFoundError(`Payment intent '${input.paymentIntentId}' not found`);
        }
        const intent = await this.deps.paymentService.getPaymentIntent(
          ctx.actor,
          input.paymentIntentId,
        );
        // Strips clientSecret, token credentials, and raw metadata
        return {
          paymentIntentId: intent.id,
          status: intent.status,
          amount: intent.amount,
          currency: intent.currency,
          createdAt: intent.createdAt,
        };
      },
    });

    // --- 8. Search & Category Tools ---

    this.registerTool({
      name: 'search_products',
      description: 'Searches products and canonical catalog listings by keyword or category',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().optional().default(5),
      }),
      outputSchema: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          brand: z.string().nullable().optional(),
          minPrice: z.number().nullable().optional(),
          maxPrice: z.number().nullable().optional(),
          offerCount: z.number().optional(),
        }),
      ),
      requiredPermission: 'catalog:read',
      owningContext: 'search',
      auditClassification: 'READ_PUBLIC',
      execute: async (ctx, input) => {
        if (!this.deps.searchService) return [];
        const results = await this.deps.searchService.search(ctx.actor, {
          q: input.query,
          pageSize: input.limit,
        });
        return results.items.map((it) => ({
          id: it.productId,
          title: it.title,
          brand: it.brand ?? null,
          minPrice: it.minPrice ?? null,
          maxPrice: it.maxPrice ?? null,
          offerCount: it.offers?.length ?? it.totalOffersCount ?? 0,
        }));
      },
    });

    this.registerTool({
      name: 'browse_categories',
      description:
        'Lists all canonical product categories and departments available on the platform',
      inputSchema: z.object({
        parentId: z.string().nullable().optional(),
      }),
      outputSchema: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          parentId: z.string().nullable().optional(),
        }),
      ),
      requiredPermission: 'catalog:read',
      owningContext: 'catalog',
      auditClassification: 'READ_PUBLIC',
      execute: async () => {
        if (!this.deps.catalogService) return [];
        const categories = await this.deps.catalogService.listCategories();
        return categories.map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          parentId: c.parentId ?? null,
        }));
      },
    });

    this.registerTool({
      name: 'get_product_offers',
      description:
        'Retrieves all available merchant listing offers, prices, and stock for a product',
      inputSchema: z.object({
        productId: z.string(),
      }),
      outputSchema: z.array(
        z.object({
          listingId: z.string(),
          merchantTenantId: z.string(),
          priceAmount: z.number(),
          currency: z.string(),
          compareAtPrice: z.number().nullable().optional(),
          status: z.string(),
        }),
      ),
      requiredPermission: 'listing:read-any',
      owningContext: 'marketplace',
      auditClassification: 'READ_PUBLIC',
      execute: async (ctx, input) => {
        if (!this.deps.listingService || !this.deps.catalogService) return [];
        // First retrieve SKUs for the product
        try {
          const skus = await this.deps.catalogService.listSkusByProduct(input.productId, ctx.actor);
          const allOffers: Array<{
            listingId: string;
            merchantTenantId: string;
            priceAmount: number;
            currency: string;
            compareAtPrice: number | null | undefined;
            status: string;
          }> = [];

          for (const sku of skus) {
            const listings = await this.deps.listingService.getActiveListingsForSku(sku.id);
            for (const l of listings) {
              allOffers.push({
                listingId: l.id,
                merchantTenantId: l.tenantId,
                priceAmount: l.priceAmount,
                currency: l.currency,
                compareAtPrice: l.compareAtPrice,
                status: l.status,
              });
            }
          }
          return allOffers;
        } catch {
          return [];
        }
      },
    });

    // --- 9. Cart & Checkout Commerce Tools ---

    this.registerTool({
      name: 'add_to_cart',
      description: 'Adds a merchant listing product to the customer shopping cart',
      inputSchema: z.object({
        listingId: z.string(),
        quantity: z.number().int().positive().default(1),
      }),
      outputSchema: z.object({
        cartId: z.string(),
        itemCount: z.number(),
        subtotalAmount: z.number(),
        currency: z.string().nullable(),
        addedListingId: z.string(),
        quantityAdded: z.number(),
      }),
      requiredPermission: 'cart:write-own',
      owningContext: 'cart-checkout',
      auditClassification: 'MUTATE',
      execute: async (ctx, input) => {
        if (!this.deps.cartService) {
          throw new NotFoundError('Cart service unavailable');
        }
        const qty = input.quantity ?? 1;
        const cart = await this.deps.cartService.addItem(ctx.actor, {
          listingId: input.listingId,
          quantity: qty,
        });
        return {
          cartId: cart.id,
          itemCount: cart.itemCount,
          subtotalAmount: cart.subtotalAmount,
          currency: cart.currency,
          addedListingId: input.listingId,
          quantityAdded: qty,
        };
      },
    });

    this.registerTool({
      name: 'get_cart',
      description:
        'Retrieves current items, quantities, and subtotal in the customer shopping cart',
      inputSchema: z.object({}),
      outputSchema: z.object({
        cartId: z.string(),
        itemCount: z.number(),
        subtotalAmount: z.number(),
        currency: z.string().nullable(),
        items: z.array(
          z.object({
            listingId: z.string(),
            productTitle: z.string().nullable().optional(),
            quantity: z.number(),
            unitPriceAmount: z.number(),
            lineTotalAmount: z.number(),
          }),
        ),
      }),
      requiredPermission: 'cart:read-own',
      owningContext: 'cart-checkout',
      auditClassification: 'READ_SENSITIVE',
      execute: async (ctx) => {
        if (!this.deps.cartService) {
          return { cartId: '', itemCount: 0, subtotalAmount: 0, currency: 'USD', items: [] };
        }
        const cart = await this.deps.cartService.getOrCreateCart(ctx.actor);
        return {
          cartId: cart.id,
          itemCount: cart.itemCount,
          subtotalAmount: cart.subtotalAmount,
          currency: cart.currency,
          items: cart.items.map((it) => ({
            listingId: it.listingId,
            productTitle: it.productTitle ?? null,
            quantity: it.quantity,
            unitPriceAmount: it.unitPriceAmount,
            lineTotalAmount: it.lineTotalAmount,
          })),
        };
      },
    });

    this.registerTool({
      name: 'start_checkout',
      description: 'Initiates a checkout session from the active cart and reserves inventory',
      inputSchema: z.object({
        idempotencyKey: z.string().optional(),
      }),
      outputSchema: z.object({
        checkoutSessionId: z.string(),
        status: z.string(),
        totalAmount: z.number(),
        currency: z.string(),
        itemCount: z.number(),
        expiresAt: z.string(),
      }),
      requiredPermission: 'checkout:create-own',
      owningContext: 'cart-checkout',
      auditClassification: 'MUTATE',
      execute: async (ctx, input) => {
        if (!this.deps.checkoutService) {
          throw new NotFoundError('Checkout service unavailable');
        }
        const idempotencyKey = input.idempotencyKey ?? `wa-chk-${ctx.correlationId}`;
        let session = await this.deps.checkoutService.createCheckoutSession(ctx.actor, {
          idempotencyKey,
        });
        if (session.status === 'OPEN') {
          session = await this.deps.checkoutService.reserveCheckoutInventory(ctx.actor, session.id);
        }
        return {
          checkoutSessionId: session.id,
          status: session.status,
          totalAmount: session.totalAmount,
          currency: session.currency,
          itemCount: session.items.length,
          expiresAt: session.expiresAt,
        };
      },
    });

    this.registerTool({
      name: 'complete_payment',
      description:
        'Processes payment and finalizes the customer order from a reserved checkout session',
      inputSchema: z.object({
        checkoutSessionId: z.string(),
        paymentMethod: z.string().optional().default('pm_card_visa'),
      }),
      outputSchema: z.object({
        orderId: z.string(),
        status: z.string(),
        totalAmount: z.number(),
        currency: z.string(),
        sellerOrderCount: z.number(),
        createdAt: z.string(),
      }),
      requiredPermission: 'order:create-own',
      owningContext: 'orders',
      auditClassification: 'MUTATE',
      execute: async (ctx, input) => {
        if (!this.deps.checkoutService || !this.deps.paymentService || !this.deps.orderService) {
          throw new NotFoundError('Order or Payment service unavailable');
        }
        const session = await this.deps.checkoutService.getCheckoutSession(
          ctx.actor,
          input.checkoutSessionId,
        );

        const intent = await this.deps.paymentService.createPaymentIntent(ctx.actor, {
          checkoutSessionId: session.id,
          idempotencyKey: `wa-pi-${session.id}`,
        });

        const attempt = await this.deps.paymentService.createPaymentAttempt(ctx.actor, intent.id, {
          paymentMethod: input.paymentMethod,
          idempotencyKey: `wa-att-${session.id}`,
        });

        if (attempt.status !== 'SUCCEEDED') {
          throw new Error(`Payment declined: ${attempt.failureMessage ?? 'Card was declined'}`);
        }

        const order = await this.deps.orderService.createOrderFromCheckout(ctx.actor, {
          checkoutSessionId: session.id,
          paymentIntentId: intent.id,
          idempotencyKey: `wa-ord-${session.id}`,
        });

        return {
          orderId: order.id,
          status: order.status,
          totalAmount: order.totalAmount,
          currency: order.currency,
          sellerOrderCount: order.sellerOrders?.length ?? 1,
          createdAt: order.createdAt,
        };
      },
    });

    this.registerTool({
      name: 'get_return_policy',
      description: 'Retrieves return and refund eligibility rules, conditions, and instructions',
      inputSchema: z.object({
        category: z.string().optional(),
      }),
      outputSchema: z.object({
        windowDays: z.number(),
        conditions: z.array(z.string()),
        instructions: z.string(),
      }),
      requiredPermission: 'catalog:read',
      owningContext: 'fulfillment',
      auditClassification: 'READ_PUBLIC',
      execute: async () => {
        return {
          windowDays: 30,
          conditions: [
            'Item must be unused and in original packaging',
            'Proof of purchase or Order ID is required',
            'Return shipping label will be provided upon approval',
          ],
          instructions:
            'To initiate a return, navigate to Orders in your account or message our support with your Order ID. Once approved by the merchant, refunds are credited to the original payment method.',
        };
      },
    });
  }
}
