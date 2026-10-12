export type NotificationChannel = 'EMAIL' | 'SMS' | 'PUSH';

export type NotificationStatus =
  'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'RETRY_SCHEDULED' | 'DEAD_LETTERED' | 'SKIPPED';

export type NotificationType =
  | 'ORDER_CONFIRMATION'
  | 'ORDER_STATUS_UPDATE'
  | 'PAYMENT_RECEIPT'
  | 'PAYMENT_FAILURE_ALERT'
  | 'SHIPMENT_DISPATCHED'
  | 'SHIPMENT_STATUS_UPDATE'
  | 'RETURN_STATUS_UPDATE'
  | 'SETTLEMENT_UPDATE'
  | 'PRICE_DROP_ALERT'
  | 'BACK_IN_STOCK_ALERT'
  | string;

export interface NotificationRecord {
  id: string;
  tenantId: string;
  eventId: string;
  notificationType: string;
  channel: NotificationChannel;
  recipient: string;
  idempotencyKey: string;
  templateId: string;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  sentAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerNotificationPreference {
  id: string;
  tenantId: string;
  customerId: string;
  emailEnabled: boolean;
  smsEnabled: boolean;
  pushEnabled: boolean;
  disabledTypes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RequestNotificationInput {
  tenantId: string;
  customerId?: string | undefined;
  eventId?: string | undefined;
  notificationType: string;
  channel: NotificationChannel;
  recipient: string;
  templateId?: string | undefined;
  payload: Record<string, unknown>;
  idempotencyKey?: string | undefined;
}

export interface NotificationResultDto {
  notificationId: string;
  status: NotificationStatus;
  channel: NotificationChannel;
  recipient: string;
  idempotencyKey: string;
  skipped?: boolean;
  reason?: string;
}

export interface ConsumerReceiptRecord {
  id: string;
  consumerName: string;
  eventId: string;
  claimToken?: string | null;
  processedAt: string;
  status: 'PROCESSING' | 'COMPLETED' | 'SKIPPED' | 'FAILED' | 'QUARANTINED';
  errorMetadata?: Record<string, unknown> | null;
}
