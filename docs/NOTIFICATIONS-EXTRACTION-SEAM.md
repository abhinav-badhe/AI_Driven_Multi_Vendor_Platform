# NOTIFICATIONS CLIENT SEAM ARCHITECTURE

> **Document Status:** Authoritative Seam Specification & Migration Guide  
> **Extraction Target:** Notifications Microservice (Seam Phase 1)  
> **Repository Safety Status:** Fully Verified & Tested. Zero database schema changes, zero broker dependencies, zero HTTP/infrastructure modifications, zero frontend changes.

---

## 1. Overview & Objective

To prepare the **Notifications** domain for extraction as an autonomous microservice without breaking monolithic operation, we have introduced a clean abstraction seam on the client side:

```
BEFORE:
Caller (PriceAlertService / BackInStockService / Identity)
   └── Direct coupling to concrete NotificationService

AFTER (Current Transition State):
Caller (PriceAlertService / BackInStockService / Identity)
   └── INotificationClient (Interface Seam)
          └── LocalNotificationClient (In-Process Adapter)
                 └── NotificationService (Monolith Domain Engine)

FUTURE (Microservice Cutover):
Caller (PriceAlertService / BackInStockService / Identity)
   └── INotificationClient (Interface Seam)
          └── HttpNotificationClient (Network / Gateway Adapter)
                 └── Standalone Notifications Service (:4005)
```

This seam eliminates direct coupling between external monolith domains and the concrete `NotificationService`.

---

## 2. Interface Boundary: `INotificationClient`

The interface is intentionally **minimal and narrow**. Rather than mirroring internal administrative, storage, or preference querying APIs, it exposes strictly what external callers require:

```typescript
export interface INotificationClient {
  /** Enqueue an asynchronous transactional or marketing notification with idempotency enforcement */
  requestNotification(input: RequestNotificationInput): Promise<NotificationResultDto>;

  /** Immediate, synchronous delivery of security/account emails (verification, reset) */
  sendTransactionalEmail(to: string, subject: string, body: string): Promise<string>;

  /** Batch process and dispatch pending notifications to external channels */
  processPendingNotifications(options?: {
    batchSize?: number;
    baseRetryDelayMs?: number;
  }): Promise<{ claimed: number; sent: number; failed: number; deadLettered: number }>;
}
```

### Methods Excluded from `INotificationClient`:

- `listNotifications`: internal administrative monitoring.
- `getNotificationById`: internal administrative inspection.
- `retryNotification`: internal administrative recovery.
- `getCustomerPreferences` / `setCustomerPreferences`: internal preference store used by notification preference HTTP endpoints.

---

## 3. Current In-Process Adapter: `LocalNotificationClient`

Located at: [`apps/api/src/modules/notifications/internal/notification-client.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/internal/notification-client.ts)

```typescript
export class LocalNotificationClient implements INotificationClient {
  constructor(private readonly notificationService: NotificationService) {}

  async requestNotification(input: RequestNotificationInput): Promise<NotificationResultDto> {
    return this.notificationService.requestNotification(input);
  }

  async sendTransactionalEmail(to: string, subject: string, body: string): Promise<string> {
    return this.notificationService.sendTransactionalEmail(to, subject, body);
  }

  async processPendingNotifications(options?: {
    batchSize?: number;
    baseRetryDelayMs?: number;
  }): Promise<{ claimed: number; sent: number; failed: number; deadLettered: number }> {
    return this.notificationService.processPendingNotifications(options);
  }
}
```

Factory method provided on `notificationModule`:

```typescript
notificationModule.createClient(service: NotificationService): INotificationClient {
  return new LocalNotificationClient(service);
}
```

---

## 4. Migrated Callers Audit

| Caller Domain              | Migrated File                                                                                                                                                                                                                        | Prior Dependency                                  | New Dependency                                   | Methods Invoked                                                |
| :------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------ | :----------------------------------------------- | :------------------------------------------------------------- |
| **Price Alerts**           | [`apps/api/src/modules/price-alerts/internal/price-alert-service.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/price-alerts/internal/price-alert-service.ts) | `NotificationService`                             | `INotificationClient`                            | `requestNotification(...)`                                     |
| **Price Alerts Module**    | [`apps/api/src/modules/price-alerts/index.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/price-alerts/index.ts)                                               | `NotificationService`                             | `INotificationClient`                            | Factory typing                                                 |
| **Customer / BackInStock** | [`apps/api/src/modules/customer/internal/back-in-stock-service.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/customer/internal/back-in-stock-service.ts)     | `NotificationService`                             | `INotificationClient`                            | `requestNotification(...)`, `processPendingNotifications(...)` |
| **Customer Module**        | [`apps/api/src/modules/customer/index.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/customer/index.ts)                                                       | `NotificationService`                             | `INotificationClient`                            | Factory typing                                                 |
| **Identity Service**       | [`apps/api/src/app.ts#L492-L498`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/app.ts#L492-L498)                                                                         | `notificationService.sendTransactionalEmail`      | `notificationClient.sendTransactionalEmail`      | Verification email dispatch                                    |
| **Background Dispatcher**  | [`apps/api/src/app.ts#L598-L605`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/app.ts#L598-L605)                                                                         | `notificationService.processPendingNotifications` | `notificationClient.processPendingNotifications` | 30s batch polling                                              |

---

## 5. What Remains Intentionally Inside the Monolith

The following components remain part of the monolith during this transitional phase:

1. **`NotificationService` & `NotificationRepository`**: Continue operating against `commerce_db` tables (`notifications`, `customer_notification_preferences`) for the in-process deployment.
2. **`NotificationEventConsumer`**: Consumes in-process `DomainEvent` objects from the transactional outbox relay via `InMemoryEventTransport`.
3. **`event-routes.ts`**: Fastify controllers for `/notifications*` admin routes and `/customers/me/notification-preferences*` customer routes remain mounted on the Fastify instance.
4. **Price Alerts Domain**: Remains completely within the monolith, as established in the extraction boundary analysis, until its 7 foreign database table queries and synchronous listing update hooks are decoupled.

---

## 6. Future `HttpNotificationClient` Replacement Point

When the standalone `apps/notifications-service` is ready:

1. We implement `HttpNotificationClient implements INotificationClient` in `apps/api`.
2. It sends HTTP requests:
   - `POST /v1/internal/notifications/request`
   - `POST /v1/internal/notifications/transactional-email`
   - `POST /v1/internal/notifications/process`
3. In `apps/api/src/app.ts`, `notificationClient` will simply be constructed as:
   ```typescript
   const notificationClient = config.notifications.serviceUrl
     ? new HttpNotificationClient(config.notifications.serviceUrl)
     : notificationModule.createClient(notificationService);
   ```
4. **Zero changes** will be required in `PriceAlertService`, `BackInStockService`, or `IdentityService`.

---

## 7. Verification & Safety Guarantees

- **Test Suite Added:** [`apps/api/test/notification-client.test.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/test/notification-client.test.ts) (6 tests passing).
- **All Impacted Tests Passing:**
  - `test/price-alerts.test.ts` (5/5 passing)
  - `test/customer-back-in-stock.test.ts` (18/18 passing)
  - `test/events-and-notifications.test.ts` (23/23 passing)
  - `test/identity-http.test.ts` & `test/identity-auth.test.ts` (29/29 passing)
- **TypeScript Compilation:** `npm run typecheck` passed with 0 errors.
- **Zero Foreign Dependencies:** Static analysis confirms zero external modules depend on concrete `NotificationService`.
