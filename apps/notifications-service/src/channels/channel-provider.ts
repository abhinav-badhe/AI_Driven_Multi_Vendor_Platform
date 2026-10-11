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

export interface NotificationChannelProviders {
  email: EmailChannelProvider;
  sms: SmsChannelProvider;
  push: PushChannelProvider;
}
