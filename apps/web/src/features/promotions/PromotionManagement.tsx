import React, { useState, useEffect, useCallback } from 'react';
import {
  Tag,
  Plus,
  CheckCircle,
  XCircle,
  RefreshCw,
  AlertCircle,
  TrendingUp,
  DollarSign,
} from 'lucide-react';
import {
  promotionsApi,
  type PromotionDto,
  type CreatePromotionPayload,
  type PromotionAnalyticsDto,
} from './api/promotions';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Alert } from '../../components/ui/alert';
import { EmptyState, Skeleton } from '../../components/ui/empty';
import { Input, Label } from '../../components/ui/input';
import { formatPrice } from '../../lib/format';

interface PromotionManagementProps {
  role: 'MERCHANT' | 'ADMINISTRATOR';
  tenantId?: string;
}

export const PromotionManagement: React.FC<PromotionManagementProps> = ({ role, tenantId }) => {
  const [promotions, setPromotions] = useState<PromotionDto[]>([]);
  const [analytics, setAnalytics] = useState<PromotionAnalyticsDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Form State
  const [formData, setFormData] = useState<CreatePromotionPayload>({
    name: '',
    description: '',
    code: '',
    discountType: 'PERCENTAGE',
    discountValue: 10,
    currency: 'USD',
    scope: 'ORDER',
    targetIds: [],
    minOrderAmount: 0,
    maxDiscountAmount: null,
    startsAt: new Date().toISOString().slice(0, 16),
    expiresAt: null,
    status: 'ACTIVE',
    usageLimitTotal: null,
    usageLimitPerCustomer: null,
    firstOrderOnly: false,
    stackable: false,
  });

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [promos, stats] = await Promise.all([
        promotionsApi.listPromotions({
          merchantTenantId: role === 'MERCHANT' ? tenantId : undefined,
        }),
        promotionsApi
          .getPromotionAnalytics(role === 'MERCHANT' ? tenantId : undefined)
          .catch(() => null),
      ]);
      setPromotions(promos);
      setAnalytics(stats);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load promotions');
    } finally {
      setIsLoading(false);
    }
  }, [role, tenantId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleToggleStatus = async (promo: PromotionDto) => {
    const nextStatus = promo.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      await promotionsApi.updatePromotion(promo.id, { status: nextStatus });
      setPromotions((prev) =>
        prev.map((p) => (p.id === promo.id ? { ...p, status: nextStatus } : p)),
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update promotion status');
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setFormError(null);
    try {
      const payload: CreatePromotionPayload = {
        ...formData,
        merchantTenantId: role === 'MERCHANT' ? tenantId : undefined,
        code: formData.code?.trim() ? formData.code.trim().toUpperCase() : undefined,
        discountValue: Number(formData.discountValue),
        minOrderAmount: Number(formData.minOrderAmount) || 0,
        maxDiscountAmount: formData.maxDiscountAmount ? Number(formData.maxDiscountAmount) : null,
        usageLimitTotal: formData.usageLimitTotal ? Number(formData.usageLimitTotal) : null,
        usageLimitPerCustomer: formData.usageLimitPerCustomer
          ? Number(formData.usageLimitPerCustomer)
          : null,
        expiresAt: formData.expiresAt ? new Date(formData.expiresAt).toISOString() : null,
        startsAt: new Date(formData.startsAt).toISOString(),
      };

      const created = await promotionsApi.createPromotion(payload);
      setPromotions((prev) => [created, ...prev]);
      setShowCreateModal(false);
      // Reset form
      setFormData({
        name: '',
        description: '',
        code: '',
        discountType: 'PERCENTAGE',
        discountValue: 10,
        currency: 'USD',
        scope: 'ORDER',
        targetIds: [],
        minOrderAmount: 0,
        maxDiscountAmount: null,
        startsAt: new Date().toISOString().slice(0, 16),
        expiresAt: null,
        status: 'ACTIVE',
        usageLimitTotal: null,
        usageLimitPerCustomer: null,
        firstOrderOnly: false,
        stackable: false,
      });
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to create promotion');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Promotions & Coupons ({promotions.length})
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Manage promotional campaigns, coupon codes, discount scopes, and eligibility rules.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadData} disabled={isLoading}>
            <RefreshCw className={`mr-2 size-4 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowCreateModal(true)}>
            <Plus className="mr-2 size-4" />
            Create Promotion
          </Button>
        </div>
      </div>

      {error && (
        <Alert tone="error">
          <AlertCircle className="size-4" />
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={loadData} className="ml-auto">
            Retry
          </Button>
        </Alert>
      )}

      {/* Analytics KPI Row */}
      {analytics && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="p-4 flex items-center gap-4">
              <div className="rounded-lg bg-primary/10 p-3 text-primary">
                <Tag className="size-6" />
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Total Redemptions</p>
                <p className="text-2xl font-bold">{analytics.totalRedemptions}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-4">
              <div className="rounded-lg bg-success/10 p-3 text-success">
                <DollarSign className="size-6" />
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Total Discount Given</p>
                <p className="text-2xl font-bold">
                  {formatPrice(analytics.totalDiscountAmount, 'USD', 2)}
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-4">
              <div className="rounded-lg bg-info/10 p-3 text-info">
                <TrendingUp className="size-6" />
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Attributed Sales</p>
                <p className="text-2xl font-bold">
                  {formatPrice(analytics.promotionAttributedSales, 'USD', 2)}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Promotion List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active & Scheduled Promotions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : promotions.length === 0 ? (
            <EmptyState
              icon={Tag}
              title="No promotions created yet"
              description="Create platform or merchant promotions and coupons to boost sales and reward customers."
              actionLabel="Create First Promotion"
              onAction={() => setShowCreateModal(true)}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b bg-muted/50 text-xs font-medium uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Promotion Name</th>
                    <th className="px-4 py-3">Coupon Code</th>
                    <th className="px-4 py-3">Discount</th>
                    <th className="px-4 py-3">Scope</th>
                    <th className="px-4 py-3">Usage</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {promotions.map((promo) => (
                    <tr key={promo.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="font-medium">{promo.name}</div>
                        {promo.description && (
                          <div className="text-xs text-muted-foreground truncate max-w-xs">
                            {promo.description}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {promo.code ? (
                          <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-muted border">
                            {promo.code}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">Automatic</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-medium">
                        {promo.discountType === 'PERCENTAGE'
                          ? `${promo.discountValue}% OFF`
                          : `${formatPrice(promo.discountValue, promo.currency, 2)} OFF`}
                        {promo.maxDiscountAmount && (
                          <span className="block text-[11px] text-muted-foreground">
                            Cap: {formatPrice(promo.maxDiscountAmount, promo.currency, 2)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-xs">
                          {promo.scope}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <span className="font-medium">{promo.currentUsageCount}</span>
                        {promo.usageLimitTotal !== null ? ` / ${promo.usageLimitTotal}` : ' uses'}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            promo.status === 'ACTIVE'
                              ? 'success'
                              : promo.status === 'INACTIVE'
                                ? 'warning'
                                : 'outline'
                          }
                        >
                          {promo.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleToggleStatus(promo)}
                          className="h-8 px-2"
                        >
                          {promo.status === 'ACTIVE' ? (
                            <span className="flex items-center text-xs text-destructive">
                              <XCircle className="mr-1 size-3.5" /> Deactivate
                            </span>
                          ) : (
                            <span className="flex items-center text-xs text-success">
                              <CheckCircle className="mr-1 size-3.5" /> Activate
                            </span>
                          )}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Promotion Modal */}
      {showCreateModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-xl rounded-lg border bg-background p-6 shadow-xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold">Create New Promotion</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Configure discount amounts, coupon code, date bounds, and usage constraints.
            </p>

            {formError && (
              <Alert tone="error" className="mt-4">
                <AlertCircle className="size-4" />
                <span>{formError}</span>
              </Alert>
            )}

            <form onSubmit={handleCreateSubmit} className="mt-4 space-y-4">
              <div>
                <Label htmlFor="promo-name">Promotion Name</Label>
                <Input
                  id="promo-name"
                  required
                  placeholder="e.g. Summer Flash Sale"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>

              <div>
                <Label htmlFor="promo-desc">Description (Optional)</Label>
                <Input
                  id="promo-desc"
                  placeholder="e.g. 20% off all summer apparel"
                  value={formData.description ?? ''}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="promo-code">Coupon Code (Optional)</Label>
                  <Input
                    id="promo-code"
                    placeholder="e.g. SUMMER20"
                    value={formData.code ?? ''}
                    onChange={(e) =>
                      setFormData({ ...formData, code: e.target.value.toUpperCase() })
                    }
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Leave empty for automatic discount
                  </span>
                </div>
                <div>
                  <Label htmlFor="promo-scope">Discount Scope</Label>
                  <select
                    id="promo-scope"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                    value={formData.scope}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        scope: e.target.value as 'ORDER' | 'PRODUCT' | 'CATEGORY',
                      })
                    }
                  >
                    <option value="ORDER">Entire Order</option>
                    <option value="PRODUCT">Specific Products</option>
                    <option value="CATEGORY">Specific Categories</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="promo-type">Discount Type</Label>
                  <select
                    id="promo-type"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                    value={formData.discountType}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        discountType: e.target.value as 'PERCENTAGE' | 'FIXED_AMOUNT',
                      })
                    }
                  >
                    <option value="PERCENTAGE">Percentage (%)</option>
                    <option value="FIXED_AMOUNT">Fixed Amount ($)</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="promo-value">
                    {formData.discountType === 'PERCENTAGE'
                      ? 'Percentage Value (1-100%)'
                      : 'Amount (minor units / cents)'}
                  </Label>
                  <Input
                    id="promo-value"
                    type="number"
                    min="1"
                    max={formData.discountType === 'PERCENTAGE' ? '100' : undefined}
                    required
                    value={formData.discountValue}
                    onChange={(e) =>
                      setFormData({ ...formData, discountValue: Number(e.target.value) })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="promo-min">Min Order Subtotal ($ cents)</Label>
                  <Input
                    id="promo-min"
                    type="number"
                    min="0"
                    value={formData.minOrderAmount}
                    onChange={(e) =>
                      setFormData({ ...formData, minOrderAmount: Number(e.target.value) })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="promo-cap">Max Discount Cap ($ cents, optional)</Label>
                  <Input
                    id="promo-cap"
                    type="number"
                    min="1"
                    placeholder="e.g. 5000 for $50 cap"
                    value={formData.maxDiscountAmount ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        maxDiscountAmount: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="promo-starts">Starts At</Label>
                  <Input
                    id="promo-starts"
                    type="datetime-local"
                    required
                    value={formData.startsAt}
                    onChange={(e) => setFormData({ ...formData, startsAt: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="promo-expires">Expires At (Optional)</Label>
                  <Input
                    id="promo-expires"
                    type="datetime-local"
                    value={formData.expiresAt ?? ''}
                    onChange={(e) =>
                      setFormData({ ...formData, expiresAt: e.target.value || null })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="promo-limit-total">Global Usage Limit (Optional)</Label>
                  <Input
                    id="promo-limit-total"
                    type="number"
                    min="1"
                    placeholder="Unlimited"
                    value={formData.usageLimitTotal ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        usageLimitTotal: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="promo-limit-cust">Limit Per Customer (Optional)</Label>
                  <Input
                    id="promo-limit-cust"
                    type="number"
                    min="1"
                    placeholder="Unlimited"
                    value={formData.usageLimitPerCustomer ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        usageLimitPerCustomer: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2 pt-2 border-t">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={formData.firstOrderOnly}
                    onChange={(e) => setFormData({ ...formData, firstOrderOnly: e.target.checked })}
                  />
                  <span>First-time order customers only</span>
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={formData.stackable}
                    onChange={(e) => setFormData({ ...formData, stackable: e.target.checked })}
                  />
                  <span>Stackable with other promotions</span>
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowCreateModal(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Creating…' : 'Save Promotion'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
