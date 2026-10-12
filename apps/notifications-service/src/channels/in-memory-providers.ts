import type {
  EmailChannelProvider,
  SmsChannelProvider,
  PushChannelProvider,
} from './channel-provider.js';

export class InMemoryEmailProvider implements EmailChannelProvider {
  private readonly sentEmails: Array<{
    to: string;
    subject: string;
    body: string;
    metadata?: Record<string, unknown>;
  }> = [];
  private simulateFailure = false;

  setSimulateFailure(fail: boolean): void {
    this.simulateFailure = fail;
  }

  getSentEmails(): Array<{
    to: string;
    subject: string;
    body: string;
    metadata?: Record<string, unknown>;
  }> {
    return [...this.sentEmails];
  }

  clear(): void {
    this.sentEmails.length = 0;
  }

  async sendEmail(
    to: string,
    subject: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ providerMessageId: string }> {
    if (this.simulateFailure) {
      throw new Error('SMTP connection timed out (simulated provider failure)');
    }
    this.sentEmails.push({ to, subject, body, ...(metadata !== undefined ? { metadata } : {}) });
    return {
      providerMessageId: `email-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    };
  }
}

export class InMemorySmsProvider implements SmsChannelProvider {
  private readonly sentSms: Array<{
    to: string;
    body: string;
    metadata?: Record<string, unknown>;
  }> = [];
  private simulateFailure = false;

  setSimulateFailure(fail: boolean): void {
    this.simulateFailure = fail;
  }

  getSentSms(): Array<{ to: string; body: string; metadata?: Record<string, unknown> }> {
    return [...this.sentSms];
  }

  clear(): void {
    this.sentSms.length = 0;
  }

  async sendSms(
    to: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ providerMessageId: string }> {
    if (this.simulateFailure) {
      throw new Error('SMS Gateway 503 Service Unavailable (simulated provider failure)');
    }
    this.sentSms.push({ to, body, ...(metadata !== undefined ? { metadata } : {}) });
    return { providerMessageId: `sms-${Date.now()}-${Math.random().toString(36).substring(2, 7)}` };
  }
}

export class InMemoryPushProvider implements PushChannelProvider {
  private readonly sentPushes: Array<{
    deviceToken: string;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  }> = [];
  private simulateFailure = false;

  setSimulateFailure(fail: boolean): void {
    this.simulateFailure = fail;
  }

  getSentPushes(): Array<{
    deviceToken: string;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  }> {
    return [...this.sentPushes];
  }

  getSentPush(): Array<{
    deviceToken: string;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  }> {
    return this.getSentPushes();
  }

  clear(): void {
    this.sentPushes.length = 0;
  }

  async sendPush(
    deviceToken: string,
    title: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ providerMessageId: string }> {
    if (this.simulateFailure) {
      throw new Error('Push delivery failed (simulated provider failure)');
    }
    this.sentPushes.push({
      deviceToken,
      title,
      body,
      ...(metadata !== undefined ? { metadata } : {}),
    });
    return {
      providerMessageId: `push-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    };
  }
}
