export interface EmailChannelProvider {
  sendEmail(
    to: string,
    subject: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ providerMessageId: string }>;
}

export interface SmsChannelProvider {
  sendSms(
    to: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ providerMessageId: string }>;
}

export interface PushChannelProvider {
  sendPush(
    deviceToken: string,
    title: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ providerMessageId: string }>;
}

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

  getSentEmails(): Array<{ to: string; subject: string; body: string }> {
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
    if (metadata !== undefined) {
      this.sentEmails.push({ to, subject, body, metadata });
    } else {
      this.sentEmails.push({ to, subject, body });
    }
    return { providerMessageId: `email-${Date.now()}-${Math.random().toString(36).substring(2, 7)}` };
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

  getSentSms(): Array<{ to: string; body: string }> {
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
    if (metadata !== undefined) {
      this.sentSms.push({ to, body, metadata });
    } else {
      this.sentSms.push({ to, body });
    }
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

  getSentPushes(): Array<{ deviceToken: string; title: string; body: string }> {
    return [...this.sentPushes];
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
      throw new Error('FCM/APNS push delivery failed (simulated provider failure)');
    }
    if (metadata !== undefined) {
      this.sentPushes.push({ deviceToken, title, body, metadata });
    } else {
      this.sentPushes.push({ deviceToken, title, body });
    }
    return { providerMessageId: `push-${Date.now()}-${Math.random().toString(36).substring(2, 7)}` };
  }
}
