import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { merchantApi, type MerchantListingDto } from './api/merchant';

interface CatalogProductOption {
  id: string;
  title: string;
  brand?: string;
}

interface SkuOption {
  id: string;
  skuCode: string;
}

interface CategoryOption {
  id: string;
  name: string;
}

export const MerchantListings = () => {
  const [listings, setListings] = useState<MerchantListingDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Modal State for Add Product / Listing
  const [showAddModal, setShowAddModal] = useState(false);
  const [addMode, setAddMode] = useState<'existing' | 'new'>('existing');
  const [catalogProducts, setCatalogProducts] = useState<CatalogProductOption[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [skus, setSkus] = useState<SkuOption[]>([]);

  // Form Fields
  const [selectedProductId, setSelectedProductId] = useState('');
  const [selectedSkuId, setSelectedSkuId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newBrand, setNewBrand] = useState('');
  const [newCategoryId, setNewCategoryId] = useState('');
  const [newSkuCode, setNewSkuCode] = useState('');
  const [priceRupees, setPriceRupees] = useState('');
  const [comparePriceRupees, setComparePriceRupees] = useState('');
  const [initialStock, setInitialStock] = useState('10');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionListingId, setActionListingId] = useState<string | null>(null);

  const fetchListings = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await merchantApi.getMyListings();
      setListings(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch listings');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchListings();
  }, []);

  const openAddModal = async () => {
    setShowAddModal(true);
    setError(null);
    try {
      const [prods, cats] = await Promise.all([
        merchantApi.getCatalogProducts().catch(() => []),
        merchantApi.getCategories().catch(() => []),
      ]);
      setCatalogProducts(prods);
      setCategories(cats);
      if (prods.length > 0 && prods[0]) {
        setSelectedProductId(prods[0].id);
        const skuList = await merchantApi.getProductSkus(prods[0].id).catch(() => []);
        setSkus(skuList);
        if (skuList.length > 0 && skuList[0]) {
          setSelectedSkuId(skuList[0].id);
        }
      }
      if (cats.length > 0 && cats[0]) {
        setNewCategoryId(cats[0].id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load catalog data');
    }
  };

  const handleProductChange = async (prodId: string) => {
    setSelectedProductId(prodId);
    try {
      const skuList = await merchantApi.getProductSkus(prodId);
      setSkus(skuList);
      if (skuList.length > 0 && skuList[0]) {
        setSelectedSkuId(skuList[0].id);
      } else {
        setSelectedSkuId('');
      }
    } catch {
      setSkus([]);
      setSelectedSkuId('');
    }
  };

  const handleAddSubmit = async (publishImmediately: boolean) => {
    setIsSubmitting(true);
    setError(null);
    try {
      const priceAmount = Math.round(parseFloat(priceRupees) * 100);
      if (isNaN(priceAmount) || priceAmount <= 0) {
        throw new Error('Please enter a valid selling price greater than 0');
      }

      let effectiveSkuId = selectedSkuId;

      if (addMode === 'new') {
        if (!newTitle.trim()) throw new Error('Product title is required');
        if (!newSkuCode.trim()) throw new Error('SKU code is required');

        const slug = newTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36);
        const prod = await merchantApi.createProduct({
          title: newTitle.trim(),
          slug,
          ...(newBrand.trim() ? { brand: newBrand.trim() } : {}),
          ...(newCategoryId ? { categoryId: newCategoryId } : {}),
        });

        const createdSku = await merchantApi.createSku(prod.id, {
          skuCode: newSkuCode.trim().toUpperCase(),
        });
        try {
          await merchantApi.updateProductStatus(prod.id, 'ACTIVE');
          await merchantApi.updateSkuStatus(createdSku.id, 'ACTIVE');
        } catch {
          // Status updates are handled if permitted
        }
        effectiveSkuId = createdSku.id;
      }

      if (!effectiveSkuId) {
        throw new Error('No SKU selected or created for this listing');
      }

      const compareAtPrice = comparePriceRupees ? Math.round(parseFloat(comparePriceRupees) * 100) : null;

      // 1. Create Merchant Listing
      const listing = await merchantApi.createListing({
        skuId: effectiveSkuId,
        priceAmount,
        currency: 'INR',
        compareAtPrice,
      });

      // 2. Initialize Inventory if quantity > 0
      const stockQty = parseInt(initialStock, 10);
      if (!isNaN(stockQty) && stockQty > 0) {
        try {
          await merchantApi.initInventory({
            listingId: listing.id,
            initialOnHandQuantity: stockQty,
          });
        } catch {
          // Inventory may already be initialized
        }
      }

      // 3. Publish Listing if requested
      if (publishImmediately) {
        await merchantApi.updateListingStatus(listing.id, 'ACTIVE');
      }

      setSuccessMsg(`Listing ${publishImmediately ? 'published' : 'saved as draft'} successfully!`);
      setShowAddModal(false);
      resetForm();
      await fetchListings();
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save product listing');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleStatus = async (l: MerchantListingDto) => {
    setActionListingId(l.id);
    const nextStatus = l.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      await merchantApi.updateListingStatus(l.id, nextStatus);
      setSuccessMsg(`Listing status changed to ${nextStatus}`);
      await fetchListings();
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: unknown) {
      alert(`Status update failed: ${err instanceof Error ? err.message : 'Error'}`);
    } finally {
      setActionListingId(null);
    }
  };

  const resetForm = () => {
    setPriceRupees('');
    setComparePriceRupees('');
    setInitialStock('10');
    setNewTitle('');
    setNewBrand('');
    setNewSkuCode('');
  };

  return (
    <div className="container" style={{ padding: '2rem 1rem 4rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 className="font-display" style={{ fontSize: '2rem', marginBottom: '0.25rem' }}>
            Merchant Product Listings
          </h1>
          <p className="text-muted">
            Manage your commercial offers, selling prices, and multi-vendor product bindings.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button type="button" className="btn btn-primary" onClick={openAddModal}>
            + Add Product / Listing
          </button>
          <Link to="/merchant" className="btn btn-secondary">
            &larr; Back to Dashboard
          </Link>
        </div>
      </div>

      {successMsg && (
        <div className="card" style={{ borderColor: 'var(--accent-green)', background: 'rgba(34, 197, 94, 0.1)', color: 'var(--accent-green)', padding: '1rem', marginBottom: '1.5rem' }}>
          {successMsg}
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)', padding: '1rem', marginBottom: '1.5rem' }}>
          {error}
        </div>
      )}

      {isLoading ? (
        <p className="text-muted" style={{ textAlign: 'center', padding: '3rem' }}>Loading listings...</p>
      ) : listings.length === 0 ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
          <h3 style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>No Listings Created Yet</h3>
          <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
            Select an existing catalog item or introduce a new product to start selling.
          </p>
          <button type="button" className="btn btn-primary" onClick={openAddModal}>
            Create Your First Listing
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.5rem' }}>
          {listings.map((l) => (
            <div key={l.id} className="card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>ID: {l.id.slice(0, 10)}</span>
                  <span style={{
                    background: l.status === 'ACTIVE' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                    color: l.status === 'ACTIVE' ? 'var(--accent-green)' : 'var(--accent-red)',
                    padding: '0.2rem 0.6rem',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    fontWeight: 700,
                  }}>
                    {l.status}
                  </span>
                </div>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                  SKU: {l.skuId.slice(0, 14)}
                </h3>
              </div>

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem', marginTop: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--brand)' }}>
                    ₹{(l.priceAmount / 100).toLocaleString('en-IN')}
                  </div>
                  {l.compareAtPrice && l.compareAtPrice > l.priceAmount && (
                    <div style={{ fontSize: '0.85rem', color: 'var(--primary-muted)', textDecoration: 'line-through' }}>
                      ₹{(l.compareAtPrice / 100).toLocaleString('en-IN')}
                    </div>
                  )}
                </div>

                <div style={{ fontSize: '0.75rem', color: 'var(--primary-muted)', marginTop: '0.5rem' }}>
                  Updated: {new Date(l.updatedAt).toLocaleDateString()}
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ flex: 1, fontSize: '0.8rem', padding: '0.4rem 0.5rem' }}
                    disabled={actionListingId === l.id}
                    onClick={() => handleToggleStatus(l)}
                  >
                    {l.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                  </button>
                  <Link
                    to="/merchant/inventory"
                    className="btn btn-secondary"
                    style={{ fontSize: '0.8rem', padding: '0.4rem 0.6rem' }}
                  >
                    Stock
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Product / Listing Modal */}
      {showAddModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '1rem',
        }}>
          <div className="card" style={{ maxWidth: '540px', width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Add Product / Listing</h2>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--primary-muted)', fontSize: '1.5rem', cursor: 'pointer' }}
              >
                &times;
              </button>
            </div>

            {/* Mode Selector */}
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', background: 'var(--bg-main)', padding: '0.35rem', borderRadius: '8px' }}>
              <button
                type="button"
                onClick={() => setAddMode('existing')}
                style={{
                  flex: 1,
                  padding: '0.5rem',
                  borderRadius: '6px',
                  border: 'none',
                  background: addMode === 'existing' ? 'var(--bg-card)' : 'transparent',
                  color: addMode === 'existing' ? 'var(--brand)' : 'var(--primary-muted)',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Existing Catalog Item
              </button>
              <button
                type="button"
                onClick={() => setAddMode('new')}
                style={{
                  flex: 1,
                  padding: '0.5rem',
                  borderRadius: '6px',
                  border: 'none',
                  background: addMode === 'new' ? 'var(--bg-card)' : 'transparent',
                  color: addMode === 'new' ? 'var(--brand)' : 'var(--primary-muted)',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Introduce New Product
              </button>
            </div>

            <form onSubmit={(e) => { e.preventDefault(); handleAddSubmit(true); }}>
              {addMode === 'existing' ? (
                <>
                  <div style={{ marginBottom: '1rem' }}>
                    <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.35rem', color: 'var(--primary-muted)' }}>
                      Select Canonical Product:
                    </label>
                    <select
                      value={selectedProductId}
                      onChange={(e) => handleProductChange(e.target.value)}
                      style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-main)', color: 'var(--text-main)' }}
                    >
                      {catalogProducts.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title} {p.brand ? `(${p.brand})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div style={{ marginBottom: '1rem' }}>
                    <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.35rem', color: 'var(--primary-muted)' }}>
                      Select SKU / Variant:
                    </label>
                    <select
                      value={selectedSkuId}
                      onChange={(e) => setSelectedSkuId(e.target.value)}
                      style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-main)', color: 'var(--text-main)' }}
                    >
                      {skus.length === 0 ? (
                        <option value="">No SKUs available for this product</option>
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
                  <div style={{ marginBottom: '1rem' }}>
                    <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.35rem', color: 'var(--primary-muted)' }}>
                      Product Title:
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Wireless Ergonomic Keyboard"
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-main)', color: 'var(--text-main)' }}
                    />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.35rem', color: 'var(--primary-muted)' }}>
                        Brand:
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. Keychron"
                        value={newBrand}
                        onChange={(e) => setNewBrand(e.target.value)}
                        style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-main)', color: 'var(--text-main)' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.35rem', color: 'var(--primary-muted)' }}>
                        Category:
                      </label>
                      <select
                        value={newCategoryId}
                        onChange={(e) => setNewCategoryId(e.target.value)}
                        style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-main)', color: 'var(--text-main)' }}
                      >
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ marginBottom: '1rem' }}>
                    <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.35rem', color: 'var(--primary-muted)' }}>
                      SKU Code:
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. KBN-ERG-BLK"
                      value={newSkuCode}
                      onChange={(e) => setNewSkuCode(e.target.value)}
                      style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-main)', color: 'var(--text-main)' }}
                    />
                  </div>
                </>
              )}

              {/* Pricing & Initial Inventory */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.35rem', color: 'var(--primary-muted)' }}>
                    Seller Price (₹):
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="1"
                    required
                    placeholder="2499.00"
                    value={priceRupees}
                    onChange={(e) => setPriceRupees(e.target.value)}
                    style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-main)', color: 'var(--text-main)' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.35rem', color: 'var(--primary-muted)' }}>
                    Compare Price (₹):
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Optional MRP"
                    value={comparePriceRupees}
                    onChange={(e) => setComparePriceRupees(e.target.value)}
                    style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-main)', color: 'var(--text-main)' }}
                  />
                </div>
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.35rem', color: 'var(--primary-muted)' }}>
                  Initial Stock Quantity:
                </label>
                <input
                  type="number"
                  min="0"
                  required
                  value={initialStock}
                  onChange={(e) => setInitialStock(e.target.value)}
                  style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-main)', color: 'var(--text-main)' }}
                />
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={isSubmitting}
                  onClick={() => handleAddSubmit(false)}
                >
                  Save as Draft
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Publishing...' : 'Publish Listing'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
