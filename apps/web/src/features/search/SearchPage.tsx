import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { searchApi, type SearchResponseDto, type SearchSortBy } from './api/search';
import { useCart } from '../cart/CartContext';
import { useAuth } from '../auth/AuthContext';

export const SearchPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { isAuthenticated, login } = useAuth();
  const { cart, addItem, updateQuantity, removeItem } = useCart();
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const queryQ = searchParams.get('q') || '';
  const queryCategory = searchParams.get('categoryId') || '';
  const queryBrand = searchParams.get('brand') || '';
  const queryInStock = searchParams.get('inStock') === 'true';
  const querySort = (searchParams.get('sortBy') as SearchSortBy) || 'relevance';
  const queryPage = parseInt(searchParams.get('page') || '1', 10);

  const [inputQuery, setInputQuery] = useState(queryQ);
  const [data, setData] = useState<SearchResponseDto | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAddToCart = async (listingId: string) => {
    setActionLoadingId(listingId);
    try {
      if (!isAuthenticated) {
        await login({ email: 'customer@example.com', password: 'password123' });
      }
      await addItem(listingId, 1);
    } catch (err: unknown) {
      alert(`Could not add to cart: ${err instanceof Error ? err.message : 'Error'}`);
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleUpdateQty = async (itemId: string, currentQty: number, delta: number) => {
    setActionLoadingId(itemId);
    try {
      const nextQty = currentQty + delta;
      if (nextQty <= 0) {
        await removeItem(itemId);
      } else {
        await updateQuantity(itemId, nextQty);
      }
    } catch (err: unknown) {
      alert(`Quantity update failed: ${err instanceof Error ? err.message : 'Error'}`);
    } finally {
      setActionLoadingId(null);
    }
  };

  const performSearch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await searchApi.search({
        q: queryQ || undefined,
        categoryId: queryCategory || undefined,
        brand: queryBrand || undefined,
        inStock: queryInStock ? true : undefined,
        sortBy: querySort,
        page: queryPage,
        pageSize: 12,
      });
      setData(response);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Search failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [queryQ, queryCategory, queryBrand, queryInStock, querySort, queryPage]);

  useEffect(() => {
    performSearch();
  }, [performSearch]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams(searchParams);
    if (inputQuery.trim()) {
      next.set('q', inputQuery.trim());
    } else {
      next.delete('q');
    }
    next.set('page', '1');
    setSearchParams(next);
  };

  const handleFilterChange = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    next.set('page', '1');
    setSearchParams(next);
  };

  const handlePageChange = (newPage: number) => {
    const next = new URLSearchParams(searchParams);
    next.set('page', newPage.toString());
    setSearchParams(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const formatPrice = (minorUnits: number, currency: string) => {
    const major = minorUnits / 100;
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 2,
    }).format(major);
  };

  return (
    <div className="container" style={{ paddingBottom: '3rem' }}>
      {/* Header Search Banner */}
      <section style={{ margin: '2rem 0' }}>
        <h1 className="font-display" style={{ fontSize: '2rem', marginBottom: '1rem' }}>
          Search Products
        </h1>
        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '0.75rem', maxWidth: '720px' }}>
          <input
            id="search-input"
            type="search"
            className="input-field"
            style={{ flex: 1, padding: '0.75rem 1.25rem', fontSize: '1rem' }}
            placeholder="Search by product title, brand, category, or SKU..."
            value={inputQuery}
            onChange={(e) => setInputQuery(e.target.value)}
            aria-label="Search products"
          />
          <button id="search-submit" type="submit" className="btn btn-primary" disabled={isLoading}>
            {isLoading ? 'Searching...' : 'Search'}
          </button>
        </form>
      </section>

      {/* Main Grid: Facet Sidebar + Results */}
      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: '2rem' }}>
        {/* Facets Sidebar */}
        <aside style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="card" style={{ padding: '1.25rem' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>Sort By</h3>
            <select
              id="sort-select"
              className="input-field"
              value={querySort}
              onChange={(e) => handleFilterChange('sortBy', e.target.value)}
              aria-label="Sort products"
              style={{ width: '100%' }}
            >
              <option value="relevance">Relevance</option>
              <option value="price_asc">Price: Low to High</option>
              <option value="price_desc">Price: High to Low</option>
              <option value="newest">Newest Arrivals</option>
            </select>
          </div>

          <div className="card" style={{ padding: '1.25rem' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>Availability</h3>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                id="filter-in-stock"
                type="checkbox"
                checked={queryInStock}
                onChange={(e) => handleFilterChange('inStock', e.target.checked ? 'true' : null)}
              />
              <span>In Stock Only</span>
            </label>
          </div>

          {data?.facets?.categories && data.facets.categories.length > 0 && (
            <div className="card" style={{ padding: '1.25rem' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>Categories</h3>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <li key="all-cats">
                  <button
                    type="button"
                    onClick={() => handleFilterChange('categoryId', null)}
                    style={{
                      color: !queryCategory ? 'var(--brand)' : 'var(--primary)',
                      fontWeight: !queryCategory ? 600 : 400,
                      textAlign: 'left',
                    }}
                  >
                    All Categories
                  </button>
                </li>
                {data.facets.categories.map((cat) => (
                  <li key={cat.id}>
                    <button
                      type="button"
                      onClick={() => handleFilterChange('categoryId', cat.id)}
                      style={{
                        color: queryCategory === cat.id ? 'var(--brand)' : 'var(--primary-muted)',
                        fontWeight: queryCategory === cat.id ? 600 : 400,
                        textAlign: 'left',
                        display: 'flex',
                        justifyContent: 'space-between',
                        width: '100%',
                      }}
                    >
                      <span>{cat.name}</span>
                      <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>({cat.count})</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data?.facets?.brands && data.facets.brands.length > 0 && (
            <div className="card" style={{ padding: '1.25rem' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>Brands</h3>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <li key="all-brands">
                  <button
                    type="button"
                    onClick={() => handleFilterChange('brand', null)}
                    style={{
                      color: !queryBrand ? 'var(--brand)' : 'var(--primary)',
                      fontWeight: !queryBrand ? 600 : 400,
                      textAlign: 'left',
                    }}
                  >
                    All Brands
                  </button>
                </li>
                {data.facets.brands.map((b) => (
                  <li key={b.name}>
                    <button
                      type="button"
                      onClick={() => handleFilterChange('brand', b.name)}
                      style={{
                        color: queryBrand === b.name ? 'var(--brand)' : 'var(--primary-muted)',
                        fontWeight: queryBrand === b.name ? 600 : 400,
                        textAlign: 'left',
                        display: 'flex',
                        justifyContent: 'space-between',
                        width: '100%',
                      }}
                    >
                      <span>{b.name}</span>
                      <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>({b.count})</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        {/* Search Results Display */}
        <main>
          {error && (
            <div
              className="card"
              style={{
                borderColor: 'var(--accent-red)',
                color: 'var(--accent-red)',
                marginBottom: '1.5rem',
              }}
              role="alert"
            >
              <p><strong>Error:</strong> {error}</p>
            </div>
          )}

          {isLoading ? (
            <div style={{ padding: '3rem 0', textAlign: 'center', color: 'var(--primary-muted)' }}>
              <p>Searching marketplace catalog...</p>
            </div>
          ) : data?.items && data.items.length > 0 ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <p className="text-muted" style={{ fontSize: '0.9rem' }}>
                  Showing {data.items.length} of {data.total} {data.total === 1 ? 'product' : 'products'}
                  {queryQ && <span> for &ldquo;<strong>{queryQ}</strong>&rdquo;</span>}
                </p>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                  gap: '1.5rem',
                }}
              >
                {data.items.map((item) => {
                  const bestOffer = item.bestOffer || item.offers?.[0];
                  const cartItem = cart?.items?.find((it) => it.listingId === bestOffer?.listingId);

                  return (
                    <article key={item.productId} className="card card-hover" style={{ display: 'flex', flexDirection: 'column' }}>
                      {/* Blinkit Delivery Tag */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                        <span
                          style={{
                            background: 'rgba(34, 197, 94, 0.1)',
                            color: 'var(--accent-green)',
                            fontSize: '0.7rem',
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: '4px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '2px',
                          }}
                        >
                          ⚡ 12 MINS
                        </span>
                        <span className="text-muted" style={{ fontSize: '0.75rem' }}>
                          {item.totalOffersCount} {item.totalOffersCount === 1 ? 'seller offer' : 'seller offers'}
                        </span>
                      </div>

                      <div style={{ flex: 1 }}>
                        {item.brand && (
                          <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--primary-muted)' }}>
                            {item.brand}
                          </span>
                        )}
                        <h2 style={{ fontSize: '1.05rem', margin: '0.25rem 0 0.4rem', fontWeight: 600 }}>
                          <Link to={`/product/${item.productId}`} style={{ color: 'var(--primary)' }}>
                            {item.title}
                          </Link>
                        </h2>
                        {item.categoryName && (
                          <span style={{ fontSize: '0.8rem', color: 'var(--primary-muted)', display: 'block', marginBottom: '0.5rem' }}>
                            In {item.categoryName}
                          </span>
                        )}
                        {bestOffer?.merchantName && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--primary-muted)', marginBottom: '0.5rem' }}>
                            Sold by <strong style={{ color: 'var(--text-main)' }}>{bestOffer.merchantName}</strong>
                          </div>
                        )}
                      </div>

                      <div style={{ borderTop: '1px solid var(--border-light)', paddingTop: '0.75rem', marginTop: '0.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                          <span style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--brand)' }}>
                            {item.minPrice === item.maxPrice
                              ? formatPrice(item.minPrice, item.currency)
                              : `${formatPrice(item.minPrice, item.currency)} - ${formatPrice(item.maxPrice, item.currency)}`}
                          </span>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.4rem', fontSize: '0.8rem' }}>
                          <span style={{ color: item.hasInStockOffer ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600 }}>
                            {item.hasInStockOffer ? 'In Stock' : 'Out of Stock'}
                          </span>
                        </div>

                        {/* Action row: Quick Add or Offers */}
                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                          {item.hasInStockOffer && bestOffer ? (
                            cartItem ? (
                              <div
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  background: 'var(--brand)',
                                  borderRadius: '6px',
                                  overflow: 'hidden',
                                  flex: 1,
                                  justifyContent: 'space-between',
                                }}
                              >
                                <button
                                  type="button"
                                  style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: '#fff',
                                    padding: '0.4rem 0.75rem',
                                    cursor: 'pointer',
                                    fontWeight: 700,
                                  }}
                                  disabled={actionLoadingId === cartItem.id}
                                  onClick={() => handleUpdateQty(cartItem.id, cartItem.quantity, -1)}
                                >
                                  &minus;
                                </button>
                                <span style={{ color: '#fff', fontWeight: 700, fontSize: '0.85rem' }}>
                                  {cartItem.quantity}
                                </span>
                                <button
                                  type="button"
                                  style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: '#fff',
                                    padding: '0.4rem 0.75rem',
                                    cursor: 'pointer',
                                    fontWeight: 700,
                                  }}
                                  disabled={actionLoadingId === cartItem.id}
                                  onClick={() => handleUpdateQty(cartItem.id, cartItem.quantity, 1)}
                                >
                                  +
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-primary"
                                style={{ flex: 1, padding: '0.5rem', fontWeight: 700 }}
                                disabled={actionLoadingId === bestOffer.listingId}
                                onClick={() => handleAddToCart(bestOffer.listingId)}
                              >
                                {actionLoadingId === bestOffer.listingId ? 'Adding...' : 'ADD'}
                              </button>
                            )
                          ) : null}

                          <Link
                            to={`/product/${item.productId}`}
                            className="btn btn-secondary"
                            style={{ flex: item.hasInStockOffer && bestOffer ? '0 0 auto' : '1', padding: '0.5rem 0.75rem', textAlign: 'center' }}
                          >
                            Details
                          </Link>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>

              {/* Pagination Controls */}
              {data.totalPages > 1 && (
                <nav
                  aria-label="Pagination Navigation"
                  style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem', marginTop: '2.5rem' }}
                >
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handlePageChange(data.page - 1)}
                    disabled={data.page <= 1}
                    aria-label="Previous Page"
                  >
                    Previous
                  </button>
                  <span style={{ padding: '0 1rem', fontSize: '0.9rem', color: 'var(--primary-muted)' }}>
                    Page {data.page} of {data.totalPages}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handlePageChange(data.page + 1)}
                    disabled={data.page >= data.totalPages}
                    aria-label="Next Page"
                  >
                    Next
                  </button>
                </nav>
              )}
            </>
          ) : (
            <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
              <h2 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>No products found</h2>
              <p className="text-muted" style={{ maxWidth: '400px', margin: '0 auto 1.5rem' }}>
                We couldn&rsquo;t find any products matching your current query or filters. Try adjusting your search keywords or resetting filters.
              </p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setInputQuery('');
                  setSearchParams(new URLSearchParams());
                }}
              >
                Reset All Filters
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};
