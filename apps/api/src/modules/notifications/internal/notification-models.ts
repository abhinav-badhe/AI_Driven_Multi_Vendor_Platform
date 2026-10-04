export type NotificationChannel = 'EMAIL' | 'SMS' | 'PUSH';

export type NotificationStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SENT'
  | 'FAILED'
  | 'RETRY_SCHEDULED'
  | 'DEAD_LETTERED';

export type NotificationType =
  | 'ORDER_CONFIRMATION'
  | 'ORDER_STATUS_UPDATE'
  | 'PAYMENT_RECEIPT'
  | 'PAYMENT_FAILURE_ALERT'
  | 'SHIPMENT_DISPATCHED'
  | 'SHIPMENT_STATUS_UPDATE'
  | 'RETURN_STATUS_UPDATE'
  | 'SETTLEMENT_UPDATE';

export interface NotificationRecord {
  id: string;
  tenantId: string;
  eventId: string;
  notificationType: NotificationType;
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
  disabledTypes: NotificationType[];
  createdAt: string;
  updatedAt: string;
}

export interface RequestNotificationInput {
  tenantId: string;
  customerId?: string | undefined;
  eventId: string;
  notificationType: NotificationType;
  channel: NotificationChannel;
  recipient: string;
  templateId: string;
  payload: Record<string, unknown>;
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
