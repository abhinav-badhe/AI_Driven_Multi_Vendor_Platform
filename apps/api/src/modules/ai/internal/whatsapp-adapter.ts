import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger } from '../../../observability/logger.js';
import { UnauthorizedError } from '../../../errors/app-error.js';
import type { AuthorizedActor } from '../../identity/index.js';
import type {
  IAiStore,
  IWhatsAppProvider,
  WhatsAppInboundMessage,
  WhatsAppMappingRecord,
  WhatsAppWebhookRecord,
} from './ai-types.js';
import type { AiOrchestrator } from './ai-orchestrator.js';

export class MockWhatsAppProvider implements IWhatsAppProvider {
  readonly sentMessages: Array<{ to: string; text: string }> = [];

  verifyWebhookSignature(rawPayload: string, signature: string, secret: string): boolean {
    if (!signature || !secret) return false;

    try {
      const hmac = createHmac('sha256', secret);
      hmac.update(rawPayload);
      const expectedHex = hmac.digest('hex');

      const cleanSig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
      const expectedBuffer = Buffer.from(expectedHex, 'hex');
      const sigBuffer = Buffer.from(cleanSig, 'hex');

      if (expectedBuffer.length !== sigBuffer.length) return false;
      return timingSafeEqual(expectedBuffer, sigBuffer);
    } catch {
      return false;
    }
  }

  async sendTextMessage(to: string, text: string): Promise<boolean> {
    this.sentMessages.push({ to, text });
    return true;
  }
}

export interface InboundWebhookInput {
  rawBody: string;
  signatureHeader: string;
  webhookSecret: string;
  tenantId: string;
  message: WhatsAppInboundMessage;
}

export class WhatsAppAdapter {
  constructor(
    private readonly store: IAiStore,
    private readonly orchestrator: AiOrchestrator,
    private readonly provider: IWhatsAppProvider,
    private readonly logger: Logger,
  ) {}

  /**
   * Processes inbound WhatsApp webhook message with HMAC signature verification,
   * durable deduplication, identity mapping, and orchestration.
   */
  async handleInboundWebhook(input: InboundWebhookInput): Promise<{
    processed: boolean;
    duplicate?: boolean;
    replyText?: string;
  }> {
    const { rawBody, signatureHeader, webhookSecret, tenantId, message } = input;

    // 1. Verify HMAC-SHA256 Webhook Signature
    const isValid = this.provider.verifyWebhookSignature(rawBody, signatureHeader, webhookSecret);
    if (!isValid) {
      this.logger.warn('Rejected WhatsApp webhook due to invalid signature', {
        providerMessageId: message.messageId,
      });
      throw new UnauthorizedError('Invalid WhatsApp webhook signature');
    }

    // 2. Webhook Deduplication / Replay Protection
    const payloadHash = createHmac('sha256', 'hash-key').update(rawBody).digest('hex').slice(0, 32);
    const webhookRecord: WhatsAppWebhookRecord = {
      id: `wh-${message.messageId}`,
      providerMessageId: message.messageId,
      tenantId,
      phoneNumber: message.fromNumber,
      status: 'PROCESSED',
      payloadHash,
      processedAt: new Date().toISOString(),
    };

    const isFirstTime = await this.store.recordWebhook(webhookRecord);
    if (!isFirstTime) {
      this.logger.info('Duplicate WhatsApp webhook delivery ignored', {
        providerMessageId: message.messageId,
      });
      return {
        processed: false,
        duplicate: true,
      };
    }

    // 3. WhatsApp Identity Mapping & Verification Check
    const mapping = await this.store.getWhatsAppMappingByPhone(message.fromNumber);
    let actor: AuthorizedActor;
    let customerId: string | null = null;

    if (mapping && mapping.isVerified) {
      customerId = mapping.customerId;
      actor = {
        userId: mapping.customerId,
        tenantId,
        role: 'CUSTOMER',
      };
    } else {
      // Unverified or anonymous phone number
      actor = {
        userId: `anon-${message.fromNumber.replace(/[^0-9]/g, '')}`,
        tenantId,
        role: 'CUSTOMER',
      };
    }

    // 4. Privacy Check: If unverified user asks for private personal data, refuse and guide
    const lower = message.text.toLowerCase();
    const isPrivateQuery =
      lower.includes('my order') ||
      lower.includes('order status') ||
      lower.includes('refund status') ||
      lower.includes('my address');

    if (isPrivateQuery && (!mapping || !mapping.isVerified)) {
      const authRefusal =
        "To view your private order or account information via WhatsApp, your phone number must be linked and verified to your store account. Please link your phone number in your account settings.";

      await this.provider.sendTextMessage(message.fromNumber, authRefusal);
      return {
        processed: true,
        replyText: authRefusal,
      };
    }

    // 5. Orchestrate AI Response
    const response = await this.orchestrator.processMessage({
      actor,
      tenantId,
      channel: 'WHATSAPP',
      externalUserId: message.fromNumber,
      userText: message.text,
      customerId,
    });

    // 6. Send Outbound Response via WhatsApp Provider
    await this.provider.sendTextMessage(message.fromNumber, response.replyText);

    return {
      processed: true,
      duplicate: false,
      replyText: response.replyText,
    };
  }

  /**
   * Links and verifies a customer phone number.
   */
  async linkPhoneNumber(
    tenantId: string,
    customerId: string,
    phoneNumber: string,
    isVerified = true,
  ): Promise<WhatsAppMappingRecord> {
    const record: WhatsAppMappingRecord = {
      id: `wam-${phoneNumber.replace(/[^0-9]/g, '')}`,
      phoneNumber,
      tenantId,
      customerId,
      isVerified,
      verifiedAt: isVerified ? new Date().toISOString() : null,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.store.saveWhatsAppMapping(record);
    return record;
  }
}
