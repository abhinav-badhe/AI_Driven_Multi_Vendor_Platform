import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger } from '../../../observability/logger.js';
import { UnauthorizedError, NotFoundError, ValidationError } from '../../../errors/app-error.js';
import type { AuthorizedActor } from '../../identity/index.js';
import type {
  IAiStore,
  IWhatsAppProvider,
  WhatsAppInboundMessage,
  WhatsAppMappingRecord,
  WhatsAppWebhookRecord,
  WhatsAppSendResult,
} from './ai-types.js';
import type { AiOrchestrator } from './ai-orchestrator.js';

export class MockWhatsAppProvider implements IWhatsAppProvider {
  readonly providerName = 'mock';
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

  async sendTextMessage(to: string, text: string): Promise<WhatsAppSendResult> {
    this.sentMessages.push({ to, text });
    return { success: true, messageId: `mock-wa-${Date.now()}-${this.sentMessages.length}` };
  }
}

export interface InboundWebhookInput {
  rawBody: string;
  signatureHeader: string;
  webhookSecret: string;
  tenantId: string;
  message: WhatsAppInboundMessage;
}

export interface SubscriptionVerificationQuery {
  mode?: string | undefined;
  verifyToken?: string | undefined;
  challenge?: string | undefined;
}

export class WhatsAppAdapter {
  constructor(
    private readonly store: IAiStore,
    private readonly orchestrator: AiOrchestrator,
    private readonly provider: IWhatsAppProvider,
    private readonly logger: Logger,
  ) {}

  getProvider(): IWhatsAppProvider {
    return this.provider;
  }

  /**
   * Verifies Meta GET webhook subscription handshake (hub.mode, hub.verify_token, hub.challenge).
   */
  verifyWebhookSubscription(
    query: SubscriptionVerificationQuery,
    expectedVerifyToken: string,
  ): { valid: boolean; challenge?: string } {
    if (
      query.mode === 'subscribe' &&
      query.verifyToken &&
      query.verifyToken === expectedVerifyToken
    ) {
      this.logger.info('Meta WhatsApp webhook subscription verified successfully');
      return { valid: true, ...(query.challenge ? { challenge: query.challenge } : {}) };
    }
    this.logger.warn(
      'Rejected WhatsApp webhook subscription: verify token mismatch or invalid mode',
      {
        mode: query.mode,
      },
    );
    return { valid: false };
  }

