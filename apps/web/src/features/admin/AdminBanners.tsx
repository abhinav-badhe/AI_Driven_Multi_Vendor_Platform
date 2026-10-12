import { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Image,
  Plus,
  RefreshCw,
  Trash2,
  ExternalLink,
  CheckCircle2,
  Ban,
  Upload,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import {
  bannersApi,
  type PromotionalBannerDto,
  type CreateBannerPayload,
} from '../banners/api/banners';
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
import { KpiCard } from '../../components/ui/kpi';
import { Table, THead, TH, TD } from '../../components/ui/table';
import { Input, Label } from '../../components/ui/input';
import { cn } from '../../lib/utils';

export const AdminBanners = () => {
  const { user } = useAuth();
  const [banners, setBanners] = useState<PromotionalBannerDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Create Form State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState<CreateBannerPayload>({
    title: '',
    subtitle: '',
    badgeText: 'SPECIAL SALE',
    imageUrl: '',
    targetUrl: '/search',
    displayOrder: 1,
    isActive: true,
  });

  const loadBanners = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await bannersApi.getAllBanners();
      setBanners(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load banners');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role !== 'ADMINISTRATOR') return;
    loadBanners();
  }, [user]);

  if (user?.role !== 'ADMINISTRATOR') return <Navigate to="/account" replace />;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('Please upload a valid JPG or PNG image file.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setFormData((prev) => ({ ...prev, imageUrl: reader.result as string }));
      }
    };
    reader.readAsDataURL(file);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title.trim() || !formData.imageUrl.trim()) {
      alert('Title and Image are required.');
      return;
    }

    setIsSubmitting(true);
    try {
      await bannersApi.createBanner({
        ...formData,
        title: formData.title.trim(),
        subtitle: formData.subtitle?.trim() || undefined,
        badgeText: formData.badgeText?.trim() || undefined,
        targetUrl: formData.targetUrl?.trim() || '/search',
      });
      setFeedback('Promotional hero poster created successfully!');
      setTimeout(() => setFeedback(null), 4000);
      setShowCreateModal(false);
      setFormData({
        title: '',
        subtitle: '',
        badgeText: 'SPECIAL SALE',
        imageUrl: '',
        targetUrl: '/search',
        displayOrder: 1,
        isActive: true,
      });
      await loadBanners();
    } catch (err: unknown) {
      alert(`Failed to create banner: ${err instanceof Error ? err.message : 'Error'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleStatus = async (banner: PromotionalBannerDto) => {
    try {
      await bannersApi.updateBanner(banner.id, { isActive: !banner.is_active });
      await loadBanners();
    } catch (err: unknown) {
      alert(`Failed to update banner: ${err instanceof Error ? err.message : 'Error'}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this promotional banner?')) return;
    try {
      await bannersApi.deleteBanner(id);
      setFeedback('Banner deleted.');
      setTimeout(() => setFeedback(null), 3000);
      await loadBanners();
    } catch (err: unknown) {
      alert(`Delete failed: ${err instanceof Error ? err.message : 'Error'}`);
    }
  };

  const activeCount = banners.filter((b) => b.is_active).length;

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Hero Promotional Posters &amp; Banners
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Manage promotional sale posters displayed on the customer storefront homepage.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={loadBanners} disabled={isLoading}>
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', isLoading && 'animate-spin')} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowCreateModal(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add Sale Poster
          </Button>
        </div>
      </div>

      {feedback && (
        <Alert tone="success" title="Success">
          {feedback}
        </Alert>
      )}

      {error && (
        <Alert tone="error" title="Could not load banners">
          {error}
        </Alert>
      )}

      {/* Bento KPIs matching Merchant Panel */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Active customer posters</p>
            <p className="tnum mt-1 text-2xl font-semibold tracking-tight text-emerald-600">
              {activeCount} live
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Displayed on the customer homepage billboard
            </p>
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
          <KpiCard label="Total posters" value={String(banners.length)} hint="configured" />
          <KpiCard label="File formats" value="JPG / PNG" hint="high-res hero" />
          <KpiCard label="Target landing" value="Catalog &amp; Sales" hint="seamless navigation" />
        </div>
      </div>

      {/* Create / Upload Modal */}
      {showCreateModal && (
        <Card className="border-primary/40 bg-muted/20">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Add promotional hero poster</CardTitle>
                <CardDescription>
                  Upload a JPG/PNG sale billboard poster for the customer homepage
                </CardDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setShowCreateModal(false)}>
                Cancel
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreateSubmit} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="b-title">Sale campaign title *</Label>
                  <Input
                    id="b-title"
                    required
                    placeholder="e.g. FESTIVE MEGA SALE"
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="b-badge">Badge text</Label>
                  <Input
                    id="b-badge"
                    placeholder="e.g. LIMITED TIME OFFER / 40% OFF"
                    value={formData.badgeText || ''}
                    onChange={(e) => setFormData({ ...formData, badgeText: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="b-sub">Subtitle / Promotional offer</Label>
                  <Input
                    id="b-sub"
                    placeholder="e.g. Up to 40% OFF on Top Laptops, Audio Gear & Accessories"
                    value={formData.subtitle || ''}
                    onChange={(e) => setFormData({ ...formData, subtitle: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="b-target">Click destination URL</Label>
                  <Input
                    id="b-target"
                    placeholder="e.g. /search or /category/electronics"
                    value={formData.targetUrl || ''}
                    onChange={(e) => setFormData({ ...formData, targetUrl: e.target.value })}
                  />
                </div>
              </div>

              {/* Poster File Upload or Image URL */}
              <div className="space-y-2 rounded-md border border-dashed border-border p-3">
                <Label className="text-xs font-semibold">Poster JPG image source *</Label>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted">
                    <Upload className="h-3.5 w-3.5" />
                    Upload .jpg / .png file
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                  </label>
                  <span className="text-xs text-muted-foreground">or paste image link:</span>
                  <Input
                    placeholder="https://.../poster.jpg"
                    className="h-8 flex-1 text-xs min-w-[200px]"
                    value={formData.imageUrl}
                    onChange={(e) => setFormData({ ...formData, imageUrl: e.target.value })}
                  />
                </div>

                {formData.imageUrl && (
                  <div className="mt-2 overflow-hidden rounded-md border border-border">
                    <p className="bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
                      Live Preview:
                    </p>
                    <div className="relative aspect-[21/9] w-full max-h-48 overflow-hidden bg-black/5">
                      <img
                        src={formData.imageUrl}
                        alt="Preview"
                        className="h-full w-full object-cover"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent p-3 flex flex-col justify-end text-white">
                        {formData.badgeText && (
                          <span className="mb-1 inline-block w-fit rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                            {formData.badgeText}
                          </span>
                        )}
                        <h4 className="text-sm font-bold tracking-tight">
                          {formData.title || 'Poster Title'}
                        </h4>
                        {formData.subtitle && (
                          <p className="text-xs text-white/80">{formData.subtitle}</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={isSubmitting || !formData.title || !formData.imageUrl}
                >
                  {isSubmitting ? 'Saving poster…' : 'Publish poster to storefront'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Main Table Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Configured hero posters</CardTitle>
              <CardDescription>
                Posters active in the storefront hero billboard carousel
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2 py-4">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : banners.length === 0 ? (
            <EmptyState
              icon={Image}
              title="No promotional posters"
              description="Add your first sale poster above to display an attractive hero billboard on the customer homepage."
              actionLabel="Add sale poster"
              onAction={() => setShowCreateModal(true)}
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Poster Preview</TH>
                  <TH>Campaign &amp; Subtitle</TH>
                  <TH>Badge Tag</TH>
                  <TH>Destination</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Actions</TH>
                </tr>
              </THead>
              <tbody>
                {banners.map((b) => (
                  <tr key={b.id}>
                    <TD className="w-32">
                      <div className="aspect-[16/9] w-28 overflow-hidden rounded border bg-muted">
                        <img
                          src={b.image_url}
                          alt={b.title}
                          className="h-full w-full object-cover"
                        />
                      </div>
                    </TD>
                    <TD>
                      <div className="font-semibold text-xs">{b.title}</div>
                      {b.subtitle && (
                        <div className="text-[11px] text-muted-foreground">{b.subtitle}</div>
                      )}
                    </TD>
                    <TD>
                      {b.badge_text ? (
                        <Badge variant="outline" className="text-[10px]">
                          {b.badge_text}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TD>
                    <TD className="text-xs font-mono text-muted-foreground">
                      <a
                        href={b.target_url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 hover:text-primary"
                      >
                        {b.target_url}
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    </TD>
                    <TD>
                      <Badge variant={b.is_active ? 'success' : 'outline'}>
                        {b.is_active ? 'Active on Storefront' : 'Inactive'}
                      </Badge>
                    </TD>
                    <TD className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => handleToggleStatus(b)}
                        >
                          {b.is_active ? (
                            <>
                              <Ban className="mr-1 h-3 w-3 text-destructive" />
                              Turn off
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="mr-1 h-3 w-3 text-emerald-600" />
                              Turn on
                            </>
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(b.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
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
