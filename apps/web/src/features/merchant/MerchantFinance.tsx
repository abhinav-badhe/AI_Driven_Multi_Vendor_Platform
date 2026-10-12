import { useState, useEffect } from 'react';
import { ReceiptText, Search } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Alert } from '../../components/ui/alert';
import { EmptyState, Skeleton } from '../../components/ui/empty';
import { Input } from '../../components/ui/input';
import { KpiCard } from '../../components/ui/kpi';
import { Table, THead, TH, TD } from '../../components/ui/table';
import { formatMoney } from '../../lib/format';

export interface MerchantFinancialSummaryDto {
  merchantId: string;
  currency: string;
  pendingSettlementMinor: number;
  settledBalanceMinor: number;
  reserveBalanceMinor: number;
  totalEarningsMinor: number;
  totalCommissionsMinor: number;
  totalFeesMinor: number;
  totalRefundsMinor: number;
  updatedAt: string;
}

export interface LedgerEntryDto {
  id: string;
  merchantId: string;
  entryType: 'EARNING' | 'COMMISSION' | 'FEE' | 'REFUND' | 'ADJUSTMENT' | 'PAYOUT';
  direction: 'CREDIT' | 'DEBIT';
  amountMinor: number;
  currency: string;
  sourceType: string;
  sourceId: string;
  description?: string;
  createdAt: string;
}

const typeVariant = (t: LedgerEntryDto['entryType']) =>
  t === 'EARNING'
    ? ('success' as const)
    : t === 'REFUND'
      ? ('destructive' as const)
      : ('outline' as const);

const TYPE_FILTERS: Array<{ label: string; value: LedgerEntryDto['entryType'] | 'ALL' }> = [
  { label: 'All', value: 'ALL' },
  { label: 'Earnings', value: 'EARNING' },
  { label: 'Commissions', value: 'COMMISSION' },
  { label: 'Fees', value: 'FEE' },
  { label: 'Refunds', value: 'REFUND' },
  { label: 'Payouts', value: 'PAYOUT' },
];

export const MerchantFinance = () => {
  const { user } = useAuth();
  const [summary, setSummary] = useState<MerchantFinancialSummaryDto | null>(null);
  const [entries, setEntries] = useState<LedgerEntryDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<LedgerEntryDto['entryType'] | 'ALL'>('ALL');

  const loadFinance = async () => {
    if (!user) return;
    setIsLoading(true);
    setError(null);
    try {
      const merchantId = user.tenantId;
      const [sumData, ledgerData] = await Promise.all([
        apiClient<MerchantFinancialSummaryDto>(`/settlement/merchants/${merchantId}/summary`).catch(
          () => null,
        ),
        apiClient<{ entries: LedgerEntryDto[] }>(
          `/settlement/merchants/${merchantId}/ledger`,
        ).catch(() => ({
          entries: [],
        })),
      ]);
      setSummary(sumData);
      setEntries(Array.isArray(ledgerData.entries) ? ledgerData.entries : []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load finance data.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadFinance();
  }, [user]);

  if (isLoading) {
    return (
      <div className="space-y-4 p-4" aria-label="Loading finance">
        <Skeleton className="h-6 w-48" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </div>
    );
  }

  const currency = summary?.currency ?? 'INR';

  const filteredEntries = entries.filter((entry) => {
    if (typeFilter !== 'ALL' && entry.entryType !== typeFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const matchId = entry.id.toLowerCase().includes(q);
      const matchSource = `${entry.sourceType} ${entry.sourceId}`.toLowerCase().includes(q);
      const matchDesc = (entry.description || '').toLowerCase().includes(q);
      if (!matchId && !matchSource && !matchDesc) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Finance & Settlement ({entries.length})
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Earnings, commissions, payouts, and the settlement ledger.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadFinance}>
          Refresh
        </Button>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Settled balance"
          value={formatMoney((summary?.settledBalanceMinor ?? 0) / 100, currency)}
          hint="available for payout"
        />
        <KpiCard
          label="Pending settlement"
          value={formatMoney((summary?.pendingSettlementMinor ?? 0) / 100, currency)}
          hint="awaiting delivery"
        />
        <KpiCard
          label="Total earnings"
          value={formatMoney((summary?.totalEarningsMinor ?? 0) / 100, currency)}
          hint="gross to date"
        />
        <KpiCard
          label="Commissions paid"
          value={formatMoney((summary?.totalCommissionsMinor ?? 0) / 100, currency)}
          hint="platform fees"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Ledger Records</CardTitle>
          <CardDescription>Every journal keeps debits equal to credits.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Search and filter pills for ledger */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] max-w-sm flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search ledger by source, ID, description…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {TYPE_FILTERS.map((t) => (
                <Button
                  key={t.value}
                  variant={typeFilter === t.value ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setTypeFilter(t.value)}
                >
                  {t.label}
                </Button>
              ))}
            </div>
          </div>

          {filteredEntries.length === 0 ? (
            <EmptyState
              icon={ReceiptText}
              title={entries.length === 0 ? 'No ledger entries yet' : 'No matching ledger entries'}
              description={
                entries.length === 0
                  ? 'Confirmed orders will append journals here automatically.'
                  : 'Try adjusting your search query or type filter.'
              }
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Date</TH>
                  <TH>Type</TH>
                  <TH>Direction</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Source</TH>
                </tr>
              </THead>
              <tbody>
                {filteredEntries.map((entry) => (
                  <tr key={entry.id}>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleString()}
                    </TD>
                    <TD>
                      <Badge variant={typeVariant(entry.entryType)}>{entry.entryType}</Badge>
                    </TD>
                    <TD>
                      <span
                        className={
                          entry.direction === 'CREDIT' ? 'text-success' : 'text-destructive'
                        }
                      >
                        {entry.direction === 'CREDIT' ? '+ Credit' : '− Debit'}
                      </span>
                    </TD>
                    <TD className="tnum text-right font-medium">
                      {formatMoney(entry.amountMinor / 100, entry.currency)}
                    </TD>
                    <TD
                      className="max-w-48 truncate font-mono text-xs text-muted-foreground"
                      title={entry.description || `${entry.sourceType} ${entry.sourceId}`}
                    >
                      {entry.sourceType} {entry.sourceId.slice(0, 8)}
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
