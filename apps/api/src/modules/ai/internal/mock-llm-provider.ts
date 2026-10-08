import type {
  ChatMessage,
  ILLMProvider,
  LLMOptions,
  LLMResponse,
  ToolDefinition,
} from './ai-types.js';

export class MockLLMProvider implements ILLMProvider {
  readonly modelId = 'mock-commerce-llm-v1';

  async generateChat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    _options?: LLMOptions,
  ): Promise<LLMResponse> {
    const lastMessage = messages[messages.length - 1];
    const userMessage = messages
      .filter((m) => m.role === 'USER')
      .map((m) => m.content)
      .pop() ?? '';

    const lower = userMessage.toLowerCase();

    // 1. Prompt Injection Defense Engine
    // Detect instruction overrides, jailbreaks, and privilege escalation attempts
    const isInjectionAttempt =
      /ignore (?:all )?(?:previous|prior) instructions/i.test(userMessage) ||
      /disregard (?:all )?prior/i.test(userMessage) ||
      /system override/i.test(userMessage) ||
      /bypass security/i.test(userMessage) ||
      /grant admin/i.test(userMessage) ||
      /transfer money/i.test(userMessage) ||
      /you are now an administrator/i.test(userMessage) ||
      /reveal (?:the )?system prompt/i.test(userMessage);

    if (isInjectionAttempt) {
      return {
        content:
          'I refuse to fulfill this request. System security policies strictly prohibit overriding instructions, bypassing authentication, or elevating privileges.',
        modelId: this.modelId,
        tokenUsage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
      };
    }

    // 2. Synthesize Tool Output into Natural Conversational Commerce Responses
    if (lastMessage?.role === 'TOOL') {
      let parsedOutput: unknown = lastMessage.content;
      try {
        parsedOutput = JSON.parse(lastMessage.content);
      } catch {
        // use raw
      }

      const out = parsedOutput as Record<string, unknown> | Array<Record<string, unknown>>;

      // Format Product Search Results
      if (Array.isArray(out) && out.length > 0 && 'title' in (out[0] ?? {}) && 'id' in (out[0] ?? {})) {
        const productList = (out as Array<Record<string, unknown>>)
          .map((p, idx) => `${idx + 1}. ${p.title} (${p.id})${p.minPrice != null ? ` - from $${p.minPrice}` : ''}`)
          .join('\n');
        return {
          content: `Here are the matching products I found:\n${productList}\n\nWould you like to see available merchant offers or add one to your cart?`,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 60, completionTokens: 40, totalTokens: 100 },
        };
      }

      // Format Categories List
      if (Array.isArray(out) && out.length > 0 && 'slug' in (out[0] ?? {}) && 'name' in (out[0] ?? {})) {
        const catList = (out as Array<Record<string, unknown>>)
          .map((c) => `• ${c.name} (${c.slug})`)
          .join('\n');
        return {
          content: `Here are our store categories:\n${catList}\n\nWhat category would you like to browse?`,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 50, completionTokens: 30, totalTokens: 80 },
        };
      }

      // Format Merchant Offers
      if (Array.isArray(out) && out.length > 0 && 'listingId' in (out[0] ?? {}) && 'priceAmount' in (out[0] ?? {})) {
        const offersList = (out as Array<Record<string, unknown>>)
          .map((o) => `• Offer ${o.listingId}: $${o.priceAmount} (${o.currency}) by seller ${o.merchantTenantId}`)
          .join('\n');
        return {
          content: `Here are the available merchant offers:\n${offersList}\n\nLet me know which listing you'd like to add to your cart!`,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 60, completionTokens: 35, totalTokens: 95 },
        };
      }

      // Format Stock / Inventory Availability
      if (typeof out === 'object' && out !== null && 'availableQuantity' in out && 'isAvailable' in out) {
        return {
          content: out.isAvailable
            ? `Listing ${out.listingId} is in stock with ${out.availableQuantity} unit(s) available!`
            : `Listing ${out.listingId} is currently out of stock.`,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
        };
      }

      // Format Add to Cart
      if (typeof out === 'object' && out !== null && 'addedListingId' in out && 'quantityAdded' in out) {
        return {
          content: `Added ${out.quantityAdded} item(s) to your cart! Your cart now has ${out.itemCount} item(s) with a subtotal of $${out.subtotalAmount}. Say "checkout" whenever you are ready!`,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
        };
      }

      // Format View Cart
      if (typeof out === 'object' && out !== null && 'items' in out && Array.isArray(out.items)) {
        if (out.items.length === 0) {
          return {
            content: 'Your cart is currently empty. Tell me what product you are looking for to get started!',
            modelId: this.modelId,
            tokenUsage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 },
          };
        }
        const itemsSummary = (out.items as Array<Record<string, unknown>>)
          .map((it) => `• ${it.productTitle ?? it.listingId}: ${it.quantity}x @ $${it.unitPriceAmount} = $${it.lineTotalAmount}`)
          .join('\n');
        return {
          content: `Here is your current cart:\n${itemsSummary}\n\nTotal: $${out.subtotalAmount} (${out.itemCount} items). Say "checkout" to place your order!`,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 60, completionTokens: 35, totalTokens: 95 },
        };
      }

      // Format Checkout Session
      if (typeof out === 'object' && out !== null && 'checkoutSessionId' in out && 'status' in out && !('orderId' in out)) {
        return {
          content: `Checkout session started! Session ID: ${out.checkoutSessionId}. Status: ${out.status}. Reserved total: $${out.totalAmount} ${out.currency}. Say "pay" or "confirm order" to complete your purchase!`,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 60, completionTokens: 30, totalTokens: 90 },
        };
      }

      // Format Payment / Order Confirmation
      if (typeof out === 'object' && out !== null && 'orderId' in out && 'status' in out) {
        return {
          content: `🎉 Order confirmed! Your order ID is ${out.orderId}. Status: ${out.status}. Total amount paid: $${out.totalAmount} ${out.currency}. We have routed the items to the respective merchants for fulfillment. Thank you for your purchase!`,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 70, completionTokens: 40, totalTokens: 110 },
        };
      }

      // Format Order Status
      if (typeof out === 'object' && out !== null && 'orderId' in out && 'sellerOrderCount' in out) {
        return {
          content: `Order ${out.orderId} is currently ${out.status}. Total amount: $${out.totalAmount} ${out.currency} across ${out.sellerOrderCount} merchant package(s).`,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
        };
      }

      // Format Shipment Status
      if (typeof out === 'object' && out !== null && 'shipmentId' in out && 'status' in out) {
        return {
          content: `Shipment ${out.shipmentId} is ${out.status}.${out.carrier ? ` Carrier: ${out.carrier}.` : ''}${out.trackingNumber ? ` Tracking #: ${out.trackingNumber}.` : ''}`,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
        };
      }

      // Format Return Policy
      if (typeof out === 'object' && out !== null && 'windowDays' in out && 'conditions' in out) {
        const condList = Array.isArray(out.conditions) ? out.conditions.map((c) => `• ${c}`).join('\n') : '';
        return {
          content: `Our return policy allows returns within ${out.windowDays} days of delivery.\n\nConditions:\n${condList}\n\n${out.instructions}`,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 60, completionTokens: 35, totalTokens: 95 },
        };
      }

      // Default tool output response
      return {
        content: `Based on your request, here are the details: ${JSON.stringify(parsedOutput)}. Is there anything else I can help you with?`,
        modelId: this.modelId,
        tokenUsage: { promptTokens: 60, completionTokens: 25, totalTokens: 85 },
      };
    }

    // 3. RAG Knowledge Grounding Precedence for Policy & Documentation Queries
    const systemWithContext = messages.find(
      (m) => m.role === 'SYSTEM' && m.content.includes('RELEVANT KNOWLEDGE CONTEXT'),
    );

    if (systemWithContext) {
      if (
        lower.includes('according to') ||
        lower.includes('manual') ||
        lower.includes('policy') ||
        lower.includes('faq') ||
        lower.includes('warranty') ||
        lower.includes('terms')
      ) {
        return {
          content: `According to our official documentation:\n${systemWithContext.content.replace('RELEVANT KNOWLEDGE CONTEXT:', '').trim()}`,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
        };
      }
    }

    // 4. Tool Routing Rules (Authoritative Tool Calling over Domain Services)

    // A. Product Search Queries
    if (
      lower.includes('search') ||
      lower.includes('find') ||
      lower.includes('looking for') ||
      lower.includes('browse products')
    ) {
      const tool = tools?.find((t) => t.name === 'search_products');
      if (tool) {
        const queryMatch =
          userMessage.match(/(?:search|find|looking for|browse)\s+(?:for\s+)?([a-zA-Z0-9\s_-]+)/i) ??
          userMessage.match(/([a-zA-Z0-9_-]+)/i);
        const query = queryMatch ? queryMatch[1]?.trim() ?? userMessage.trim() : userMessage.trim();
        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-search-1',
              name: 'search_products',
              arguments: { query: query.replace(/^search\s+/i, '').trim() || 'all', limit: 5 },
            },
          ],
          modelId: this.modelId,
          tokenUsage: { promptTokens: 35, completionTokens: 15, totalTokens: 50 },
        };
      }
    }

    // B. Browse Categories
    if (
      lower.includes('categories') ||
      lower.includes('browse category') ||
      lower.includes('show categories') ||
      lower.includes('list categories')
    ) {
      const tool = tools?.find((t) => t.name === 'browse_categories');
      if (tool) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-cat-1',
              name: 'browse_categories',
              arguments: {},
            },
          ],
          modelId: this.modelId,
          tokenUsage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
        };
      }
    }

    // C. View Available Merchant Offers & Prices for Product
    if (
      lower.includes('offers') ||
      lower.includes('who sells') ||
      lower.includes('compare prices') ||
      lower.includes('sellers for')
    ) {
      const tool = tools?.find((t) => t.name === 'get_product_offers');
      if (tool) {
        const prodMatch = userMessage.match(/prod-[a-zA-Z0-9-]+/i);
        const productId = prodMatch ? prodMatch[0] : 'prod-sample';
        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-offers-1',
              name: 'get_product_offers',
              arguments: { productId },
            },
          ],
          modelId: this.modelId,
          tokenUsage: { promptTokens: 35, completionTokens: 15, totalTokens: 50 },
        };
      }
    }

    // D. View Canonical Product Details
    if (lower.includes('details') || lower.includes('product info') || (lower.includes('view product') && userMessage.includes('prod-'))) {
      const tool = tools?.find((t) => t.name === 'get_product');
      if (tool) {
        const prodMatch = userMessage.match(/prod-[a-zA-Z0-9-]+/i);
        const productId = prodMatch ? prodMatch[0] : 'prod-sample';
        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-prod-1',
              name: 'get_product',
              arguments: { productId },
            },
          ],
          modelId: this.modelId,
          tokenUsage: { promptTokens: 35, completionTokens: 15, totalTokens: 50 },
        };
      }
    }

    // E. Real-Time Stock & Inventory Queries
    if (lower.includes('in stock') || lower.includes('stock quantity') || lower.includes('do you have') || lower.includes('stock of')) {
      const tool = tools?.find((t) => t.name === 'check_inventory');
      if (tool) {
        const match = userMessage.match(/list-[a-zA-Z0-9-]+/i) ?? userMessage.match(/sku-[a-zA-Z0-9-]+/i);
        const listingId = match ? match[0] : 'list-default';
        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-inv-1',
              name: 'check_inventory',
              arguments: { listingId },
            },
          ],
          modelId: this.modelId,
          tokenUsage: { promptTokens: 35, completionTokens: 15, totalTokens: 50 },
        };
      }
    }

    // F. Add Product to Cart
    if (lower.includes('add to cart') || lower.includes('add') && lower.includes('cart') || lower.includes('buy listing') || lower.includes('add listing')) {
      const tool = tools?.find((t) => t.name === 'add_to_cart');
      if (tool) {
        const match = userMessage.match(/list-[a-zA-Z0-9-]+/i);
        const listingId = match ? match[0] : 'list-sample';
        const qtyMatch = userMessage.match(/(?:quantity|qty|count)\s*[:=]?\s*(\d+)/i) ?? userMessage.match(/(\d+)\s*(?:unit|item|pack)/i);
        const quantity = qtyMatch ? Number(qtyMatch[1]) : 1;

        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-cart-add-1',
              name: 'add_to_cart',
              arguments: { listingId, quantity },
            },
          ],
          modelId: this.modelId,
          tokenUsage: { promptTokens: 35, completionTokens: 15, totalTokens: 50 },
        };
      }
    }

    // G. View Shopping Cart
    if (lower.includes('view cart') || lower.includes('show cart') || lower.includes('my cart') || lower.includes('what is in my cart')) {
      const tool = tools?.find((t) => t.name === 'get_cart');
      if (tool) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-cart-get-1',
              name: 'get_cart',
              arguments: {},
            },
          ],
          modelId: this.modelId,
          tokenUsage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
        };
      }
    }

    // H. Start Checkout & Reserve Inventory
    if (lower.includes('start checkout') || lower.includes('proceed to checkout') || lower === 'checkout') {
      const tool = tools?.find((t) => t.name === 'start_checkout');
      if (tool) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-chk-start-1',
              name: 'start_checkout',
              arguments: {},
            },
          ],
          modelId: this.modelId,
          tokenUsage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
        };
      }
    }

    // I. Complete Payment & Finalize Order
    if (
      lower.includes('complete payment') ||
      lower.includes('confirm order') ||
      lower.includes('pay checkout') ||
      lower.startsWith('pay') ||
      lower.includes('pay with')
    ) {
      const tool = tools?.find((t) => t.name === 'complete_payment');
      if (tool) {
        // Look for checkout session ID in message or conversation history
        const chkMatch =
          userMessage.match(/chk-[a-zA-Z0-9-]+/i) ??
          userMessage.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) ??
          userMessage.match(/pay\s+([a-zA-Z0-9-]+)/i) ??
          messages.map((m) => m.content).join(' ').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) ??
          messages.map((m) => m.content).join(' ').match(/chk-[a-zA-Z0-9-]+/i);
        const checkoutSessionId = chkMatch ? (chkMatch[1] ?? chkMatch[0]) : 'chk-active';

        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-pay-1',
              name: 'complete_payment',
              arguments: { checkoutSessionId, paymentMethod: 'pm_card_visa' },
            },
          ],
          modelId: this.modelId,
          tokenUsage: { promptTokens: 40, completionTokens: 15, totalTokens: 55 },
        };
      }
    }

    // J. Check Order Status
    if (lower.includes('where is my order') || lower.includes('order status') || lower.includes('ord-') || lower.match(/order\s+[0-9a-f-]+/i)) {
      const tool = tools?.find((t) => t.name === 'get_order_status');
      if (tool) {
        const orderMatch =
          userMessage.match(/ord-[a-zA-Z0-9-]+/i) ??
          userMessage.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) ??
          userMessage.match(/order\s+([a-zA-Z0-9-]+)/i);
        const orderId = orderMatch ? (orderMatch[1] ?? orderMatch[0]) : 'ord-sample-123';
        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-order-status-1',
              name: 'get_order_status',
              arguments: { orderId },
            },
          ],
          modelId: this.modelId,
          tokenUsage: { promptTokens: 35, completionTokens: 15, totalTokens: 50 },
        };
      }
    }

    // K. Customer Orders List
    if (lower.includes('my orders') || lower.includes('recent orders') || lower.includes('show my orders')) {
      const tool = tools?.find((t) => t.name === 'get_customer_orders');
      if (tool) {
        const match = lower.match(/customer\s+([a-zA-Z0-9-]+)/);
        const customerId = match ? match[1]! : 'current-customer';
        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-orders-1',
              name: 'get_customer_orders',
              arguments: { customerId, limit: 5 },
            },
          ],
          modelId: this.modelId,
          tokenUsage: { promptTokens: 40, completionTokens: 15, totalTokens: 55 },
        };
      }
    }

    // L. Track Shipment
    if (lower.includes('track shipment') || lower.includes('track ship-') || lower.includes('tracking') || lower.includes('ship-')) {
      const tool = tools?.find((t) => t.name === 'get_shipment_status');
      if (tool) {
        const match = userMessage.match(/ship-[a-zA-Z0-9-]+/i);
        const shipmentId = match ? match[0] : 'ship-default-1';
        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-ship-1',
              name: 'get_shipment_status',
              arguments: { shipmentId },
            },
          ],
          modelId: this.modelId,
          tokenUsage: { promptTokens: 35, completionTokens: 15, totalTokens: 50 },
        };
      }
    }

    // M. Returns and Refund Policy
    if (lower.includes('return policy') || lower.includes('refund policy') || lower.includes('how to return') || lower.includes('can i return')) {
      const tool = tools?.find((t) => t.name === 'get_return_policy');
      if (tool) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-ret-1',
              name: 'get_return_policy',
              arguments: {},
            },
          ],
          modelId: this.modelId,
          tokenUsage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
        };
      }
    }

    // N. Recommendations
    if (lower.includes('recommend') || lower.includes('what should i buy') || lower.includes('similar')) {
      const tool = tools?.find((t) => t.name === 'get_recommendations');
      if (tool) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-rec-1',
              name: 'get_recommendations',
              arguments: { limit: 3 },
            },
          ],
          modelId: this.modelId,
          tokenUsage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
        };
      }
    }

    // 5. Default General Response
    return {
      content:
        'Hello! I am your AI Commerce Assistant on WhatsApp. I can help you search products, check live stock, add items to your cart, place orders, check order status, track shipments, and answer policy questions. What would you like to do?',
      modelId: this.modelId,
      tokenUsage: { promptTokens: 25, completionTokens: 30, totalTokens: 55 },
    };
  }
}
