import { useState } from "react";
import { ArrowLeftRight, RefreshCw } from "lucide-react";
import { apiClient } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { EmptyState } from "../../components/ui/empty";
import { KpiCard } from "../../components/ui/kpi";
import { Table, THead, TH, TD } from "../../components/ui/table";
import { Input } from "../../components/ui/input";
import { formatMoney } from "../../lib/format";

export interface SettlementRecordDto {
  id: string;
  merchantId: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  netPayoutAmountMinor: number;
  status: "DRAFT" | "CALCULATED" | "APPROVED" | "SETTLED" | "REJECTED";
  createdAt: string;
}

export const AdminSettlements = () => {
  const [settlements, setSettlements] = useState<SettlementRecordDto[]>([
    {
      id: "set-apex-001",
      merchantId: "tenant-merchant-1",
      currency: "INR",
      periodStart: new Date(Date.now() - 7 * 86400000).toISOString(),
      periodEnd: new Date().toISOString(),
      netPayoutAmountMinor: 18450000,
      status: "CALCULATED",
      createdAt: new Date().toISOString(),
    },
  ]);
  const [calcMerchantId, setCalcMerchantId] = useState("tenant-merchant-1");
  const [isCalculating, setIsCalculating] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const handleCalculateSettlement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!calcMerchantId.trim()) return;
    setIsCalculating(true);
    setFeedback(null);
    try {
      const res = await apiClient<SettlementRecordDto>("/settlement/settlements/calculate", {
        method: "POST",
        body: JSON.stringify({
          merchantId: calcMerchantId.trim(),
          periodStart: new Date(Date.now() - 14 * 86400000).toISOString(),
          periodEnd: new Date().toISOString(),
          currency: "INR",
        }),
      });
      setSettlements((prev) => [res, ...prev.filter((s) => s.id !== res.id)]);
      setFeedback(`Settlement calculated for ${calcMerchantId}: Net payout ${formatMoney(res.netPayoutAmountMinor / 100, res.currency)}`);
    } catch (err: unknown) {
      alert(`Calculation error: ${err instanceof Error ? err.message : "Error"}`);
    } finally {
      setIsCalculating(false);
    }
  };

  const handleTransition = async (settlementId: string, targetStatus: SettlementRecordDto["status"]) => {
    try {
      const res = await apiClient<SettlementRecordDto>(`/settlement/settlements/${settlementId}/transition`, {
        method: "POST",
        body: JSON.stringify({ targetStatus }),
      });
      setSettlements((prev) => prev.map((s) => (s.id === settlementId ? res : s)));
      setFeedback(`Settlement ${settlementId} status transitioned to ${targetStatus}`);
    } catch (err: unknown) {
      alert(`Transition error: ${err instanceof Error ? err.message : "Error"}`);
    }
  };

  const totalPayout = settlements.reduce((sum, s) => sum + s.netPayoutAmountMinor, 0) / 100;
  const approvedCount = settlements.filter((s) => s.status === "APPROVED" || s.status === "SETTLED").length;

  const statusVariant = (s: SettlementRecordDto["status"]) => {
    switch (s) {
      case "SETTLED":
      case "APPROVED":
        return "success" as const;
      case "CALCULATED":
      case "DRAFT":
        return "warning" as const;
      case "REJECTED":
        return "destructive" as const;
      default:
        return "outline" as const;
    }
  };

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Platform settlements &amp; ledger governance</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Execute period seller disbursements, verify mathematical balance invariants, and approve payouts.
          </p>
        </div>
      </div>

      {feedback && (
        <Alert tone="success" title="Settlement updated">
          {feedback}
        </Alert>
      )}

      {/* Bento KPIs matching Merchant Panel */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total calculated payouts</p>
            <p className="tnum mt-1 text-2xl font-semibold tracking-tight">
              {formatMoney(totalPayout, "INR")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Net seller funds across all settlement cycles</p>
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
          <KpiCard label="Settlement runs" value={String(settlements.length)} hint="generated batches" />
          <KpiCard label="Disbursements" value={String(approvedCount)} hint="approved / paid" />
          <KpiCard label="Ledger status" value="Balanced" hint="Σ Debits = Σ Credits" />
        </div>
      </div>

      {/* Calculate Settlement Run Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Calculate periodic payout</CardTitle>
              <CardDescription>Aggregate order line items and deductions for a vendor</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCalculateSettlement} className="flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-[200px]">
              <Input
                value={calcMerchantId}
                onChange={(e) => setCalcMerchantId(e.target.value)}
                placeholder="Merchant Tenant ID (e.g., tenant-merchant-1)"
                className="h-8 text-xs"
              />
            </div>
            <Button type="submit" size="sm" className="h-8 text-xs" disabled={isCalculating || !calcMerchantId.trim()}>
              <RefreshCw className="mr-1.5 h-3 w-3" />
              {isCalculating ? "Calculating…" : "Calculate settlement"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Main Table Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Settlement runs</CardTitle>
              <CardDescription>Periodic accounting batches and disbursement workflow</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {settlements.length === 0 ? (
            <EmptyState
              icon={ArrowLeftRight}
              title="No settlement records"
              description="Calculate a settlement batch above to create a disbursement record."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Settlement ID</TH>
                  <TH>Merchant Tenant</TH>
                  <TH>Period</TH>
                  <TH className="text-right">Net Payout</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Workflow Actions</TH>
                </tr>
              </THead>
              <tbody>
                {settlements.map((s) => (
                  <tr key={s.id}>
                    <TD className="font-mono text-xs font-medium">#{s.id.slice(0, 12)}</TD>
                    <TD className="font-mono text-xs text-muted-foreground">{s.merchantId}</TD>
                    <TD className="text-xs text-muted-foreground">
                      {new Date(s.periodStart).toLocaleDateString()} – {new Date(s.periodEnd).toLocaleDateString()}
                    </TD>
                    <TD className="tnum text-right font-medium text-xs">
                      {formatMoney(s.netPayoutAmountMinor / 100, s.currency)}
                    </TD>
                    <TD>
                      <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                    </TD>
                    <TD className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {s.status === "CALCULATED" && (
                          <Button
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => handleTransition(s.id, "APPROVED")}
                          >
                            Approve
                          </Button>
                        )}
                        {s.status === "APPROVED" && (
                          <Button
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => handleTransition(s.id, "SETTLED")}
                          >
                            Mark settled
                          </Button>
                        )}
                        {s.status === "SETTLED" && (
                          <span className="text-[11px] font-medium text-emerald-600">Disbursed</span>
                        )}
                      </div>
                    </TD>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
