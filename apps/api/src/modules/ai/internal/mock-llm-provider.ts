import type {
  ChatMessage,
  ILLMProvider,
  LLMOptions,
  LLMResponse,
  ToolCall,
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
          "I refuse to fulfill this request. System security policies strictly prohibit overriding instructions, bypassing authentication, or elevating privileges.",
        modelId: this.modelId,
        tokenUsage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
      };
    }

    // 2. If the last message was a tool result, synthesize it
    if (lastMessage?.role === 'TOOL') {
      let parsedOutput: unknown = lastMessage.content;
      try {
        parsedOutput = JSON.parse(lastMessage.content);
      } catch {
        // use raw
      }

      return {
        content: `Based on your account information, here are the details: ${JSON.stringify(parsedOutput)}. Is there anything else I can help you with?`,
        modelId: this.modelId,
        tokenUsage: { promptTokens: 60, completionTokens: 25, totalTokens: 85 },
      };
    }

    // 3. Tool Routing Rules (Distinguishing Live Transactional vs RAG vs Recommendations)

    // A. Live Order Queries
    if (lower.includes('my orders') || lower.includes('recent orders') || lower.includes('show my orders')) {
      const tool = tools?.find((t) => t.name === 'get_customer_orders');
      if (tool) {
        // Extract customerId if mentioned, or default to current actor ID
        const match = lower.match(/customer\s+([a-zA-Z0-9-]+)/);
        const customerId = match ? match[1]! : 'current-customer';
        const toolCalls: ToolCall[] = [
          {
            id: 'tc-orders-1',
            name: 'get_customer_orders',
            arguments: { customerId, limit: 5 },
          },
        ];
        return {
          content: '',
          toolCalls,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 40, completionTokens: 15, totalTokens: 55 },
        };
      }
    }

    if (lower.includes('where is my order') || lower.includes('order status') || lower.includes('order-')) {
      const tool = tools?.find((t) => t.name === 'get_order_status');
      if (tool) {
        const orderMatch = userMessage.match(/ord-[a-zA-Z0-9-]+/i) ?? userMessage.match(/order\s+([a-zA-Z0-9-]+)/i);
        const orderId = orderMatch ? orderMatch[1] ?? orderMatch[0] : 'ord-sample-123';
        const toolCalls: ToolCall[] = [
          {
            id: 'tc-order-status-1',
            name: 'get_order_status',
            arguments: { orderId },
          },
        ];
        return {
          content: '',
          toolCalls,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 35, completionTokens: 15, totalTokens: 50 },
        };
      }
    }

    // B. Live Inventory Queries
    if (lower.includes('in stock') || lower.includes('stock quantity') || lower.includes('do you have')) {
      const tool = tools?.find((t) => t.name === 'check_inventory');
      if (tool) {
        const match = userMessage.match(/list-[a-zA-Z0-9-]+/i) ?? userMessage.match(/sku-[a-zA-Z0-9-]+/i);
        const listingId = match ? match[0] : 'list-default';
        const toolCalls: ToolCall[] = [
          {
            id: 'tc-inv-1',
            name: 'check_inventory',
            arguments: { listingId },
          },
        ];
        return {
          content: '',
          toolCalls,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 35, completionTokens: 15, totalTokens: 50 },
        };
      }
    }

    // C. Live Listing Pricing Queries
    if (lower.includes('price') || lower.includes('cost') || lower.includes('how much')) {
      const tool = tools?.find((t) => t.name === 'get_current_listing');
      if (tool && userMessage.includes('list-')) {
        const match = userMessage.match(/list-[a-zA-Z0-9-]+/i);
        const listingId = match ? match[0] : 'list-default';
        const toolCalls: ToolCall[] = [
          {
            id: 'tc-price-1',
            name: 'get_current_listing',
            arguments: { listingId },
          },
        ];
        return {
          content: '',
          toolCalls,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 35, completionTokens: 15, totalTokens: 50 },
        };
      }
    }

    // D. Recommendations Queries
    if (lower.includes('recommend') || lower.includes('what should i buy') || lower.includes('similar')) {
      const tool = tools?.find((t) => t.name === 'get_recommendations');
      if (tool) {
        const toolCalls: ToolCall[] = [
          {
            id: 'tc-rec-1',
            name: 'get_recommendations',
            arguments: { limit: 3 },
          },
        ];
        return {
          content: '',
          toolCalls,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
        };
      }
    }

    // E. Predictive Signal Queries
    if (lower.includes('demand forecast') || lower.includes('expected demand')) {
      const tool = tools?.find((t) => t.name === 'get_demand_forecast');
      if (tool) {
        const match = userMessage.match(/prod-[a-zA-Z0-9-]+/i);
        const productId = match ? match[0] : 'prod-sample';
        const toolCalls: ToolCall[] = [
          {
            id: 'tc-forecast-1',
            name: 'get_demand_forecast',
            arguments: { productId },
          },
        ];
        return {
          content: '',
          toolCalls,
          modelId: this.modelId,
          tokenUsage: { promptTokens: 35, completionTokens: 15, totalTokens: 50 },
        };
      }
    }

    // 4. RAG Knowledge Grounding
    // Check if system messages provide grounded context
    const systemWithContext = messages.find(
      (m) => m.role === 'SYSTEM' && m.content.includes('RELEVANT KNOWLEDGE CONTEXT'),
    );

    if (systemWithContext) {
      // Answer grounded in knowledge context
      return {
        content: `According to our official documentation:\n${systemWithContext.content.replace('RELEVANT KNOWLEDGE CONTEXT:', '').trim()}`,
        modelId: this.modelId,
        tokenUsage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
      };
    }

    // 5. Default General Response
    return {
      content:
        "Hello! I am your AI Commerce Assistant. I can help you check orders, find product specifications, review return policies, and check live stock. How may I assist you today?",
      modelId: this.modelId,
      tokenUsage: { promptTokens: 25, completionTokens: 30, totalTokens: 55 },
    };
  }
}
