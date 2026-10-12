import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ImagePlus, PackagePlus, PackageSearch, Pencil, Plus, Search } from 'lucide-react';
import { merchantApi, type MerchantListingDetailDto } from './api/merchant';
import { catalogApi, type Product } from '../catalog/api/catalog';
import { Button, buttonVariants } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Alert } from '../../components/ui/alert';
import { EmptyState, Skeleton } from '../../components/ui/empty';
import { Input, Label } from '../../components/ui/input';
import { Rating } from '../../components/product/display';
import { formatMoney } from '../../lib/format';
import { cn } from '../../lib/utils';

type StatusFilter = 'ALL' | MerchantListingDetailDto['status'];

const statusVariant = (s: MerchantListingDetailDto['status']) =>
  s === 'ACTIVE'
    ? ('success' as const)
    : s === 'DRAFT'
      ? ('outline' as const)
      : ('warning' as const);

export const MerchantListings = () => {
  const [listings, setListings] = useState<MerchantListingDetailDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [actionId, setActionId] = useState<string | null>(null);

  // Inline price editor
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPrice, setEditPrice] = useState('');
  const [editCompare, setEditCompare] = useState('');

  // Add modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [addMode, setAddMode] = useState<'existing' | 'new'>('existing');
  const [catalogProducts, setCatalogProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
  const [skus, setSkus] = useState<Array<{ id: string; skuCode: string }>>([]);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [selectedSkuId, setSelectedSkuId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newBrand, setNewBrand] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newCategoryId, setNewCategoryId] = useState('');
  const [newThumbnail, setNewThumbnail] = useState('');
  const [newImages, setNewImages] = useState('');
  const [newWarranty, setNewWarranty] = useState('');
  const [newShipping, setNewShipping] = useState('');
  const [newReturns, setNewReturns] = useState('');
  const [newSkuCode, setNewSkuCode] = useState('');
  const [priceMajor, setPriceMajor] = useState('');
  const [compareMajor, setCompareMajor] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [initialStock, setInitialStock] = useState('10');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchListings = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await merchantApi.getMyListingDetails();
      setListings(Array.isArray(data) ? data : []);
      const firstCurrency = data.find((d) => d.currency)?.currency;
      if (firstCurrency) setCurrency(firstCurrency);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load listings.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchListings();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return listings.filter((l) => {
      if (statusFilter !== 'ALL' && l.status !== statusFilter) return false;
      if (!q) return true;
      return (
        l.productTitle.toLowerCase().includes(q) ||
        (l.brand ?? '').toLowerCase().includes(q) ||
        l.skuCode.toLowerCase().includes(q)
      );
    });
  }, [listings, query, statusFilter]);

  const flashSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 4000);
  };

  const handleToggleStatus = async (l: MerchantListingDetailDto) => {
    setActionId(l.id);
    try {
      await merchantApi.updateListingStatus(l.id, l.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE');
      flashSuccess(`“${l.productTitle}” is now ${l.status === 'ACTIVE' ? 'inactive' : 'active'}.`);
      await fetchListings();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Status update failed.');
    } finally {
      setActionId(null);
    }
  };

  const openPriceEditor = (l: MerchantListingDetailDto) => {
    setEditingId(l.id);
    setEditPrice((l.priceAmount / 100).toString());
    setEditCompare(l.compareAtPrice ? (l.compareAtPrice / 100).toString() : '');
  };

  const handleSavePrice = async (l: MerchantListingDetailDto) => {
    const priceAmount = Math.round(parseFloat(editPrice) * 100);
    if (!Number.isFinite(priceAmount) || priceAmount < 0) {
      setError('Enter a valid price of 0 or more.');
      return;
    }
    const compareAtPrice =
      editCompare.trim() === '' ? null : Math.round(parseFloat(editCompare) * 100);
    if (compareAtPrice !== null && (!Number.isFinite(compareAtPrice) || compareAtPrice < 0)) {
      setError('Enter a valid compare-at price, or leave it empty.');
      return;
    }
    setActionId(l.id);
    try {
      await merchantApi.updateListingPrice(l.id, { priceAmount, compareAtPrice });
      setEditingId(null);
      flashSuccess(`Price updated for “${l.productTitle}”.`);
      await fetchListings();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Price update failed.');
    } finally {
      setActionId(null);
    }
  };

  const openAddModal = async () => {
    setShowAddModal(true);
    setError(null);
    try {
      const [prods, cats] = await Promise.all([
        merchantApi.getCatalogProducts().catch(() => []),
        merchantApi.getCategories().catch(() => []),
      ]);
      const full = await catalogApi.getProducts({ limit: 100 }).catch(() => []);
      setCatalogProducts(full.length > 0 ? full : (prods as Product[]));
      setCategories(cats);
      const first = (full.length > 0 ? full : prods)[0];
      if (first) {
        setSelectedProductId(first.id);
        const skuList = await merchantApi.getProductSkus(first.id).catch(() => []);
        setSkus(skuList);
        if (skuList[0]) setSelectedSkuId(skuList[0].id);
      }
      if (cats[0]) setNewCategoryId(cats[0].id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load catalog.');
    }
  };

  const handleProductChange = async (prodId: string) => {
    setSelectedProductId(prodId);
    try {
      const skuList = await merchantApi.getProductSkus(prodId);
      setSkus(skuList);
      setSelectedSkuId(skuList[0]?.id ?? '');
    } catch {
      setSkus([]);
      setSelectedSkuId('');
    }
  };

  const parseImages = (raw: string): string[] =>
    raw
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const handleAddSubmit = async (publishImmediately: boolean) => {
    setIsSubmitting(true);
    setError(null);
    try {
      const priceAmount = Math.round(parseFloat(priceMajor) * 100);
      if (!Number.isFinite(priceAmount) || priceAmount <= 0) {
        throw new Error('Enter a selling price greater than 0.');
      }
      let effectiveSkuId = selectedSkuId;

      if (addMode === 'new') {
        if (!newTitle.trim()) throw new Error('Product title is required.');
        if (!newSkuCode.trim()) throw new Error('SKU code is required.');
        const slug =
          newTitle
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '') +
          '-' +
          Date.now().toString(36);
        const images = parseImages(newImages);
        const thumbnail = newThumbnail.trim() || images[0] || undefined;
        const prod = await merchantApi.createProduct({
          title: newTitle.trim(),
          slug,
          ...(newDescription.trim() ? { description: newDescription.trim() } : {}),
          ...(newBrand.trim() ? { brand: newBrand.trim() } : {}),
          ...(newCategoryId ? { categoryId: newCategoryId } : {}),
          ...(thumbnail ? { thumbnailUrl: thumbnail } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(newWarranty.trim() || newShipping.trim() || newReturns.trim()
            ? {
                attributes: {
                  ...(newWarranty.trim() ? { warrantyInformation: newWarranty.trim() } : {}),
                  ...(newShipping.trim() ? { shippingInformation: newShipping.trim() } : {}),
                  ...(newReturns.trim() ? { returnPolicy: newReturns.trim() } : {}),
                },
              }
            : {}),
        });
        const createdSku = await merchantApi.createSku(prod.id, {
          skuCode: newSkuCode.trim().toUpperCase(),
        });
        try {
          await merchantApi.updateProductStatus(prod.id, 'ACTIVE');
          await merchantApi.updateSkuStatus(createdSku.id, 'ACTIVE');
        } catch {
          // Activation is best-effort here; the listing flow continues.
        }
        effectiveSkuId = createdSku.id;
      }

      if (!effectiveSkuId) throw new Error('Choose a variant to list.');

      const compareAtPrice =
        compareMajor.trim() === '' ? null : Math.round(parseFloat(compareMajor) * 100);
      const listing = await merchantApi.createListing({
        skuId: effectiveSkuId,
        priceAmount,
        currency,
        compareAtPrice,
      });

      const stockQty = parseInt(initialStock, 10);
      if (Number.isFinite(stockQty) && stockQty > 0) {
        try {
          await merchantApi.initInventory({
            listingId: listing.id,
            initialOnHandQuantity: stockQty,
          });
        } catch {
          // Inventory may already exist for this listing.
        }
      }

      if (publishImmediately) {
        await merchantApi.updateListingStatus(listing.id, 'ACTIVE');
      }

      flashSuccess(`Listing ${publishImmediately ? 'published' : 'saved as draft'}.`);
      setShowAddModal(false);
      resetForm();
      await fetchListings();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save listing.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setPriceMajor('');
    setCompareMajor('');
    setInitialStock('10');
    setNewTitle('');
    setNewBrand('');
    setNewDescription('');
    setNewThumbnail('');
    setNewImages('');
    setNewWarranty('');
    setNewShipping('');
    setNewReturns('');
    setNewSkuCode('');
  };

  const selectedProduct = catalogProducts.find((p) => p.id === selectedProductId);

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Listings ({listings.length})</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Your offers with live prices and stock levels.
          </p>
        </div>
        <Button size="sm" onClick={openAddModal}>
          <Plus aria-hidden />
          Add product / listing
        </Button>
      </div>

      {successMsg && <Alert tone="success">{successMsg}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 max-w-xs flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by product, brand, or SKU"
            aria-label="Search listings"
            className="pl-8"
          />
        </div>
        <div className="flex gap-1" role="group" aria-label="Filter by status">
          {(['ALL', 'ACTIVE', 'DRAFT', 'INACTIVE'] as StatusFilter[]).map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatusFilter(s)}
            >
              {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading listings">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={PackageSearch}
          title={listings.length === 0 ? 'No listings yet' : 'No listings match'}
          description={
            listings.length === 0
              ? 'List an existing catalog product or add a new one to start selling.'
              : 'Try a different search or status filter.'
          }
          actionLabel={listings.length === 0 ? 'Add your first listing' : undefined}
          onAction={listings.length === 0 ? openAddModal : undefined}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((l) => {
            const off =
              l.compareAtPrice && l.compareAtPrice > l.priceAmount
                ? Math.round((1 - l.priceAmount / l.compareAtPrice) * 100)
                : null;
            return (
              <Card key={l.id}>
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex gap-3">
                    {l.thumbnailUrl ? (
                      <img
                        src={l.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        className="size-16 shrink-0 rounded-md border border-border object-cover"
                      />
                    ) : (
                      <span className="flex size-16 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                        <ImagePlus className="size-5 text-muted-foreground" aria-hidden />
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{l.productTitle}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        {l.brand && <span>{l.brand}</span>}
                        <Rating rating={l.rating} reviewCount={l.reviewCount} />
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">{l.skuCode}</p>
                    </div>
                    <Badge
                      variant={statusVariant(l.status)}
                      className="ml-auto shrink-0 self-start"
                    >
                      {l.status}
                    </Badge>
                  </div>

                  <div className="flex items-baseline gap-2">
                    <p className="tnum text-base font-semibold">
                      {formatMoney(l.priceAmount / 100, l.currency)}
                    </p>
                    {l.compareAtPrice && l.compareAtPrice > l.priceAmount && (
                      <p className="tnum text-xs text-muted-foreground line-through">
                        {formatMoney(l.compareAtPrice / 100, l.currency)}
                      </p>
                    )}
                    {off != null && <Badge variant="warning">{off}% off</Badge>}
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {l.availableQuantity == null ? (
                      'No stock record yet'
                    ) : l.availableQuantity <= 0 ? (
                      <span className="font-medium text-destructive">Out of stock</span>
                    ) : l.availableQuantity <= 5 ? (
                      <span className="font-medium text-warning-foreground">
                        Low stock · {l.availableQuantity} left
                      </span>
                    ) : (
                      <span className="tnum">In stock · {l.availableQuantity} units</span>
                    )}
                  </p>

                  {editingId === l.id ? (
                    <div className="flex flex-col gap-2 rounded-md bg-muted p-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="flex flex-col gap-1">
                          <Label htmlFor={`price-${l.id}`}>Price ({l.currency})</Label>
                          <Input
                            id={`price-${l.id}`}
                            type="number"
                            min="0"
                            step="0.01"
                            value={editPrice}
                            onChange={(e) => setEditPrice(e.target.value)}
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <Label htmlFor={`compare-${l.id}`}>Compare at</Label>
                          <Input
                            id={`compare-${l.id}`}
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="Empty = none"
                            value={editCompare}
                            onChange={(e) => setEditCompare(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="flex justify-end gap-1.5">
                        <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          disabled={actionId === l.id}
                          onClick={() => handleSavePrice(l)}
                        >
                          {actionId === l.id ? 'Saving…' : 'Save price'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-1.5 border-t border-border pt-2.5">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={actionId === l.id}
                        onClick={() => handleToggleStatus(l)}
                      >
                        {l.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openPriceEditor(l)}>
                        <Pencil aria-hidden />
                        Price
                      </Button>
                      <Link
                        to="/merchant/inventory"
                        className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'ml-auto')}
                      >
                        Stock
                      </Link>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {showAddModal && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowAddModal(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Add product or listing"
            className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-md"
          >
            <h2 className="text-sm font-semibold">Add product / listing</h2>
            <div
              className="mt-3 flex gap-1 rounded-md bg-muted p-1"
              role="tablist"
              aria-label="Add mode"
            >
              {(
                [
                  { id: 'existing', label: 'Existing product' },
                  { id: 'new', label: 'New product' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={addMode === m.id}
                  onClick={() => setAddMode(m.id)}
                  className={cn(
                    'flex-1 rounded px-2 py-1.5 text-[13px] font-medium',
                    addMode === m.id ? 'bg-background shadow-sm' : 'text-muted-foreground',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="mt-3 flex flex-col gap-3">
              {addMode === 'existing' ? (
                <>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="add-product">Product</Label>
                    <select
                      id="add-product"
                      value={selectedProductId}
                      onChange={(e) => handleProductChange(e.target.value)}
                      className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:border-ring"
                    >
                      {catalogProducts.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title} {p.brand ? `· ${p.brand}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  {selectedProduct?.thumbnailUrl && (
                    <div className="flex items-center gap-2 rounded-md border border-border p-2">
                      <img
                        src={selectedProduct.thumbnailUrl}
                        alt=""
                        className="size-12 rounded border border-border object-cover"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium">{selectedProduct.title}</p>
                        <Rating
                          rating={selectedProduct.rating}
                          reviewCount={selectedProduct.reviewCount}
                        />
                      </div>
                    </div>
                  )}
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="add-sku">Variant (SKU)</Label>
                    <select
                      id="add-sku"
                      value={selectedSkuId}
                      onChange={(e) => setSelectedSkuId(e.target.value)}
                      className="h-8 rounded-md border border-input bg-background px-2.5 font-mono text-xs outline-none focus-visible:border-ring"
                    >
                      {skus.length === 0 ? (
                        <option value="">No variants for this product</option>
                      ) : (
                        skus.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.skuCode}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="new-title">Title</Label>
                    <Input
                      id="new-title"
                      placeholder="e.g. Wireless Ergonomic Keyboard"
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="new-brand">Brand</Label>
                      <Input
                        id="new-brand"
                        placeholder="e.g. Keychron"
                        value={newBrand}
                        onChange={(e) => setNewBrand(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="new-category">Category</Label>
                      <select
                        id="new-category"
                        value={newCategoryId}
                        onChange={(e) => setNewCategoryId(e.target.value)}
                        className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:border-ring"
                      >
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="new-desc">Description</Label>
                    <textarea
                      id="new-desc"
                      rows={2}
                      placeholder="What makes this product worth buying?"
                      value={newDescription}
                      onChange={(e) => setNewDescription(e.target.value)}
                      className="rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:border-ring"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="new-thumb">Thumbnail image URL</Label>
                    <Input
                      id="new-thumb"
                      type="url"
                      placeholder="https://…/thumbnail.webp"
                      value={newThumbnail}
                      onChange={(e) => setNewThumbnail(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="new-images">More image URLs (one per line)</Label>
                    <textarea
                      id="new-images"
                      rows={2}
                      placeholder={'https://…/1.webp\nhttps://…/2.webp'}
                      value={newImages}
                      onChange={(e) => setNewImages(e.target.value)}
                      className="rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="new-warranty">Warranty</Label>
                      <Input
                        id="new-warranty"
                        placeholder="1 year warranty"
                        value={newWarranty}
                        onChange={(e) => setNewWarranty(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="new-shipping">Shipping</Label>
                      <Input
                        id="new-shipping"
                        placeholder="Ships in 2 days"
                        value={newShipping}
                        onChange={(e) => setNewShipping(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="new-returns">Returns</Label>
                      <Input
                        id="new-returns"
                        placeholder="7 days return policy"
                        value={newReturns}
                        onChange={(e) => setNewReturns(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="new-sku">SKU code</Label>
                    <Input
                      id="new-sku"
                      placeholder="e.g. KBN-ERG-BLK"
                      value={newSkuCode}
                      onChange={(e) => setNewSkuCode(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                </>
              )}

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="add-price">Price</Label>
                  <Input
                    id="add-price"
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    placeholder="49.99"
                    value={priceMajor}
                    onChange={(e) => setPriceMajor(e.target.value)}
                    className="tnum"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="add-compare">Compare at</Label>
                  <Input
                    id="add-compare"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Optional"
                    value={compareMajor}
                    onChange={(e) => setCompareMajor(e.target.value)}
                    className="tnum"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="add-currency">Currency</Label>
                  <select
                    id="add-currency"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:border-ring"
                  >
                    <option value="USD">USD ($)</option>
                    <option value="INR">INR (₹)</option>
                    <option value="EUR">EUR (€)</option>
                  </select>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="add-stock">Opening stock</Label>
                <Input
                  id="add-stock"
                  type="number"
                  min="0"
                  step="1"
                  value={initialStock}
                  onChange={(e) => setInitialStock(e.target.value)}
                  className="tnum max-w-32"
                />
              </div>

              <div className="flex justify-end gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting}
                  onClick={() => handleAddSubmit(false)}
                >
                  Save as draft
                </Button>
                <Button size="sm" disabled={isSubmitting} onClick={() => handleAddSubmit(true)}>
                  <PackagePlus aria-hidden />
                  {isSubmitting ? 'Publishing…' : 'Publish listing'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