  /**
   * Parses inbound webhook payload supporting both:
   * 1. Official Meta WhatsApp Business Cloud API JSON payload
   * 2. Simplified direct webhook JSON payload (for testing and direct invocations)
   */
  parseWebhookPayload(
    body: Record<string, unknown>,
    defaultTenantId = 'default-tenant',
  ): WhatsAppInboundMessage[] {
    // 1. Meta WhatsApp Cloud API format
    if (body['object'] === 'whatsapp_business_account' && Array.isArray(body['entry'])) {
      const messages: WhatsAppInboundMessage[] = [];
      for (const entry of body['entry'] as Array<Record<string, unknown>>) {
        const changes = entry['changes'] as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(changes)) continue;

        for (const change of changes) {
          const value = change['value'] as Record<string, unknown> | undefined;
          if (!value || value['messaging_product'] !== 'whatsapp') continue;

          const rawMessages = value['messages'] as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(rawMessages)) continue;

          const metadata = (value['metadata'] as Record<string, unknown> | undefined) ?? {};
          const displayPhoneNumber = String(metadata['display_phone_number'] ?? 'store-phone');

          for (const rawMsg of rawMessages) {
            const msgType = String(rawMsg['type'] ?? 'text');
            const textBody =
              msgType === 'text' && typeof rawMsg['text'] === 'object' && rawMsg['text'] !== null
                ? String((rawMsg['text'] as Record<string, unknown>)['body'] ?? '')
                : '';

            if (textBody.trim().length > 0) {
              messages.push({
                messageId: String(rawMsg['id'] ?? `meta-${Date.now()}`),
                fromNumber: String(rawMsg['from'] ?? ''),
                toNumber: displayPhoneNumber,
                text: textBody,
                timestamp: rawMsg['timestamp']
                  ? new Date(Number(rawMsg['timestamp']) * 1000).toISOString()
                  : new Date().toISOString(),
                tenantId: defaultTenantId,
              });
            }
          }
        }
      }
      return messages;
    }

    // 2. Direct / Simplified payload format
    if (body['messageId'] && (body['from'] || body['fromNumber']) && body['text']) {
      return [
        {
          messageId: String(body['messageId']),
          fromNumber: String(body['from'] ?? body['fromNumber']),
          toNumber: String(body['to'] ?? body['toNumber'] ?? 'store-phone'),
          text: String(body['text']),
          timestamp: new Date().toISOString(),
          tenantId: String(body['tenantId'] ?? defaultTenantId),
        },
      ];
    }

    return [];
  }

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

    // 2. Webhook Deduplication / Replay Protection & Retry Safety
    const payloadHash = createHmac('sha256', 'hash-key').update(rawBody).digest('hex').slice(0, 32);
    const existing = await this.store.getWebhook(tenantId, message.messageId);

    if (existing) {
      if (existing.status === 'PROCESSED') {
        this.logger.info('Duplicate WhatsApp webhook delivery ignored', {
          providerMessageId: message.messageId,
        });
        return {
          processed: false,
          duplicate: true,
        };
      }
      // If status is FAILED or RECEIVED, Meta is retrying after a previous transient error.
      // Allow idempotent retry attempt.
    } else {
      const webhookRecord: WhatsAppWebhookRecord = {
        id: `wh-${message.messageId}`,
        providerMessageId: message.messageId,
        tenantId,
        phoneNumber: message.fromNumber,
        status: 'RECEIVED',
        payloadHash,
        processedAt: new Date().toISOString(),
      };
      await this.store.recordWebhook(webhookRecord);
    }

    // 3. WhatsApp Identity Mapping & Verification Check
    const mapping = await this.store.getWhatsAppMappingByPhone(message.fromNumber);

    // 3a. In-Chat Verification Flow (e.g. user sends "verify 123456" or "link 123456")
    const verifyMatch = message.text.trim().match(/^(?:verify|link|code)\s+([0-9]{6})$/i);
    if (verifyMatch && mapping && !mapping.isVerified) {
      const code = verifyMatch[1];
      const expiresAt = mapping.metadata?.codeExpiresAt as string | undefined;
      const isExpired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false;

      if (!isExpired && mapping.verificationCode === code) {
        await this.store.saveWhatsAppMapping({
          ...mapping,
          isVerified: true,
          verificationCode: null,
          verifiedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        const successMsg =
          '✅ Phone number verified! Your WhatsApp is now securely linked to your store account. You can now browse products, view your cart, place orders, and track shipments.';
        try {
          await this.provider.sendTextMessage(message.fromNumber, successMsg);
        } catch (sendErr) {
          this.logger.error('Failed to send WhatsApp verification confirmation', {
            error: sendErr instanceof Error ? sendErr.message : String(sendErr),
          });
        }
        await this.store.updateWebhookStatus(tenantId, message.messageId, 'PROCESSED');
        return {
          processed: true,
          replyText: successMsg,
        };
      } else {
        const failMsg = isExpired
          ? '⚠️ Verification code expired. Please request a new linking code from your store account.'
          : '⚠️ Invalid verification code. Please check the code and try again.';
        try {
          await this.provider.sendTextMessage(message.fromNumber, failMsg);
        } catch (sendErr) {
          this.logger.error('Failed to send WhatsApp verification rejection', {
            error: sendErr instanceof Error ? sendErr.message : String(sendErr),
          });
        }
        await this.store.updateWebhookStatus(tenantId, message.messageId, 'PROCESSED');
        return {
          processed: true,
          replyText: failMsg,
        };
      }
    }

    let actor: AuthorizedActor;
    let customerId: string | null = null;

    if (mapping && mapping.isVerified) {
      customerId = mapping.customerId;
      actor = {
        userId: mapping.customerId,
        tenantId: mapping.tenantId, // Strict tenant boundary of verified customer
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
        'To view your private order or account information via WhatsApp, your phone number must be linked and verified to your store account. Please link your phone number in your account settings.';

      try {
        await this.provider.sendTextMessage(message.fromNumber, authRefusal);
      } catch (sendErr) {
        this.logger.error('Failed to send WhatsApp auth refusal', {
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
      }
      await this.store.updateWebhookStatus(tenantId, message.messageId, 'PROCESSED');
      return {
        processed: true,
        replyText: authRefusal,
      };
    }

    // 5. Orchestrate AI Response with Error Isolation & Retry Guard
    try {
      const response = await this.orchestrator.processMessage({
        actor,
        tenantId: actor.tenantId,
        channel: 'WHATSAPP',
        externalUserId: message.fromNumber,
        userText: message.text,
        customerId,
      });

      // 6. Send Outbound Response via WhatsApp Provider (outbound errors do NOT corrupt commerce transactions)
      try {
        await this.provider.sendTextMessage(message.fromNumber, response.replyText);
      } catch (outboundErr) {
        this.logger.error('Failed to dispatch outbound WhatsApp response to user', {
          recipient: message.fromNumber,
          error: outboundErr instanceof Error ? outboundErr.message : String(outboundErr),
        });
      }

      // Mark webhook as PROCESSED only after commerce execution finishes successfully
      await this.store.updateWebhookStatus(tenantId, message.messageId, 'PROCESSED');

      return {
        processed: true,
        duplicate: false,
        replyText: response.replyText,
      };
    } catch (err: unknown) {
      // On failure, mark webhook status as FAILED so it can be retried and is not falsely marked PROCESSED
      await this.store.updateWebhookStatus(tenantId, message.messageId, 'FAILED');
      this.logger.error('Failed to process WhatsApp inbound message', {
        messageId: message.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Generates a 6-digit OTP code and initiates phone verification.
   */
  async requestPhoneLinking(
    tenantId: string,
    customerId: string,
    phoneNumber: string,
  ): Promise<{ verificationCode: string; expiresAt: string }> {
    const cleanPhone = phoneNumber.startsWith('+')
      ? phoneNumber
      : `+${phoneNumber.replace(/[^0-9]/g, '')}`;
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const record: WhatsAppMappingRecord = {
      id: `wam-${cleanPhone.replace(/[^0-9]/g, '')}`,
      phoneNumber: cleanPhone,
      tenantId,
      customerId,
      isVerified: false,
      verificationCode: code,
      verifiedAt: null,
      metadata: { codeExpiresAt: expiresAt },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.store.saveWhatsAppMapping(record);

    // Send code to customer's WhatsApp
    const promptMsg = `Your store account verification code is: ${code}. Valid for 15 minutes. Reply with "verify ${code}" or enter this code on the store website.`;
    try {
      await this.provider.sendTextMessage(cleanPhone, promptMsg);
    } catch (err) {
      this.logger.warn('Failed to send verification code SMS/WhatsApp', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { verificationCode: code, expiresAt };
  }

  /**
   * Confirms a 6-digit OTP code and marks the account mapping verified.
   */
  async confirmPhoneLinking(
    tenantId: string,
    customerId: string,
    phoneNumber: string,
    code: string,
  ): Promise<boolean> {
    const cleanPhone = phoneNumber.startsWith('+')
      ? phoneNumber
      : `+${phoneNumber.replace(/[^0-9]/g, '')}`;
    const mapping = await this.store.getWhatsAppMappingByPhone(cleanPhone);
    if (!mapping || mapping.tenantId !== tenantId || mapping.customerId !== customerId) {
      throw new NotFoundError('Pending phone link request not found for this account');
    }

    const expiresAt = mapping.metadata?.codeExpiresAt as string | undefined;
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
      throw new ValidationError('Verification code has expired. Please request a new code.');
    }

    if (mapping.verificationCode !== code.trim()) {
      throw new ValidationError('Invalid verification code');
    }

    await this.store.saveWhatsAppMapping({
      ...mapping,
      isVerified: true,
      verificationCode: null,
      verifiedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    try {
      await this.provider.sendTextMessage(
        cleanPhone,
        '✅ Your WhatsApp account has been verified and linked to your store account!',
      );
    } catch {
      // Outbound notify is non-critical
    }

    return true;
  }

  /**
   * Direct linking helper for administrative setup or testing.
   */
  async linkPhoneNumber(
    tenantId: string,
    customerId: string,
    phoneNumber: string,
    isVerified = true,
  ): Promise<WhatsAppMappingRecord> {
    const cleanPhone = phoneNumber.startsWith('+')
      ? phoneNumber
      : `+${phoneNumber.replace(/[^0-9]/g, '')}`;
    const record: WhatsAppMappingRecord = {
      id: `wam-${cleanPhone.replace(/[^0-9]/g, '')}`,
      phoneNumber: cleanPhone,
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
