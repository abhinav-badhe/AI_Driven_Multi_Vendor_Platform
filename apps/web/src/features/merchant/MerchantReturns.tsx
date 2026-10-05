import { useState, useEffect } from "react";
import { Inbox } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { apiClient } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { EmptyState, TableSkeleton } from "../../components/ui/empty";

export interface ReturnItemDto {
  orderItemId: string;
  quantity: number;
}

export interface ReturnRequestDto {
  id: string;
  customerOrderId: string;
  sellerOrderId: string;
  reason: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "IN_TRANSIT" | "RECEIVED" | "INSPECTED" | "COMPLETED";
  items: ReturnItemDto[];
  createdAt: string;
}

const statusVariant = (s: ReturnRequestDto["status"]) =>
  s === "COMPLETED" ? ("success" as const)
  : s === "REJECTED" ? ("destructive" as const)
  : s === "REQUESTED" ? ("warning" as const)
  : ("outline" as const);

export const MerchantReturns = () => {
  const { user } = useAuth();
  const [returns, setReturns] = useState<ReturnRequestDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const loadReturns = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient<ReturnRequestDto[]>("/fulfillment/returns");
      setReturns(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not load returns.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadReturns();
  }, [user]);

  const handleUpdate = async (
    ret: ReturnRequestDto,
    status: ReturnRequestDto["status"],
    options?: { restock?: boolean; restockCondition?: "SELLABLE" | "DEFECTIVE" }
  ) => {
    setActingId(ret.id);
    setError(null);
    try {
      await apiClient<ReturnRequestDto>(`/fulfillment/returns/${ret.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status, options }),
      });
      setNotice(`Return marked as ${status.toLowerCase()}.`);
      setTimeout(() => setNotice(null), 4000);
      await loadReturns();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setActingId(null);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Returns ({returns.length})</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Approve requests, confirm receipts, and restock or write off items.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadReturns}>
          Refresh
        </Button>
      </div>

      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      {isLoading ? (
        <div aria-label="Loading returns">
          <TableSkeleton rows={4} />
        </div>
      ) : returns.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No return requests"
          description="Customer return requests for your store will appear here."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {returns.map((ret) => {
            const busy = actingId === ret.id;
            return (
              <Card key={ret.id}>
                <CardContent className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-mono text-xs">RMA {ret.id.slice(0, 8)}</p>
                      <Badge variant={statusVariant(ret.status)}>{ret.status}</Badge>
                    </div>
                    <p className="mt-1 text-[13px]">“{ret.reason}”</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {ret.items?.length || 1} {(ret.items?.length || 1) === 1 ? "item" : "items"} ·
                      requested {new Date(ret.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="ml-auto flex shrink-0 flex-wrap gap-1.5">
                    {ret.status === "REQUESTED" && (
                      <>
                        <Button size="sm" disabled={busy} onClick={() => handleUpdate(ret, "APPROVED")}>
                          {busy ? "Saving…" : "Approve"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => handleUpdate(ret, "REJECTED")}
                          className="text-destructive hover:text-destructive"
                        >
                          Reject
                        </Button>
                      </>
                    )}
                    {ret.status === "APPROVED" && (
                      <Button size="sm" disabled={busy} onClick={() => handleUpdate(ret, "RECEIVED")}>
                        {busy ? "Saving…" : "Mark received"}
                      </Button>
                    )}
                    {ret.status === "RECEIVED" && (
                      <>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            handleUpdate(ret, "COMPLETED", { restock: true, restockCondition: "SELLABLE" })
                          }
                        >
                          {busy ? "Saving…" : "Restock & refund"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            handleUpdate(ret, "COMPLETED", { restock: false, restockCondition: "DEFECTIVE" })
                          }
                          className="text-destructive hover:text-destructive"
                        >
                          Write off
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};
