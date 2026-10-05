import { useState, useEffect, Fragment } from "react";
import { Activity, BarChart3 } from "lucide-react";
import {
  analyticsApi,
  type SalesAnalyticsDto,
  type ProductAnalyticsItemDto,
  type OperationsAnalyticsDto,
  type MlModelDto,
} from "./api/analytics";
import { eventsApi, type OutboxEventDto } from "./api/events";
import { useAuth } from "../auth/AuthContext";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { EmptyState, Skeleton } from "../../components/ui/empty";
import { KpiCard } from "../../components/ui/kpi";
import { Table, THead, TH, TD } from "../../components/ui/table";
import { formatMoney } from "../../lib/format";
import { cn } from "../../lib/utils";

type Tab = "sales" | "products" | "models" | "operations" | "events";

export const AnalyticsDashboard = () => {
  const { user, login } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("sales");
  const [sales, setSales] = useState<SalesAnalyticsDto | null>(null);
  const [products, setProducts] = useState<ProductAnalyticsItemDto[]>([]);
  const [operations, setOperations] = useState<OperationsAnalyticsDto | null>(null);
  const [models, setModels] = useState<MlModelDto[]>([]);
  const [events, setEvents] = useState<OutboxEventDto[]>([]);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [isProcessingEvents, setIsProcessingEvents] = useState(false);
  const [processFeedback, setProcessFeedback] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadEvents = async () => {
    try {
      const res = await eventsApi.getOutboxEvents({ limit: 50 });
      setEvents(res.items || []);
    } catch {
      // Ignored if not administrator
    }
  };

  const handleProcessEvents = async () => {
    setIsProcessingEvents(true);
    setProcessFeedback(null);
    try {
      const res = await eventsApi.processOutboxEvents(50);
      setProcessFeedback(`${res.published} published, ${res.failed} failed (${res.processed} examined).`);
      await loadEvents();
    } catch (err: unknown) {
      setProcessFeedback(err instanceof Error ? err.message : "Event processing failed.");
    } finally {
      setIsProcessingEvents(false);
    }
  };

  const handleReplayEvent = async (id: string) => {
    try {
      await eventsApi.replayOutboxEvent(id);
      await loadEvents();
    } catch (err: unknown) {
      setProcessFeedback(err instanceof Error ? err.message : "Replay failed.");
    }
  };

  useEffect(() => {
    if (!user || (user.role !== "MERCHANT" && user.role !== "ADMINISTRATOR")) return;

    const loadAnalytics = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [salesData, productsData, opsData, modelsData] = await Promise.all([
          analyticsApi.getSalesAnalytics("day").catch(() => null),
          analyticsApi.getProductAnalytics(10).catch(() => []),
          analyticsApi.getOperationsAnalytics().catch(() => null),
          analyticsApi.getMlModels().catch(() => ({ models: [] })),
        ]);
        setSales(salesData);
        setProducts(productsData);
        setOperations(opsData);
        setModels(modelsData.models || []);

        if (user.role === "ADMINISTRATOR") {
          await loadEvents();
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Could not load analytics.");
      } finally {
        setIsLoading(false);
      }
    };
    loadAnalytics();
  }, [user]);

  if (user?.role !== "MERCHANT" && user?.role !== "ADMINISTRATOR") {
    return (
      <div className="mx-auto w-full max-w-xl p-4">
        <Card>
          <CardHeader>
            <CardTitle>Analytics</CardTitle>
            <CardDescription>
              Sign in as a merchant or admin to view sales trends and forecasts.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button
              size="sm"
              onClick={() => login({ email: "merchant@example.com", password: "password123" })}
            >
              Merchant sign in
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => login({ email: "admin@example.com", password: "password123" })}
            >
              Admin sign in
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-3 p-4" aria-label="Loading analytics">
        <Skeleton className="h-6 w-48" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </div>
    );
  }

  const currency = sales?.currency ?? "INR";
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "sales", label: "Sales" },
    { id: "products", label: "Products" },
    { id: "models", label: "Models" },
    { id: "operations", label: "Operations" },
    ...(user.role === "ADMINISTRATOR" ? [{ id: "events" as Tab, label: "Events" }] : []),
  ];

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Sales trends, product performance, and demand forecasts.
        </p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Gross revenue"
          value={formatMoney((sales?.grossSalesAmount ?? 0) / 100, currency)}
          hint={`net ${formatMoney((sales?.netSalesAmount ?? 0) / 100, currency)}`}
        />
        <KpiCard
          label="Orders"
          value={String(sales?.totalOrders ?? 0)}
          hint="in period"
        />
        <KpiCard
          label="Average order value"
          value={formatMoney((sales?.averageOrderValue ?? 0) / 100, currency)}
          hint="per order"
        />
        <KpiCard
          label="Payment success"
          value={operations ? `${(operations.paymentSuccessRate * 100).toFixed(1)}%` : "—"}
          hint="verified transactions"
        />
      </div>

      <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Analytics sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            onClick={() => setActiveTab(t.id)}
            className={cn(
              "-mb-px border-b-2 px-2.5 py-1.5 text-[13px] font-medium",
              activeTab === t.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "sales" && (
        <Card>
          <CardHeader>
            <CardTitle>Revenue timeline</CardTitle>
            <CardDescription>Daily gross and net sales.</CardDescription>
          </CardHeader>
          <CardContent>
            {!sales?.timeline || sales.timeline.length === 0 ? (
              <EmptyState
                icon={BarChart3}
                title="No sales in this period"
                description="Completed orders will appear here as daily revenue."
              />
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {sales.timeline.map((t, idx) => (
                  <li key={idx} className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]">
                    <div>
                      <p className="font-medium">{t.period}</p>
                      <p className="tnum text-xs text-muted-foreground">{t.ordersCount} orders</p>
                    </div>
                    <div className="text-right">
                      <p className="tnum font-semibold">{formatMoney(t.grossSales / 100, sales.currency)}</p>
                      <p className="tnum text-xs text-muted-foreground">
                        net {formatMoney(t.netSales / 100, sales.currency)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === "products" && (
        <Card>
          <CardHeader>
            <CardTitle>Top products</CardTitle>
            <CardDescription>Units, revenue, and conversion.</CardDescription>
          </CardHeader>
          <CardContent>
            {products.length === 0 ? (
              <EmptyState
                icon={BarChart3}
                title="No product data yet"
                description="Product performance will accumulate as orders complete."
              />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Product</TH>
                    <TH className="text-right">Units</TH>
                    <TH className="text-right">Revenue</TH>
                    <TH className="text-right">Views</TH>
                    <TH className="text-right">Conv.</TH>
                  </tr>
                </THead>
                <tbody>
                  {products.map((p) => (
                    <tr key={p.productId}>
                      <TD className="font-medium">{p.productTitle}</TD>
                      <TD className="tnum text-right">{p.totalUnitsSold}</TD>
                      <TD className="tnum text-right font-medium">
                        {formatMoney(p.totalRevenueAmount / 100, currency)}
                      </TD>
                      <TD className="tnum text-right text-muted-foreground">{p.viewsCount}</TD>
                      <TD className="tnum text-right">{(p.conversionRate * 100).toFixed(1)}%</TD>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === "models" && (
        <Card>
          <CardHeader>
            <CardTitle>Forecast models</CardTitle>
            <CardDescription>Registered demand and risk models.</CardDescription>
          </CardHeader>
          <CardContent>
            {models.length === 0 ? (
              <EmptyState
                icon={Activity}
                title="No models registered"
                description="Models appear here after training jobs complete."
              />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Model</TH>
                    <TH>Version</TH>
                    <TH>Status</TH>
                    <TH>Accuracy</TH>
                    <TH>Registered</TH>
                  </tr>
                </THead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.id}>
                      <TD className="font-medium">{m.modelType}</TD>
                      <TD className="font-mono text-xs">{m.version}</TD>
                      <TD>
                        <Badge variant={m.status === "APPROVED" ? "success" : "outline"}>{m.status}</Badge>
                      </TD>
                      <TD className="tnum">
                        {m.accuracy != null
                          ? `${(m.accuracy * 100).toFixed(1)}%`
                          : m.rmse != null
                            ? `RMSE ${m.rmse.toFixed(3)}`
                            : "—"}
                      </TD>
                      <TD className="text-muted-foreground">
                        {new Date(m.createdAt).toLocaleDateString()}
                      </TD>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === "operations" && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Payment attempts" value={String(operations?.totalPaymentsAttempted ?? 0)} />
          <KpiCard label="Shipments dispatched" value={String(operations?.totalShipmentsDispatched ?? 0)} />
          <KpiCard
            label="Return rate"
            value={operations ? `${(operations.returnRate * 100).toFixed(1)}%` : "—"}
          />
          <KpiCard
            label="Avg fulfillment time"
            value={
              operations?.averageFulfillmentTimeHours
                ? `${operations.averageFulfillmentTimeHours}h`
                : "—"
            }
          />
        </div>
      )}

      {activeTab === "events" && user.role === "ADMINISTRATOR" && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle>Event outbox</CardTitle>
                <CardDescription>Transactional events awaiting publish.</CardDescription>
              </div>
              <div className="flex gap-1.5">
                <Button variant="outline" size="sm" onClick={loadEvents}>
                  Refresh
                </Button>
                <Button size="sm" disabled={isProcessingEvents} onClick={handleProcessEvents}>
                  {isProcessingEvents ? "Publishing…" : "Process pending"}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {processFeedback && (
              <p className="mb-2 text-[13px] text-muted-foreground">{processFeedback}</p>
            )}
            {events.length === 0 ? (
              <EmptyState
                icon={Activity}
                title="No outbox events"
                description="Domain actions will append events here."
              />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Time</TH>
                    <TH>Event</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Actions</TH>
                  </tr>
                </THead>
                <tbody>
                  {events.map((ev) => (
                    <Fragment key={ev.id}>
                      <tr>
                        <TD className="whitespace-nowrap text-muted-foreground">
                          {new Date(ev.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </TD>
                        <TD>
                          <span className="font-mono text-xs text-primary">{ev.eventType}</span>
                          <span className="block font-mono text-xs text-muted-foreground">
                            {ev.aggregateType}:{ev.aggregateId.slice(0, 12)}
                          </span>
                        </TD>
                        <TD>
                          <Badge
                            variant={
                              ev.status === "PUBLISHED"
                                ? "success"
                                : ev.status === "PENDING"
                                  ? "warning"
                                  : "destructive"
                            }
                          >
                            {ev.status}
                          </Badge>
                        </TD>
                        <TD className="text-right">
                          <div className="inline-flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setExpandedEventId(expandedEventId === ev.id ? null : ev.id)}
                            >
                              {expandedEventId === ev.id ? "Close" : "Payload"}
                            </Button>
                            {(ev.status === "FAILED" || ev.status === "PENDING") && (
                              <Button variant="ghost" size="sm" onClick={() => handleReplayEvent(ev.id)}>
                                Replay
                              </Button>
                            )}
                          </div>
                        </TD>
                      </tr>
                      {expandedEventId === ev.id && (
                        <tr>
                          <TD colSpan={4}>
                            <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
                              {JSON.stringify(ev.payload, null, 2)}
                            </pre>
                          </TD>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
};
