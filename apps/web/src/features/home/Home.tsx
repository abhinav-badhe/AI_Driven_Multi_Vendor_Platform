import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { catalogApi, type Category } from '../catalog/api/catalog';
import { searchApi, type SearchProductResultDto } from '../search/api/search';
import { recommendationsApi, type RecommendationItemDto } from '../recommendations/api/recommendations';
import { useAuth } from '../auth/AuthContext';
import { useCart } from '../cart/CartContext';

export const Home = () => {
  const { isAuthenticated, login } = useAuth();
  const { cart, addItem, updateQuantity, removeItem } = useCart();
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<SearchProductResultDto[]>([]);
  const [recommendations, setRecommendations] = useState<RecommendationItemDto[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const formatPrice = (minorUnits: number, currency = 'INR') => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 0,
    }).format(minorUnits / 100);
  };

  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsLoading(true);
        const catData = await catalogApi.getCategories();
        setCategories(catData || []);

        // Optional recommendation enrichment
        try {
          if (isAuthenticated) {
            const recs = await recommendationsApi.getPersonalized(4);
            setRecommendations(recs.items || []);
          } else {
            const trending = await recommendationsApi.getTrending(4).catch(() => ({ items: [] }));
            setRecommendations(trending.items || []);
          }
        } catch {
          // Graceful fallback
        }

        // Optional search products enrichment
        try {
          const searchData = await searchApi.search({ pageSize: 12 }).catch(() => ({ items: [] }));
          setProducts(searchData.items || []);
        } catch {
          // Graceful fallback
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load home discovery');
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, [isAuthenticated]);

  const handleAddToCart = async (listingId: string) => {
    setActionLoadingId(listingId);
    try {
      if (!isAuthenticated) {
        // Fast sign-in for seamless one-click experience
        await login({ email: 'customer@example.com', password: 'password123' });
      }
      await addItem(listingId, 1);
    } catch (err: unknown) {
      alert(`Could not add to cart: ${err instanceof Error ? err.message : 'Item unavailable'}`);
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

  const rootCategories = categories.filter((c) => !c.parentId);
  const displayedProducts = selectedCategory
    ? products.filter((p) => p.categoryId === selectedCategory)
    : products;

  if (isLoading) {
    return (
      <div className="container" style={{ padding: '4rem 1rem', textAlign: 'center' }}>
        <p className="text-muted">Loading categories...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container" style={{ padding: '2rem 1rem' }}>
        <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)' }}>
          Error: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: '1.5rem 1rem 4rem' }}>
      {/* Quick-Commerce Location & Delivery Guarantee Strip */}
      <section
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'linear-gradient(90deg, rgba(34, 197, 94, 0.08) 0%, rgba(37, 99, 235, 0.08) 100%)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          padding: '0.75rem 1.25rem',
          marginBottom: '1.5rem',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ fontSize: '1.25rem' }}>⚡</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>Delivery in 10-15 minutes</span>
              <span style={{ fontSize: '0.7rem', background: 'var(--accent-green)', color: '#fff', padding: '1px 6px', borderRadius: '4px', fontWeight: 700 }}>
                HYPERLOCAL
              </span>
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>
              Delivering to: <strong>B-42, Bandra West, Mumbai 400050</strong>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>
            ✓ Verified Multi-Merchant Allocation &bull; Real-time Stock Lock
          </span>
          <Link to="/search" className="btn btn-secondary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}>
            Browse All (100+)
          </Link>
        </div>
      </section>

      {/* Hero Banner */}
      <section
        style={{
          background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.09) 0%, rgba(139, 92, 246, 0.09) 100%)',
          border: '1px solid var(--border)',
          borderRadius: '16px',
          padding: '2.5rem 2rem',
          marginBottom: '2rem',
          textAlign: 'center',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <h1 className="font-display" style={{ fontSize: '2.4rem', marginBottom: '0.75rem', color: 'var(--text-main)', letterSpacing: '-0.02em' }}>
          Instant Multi-Vendor Retail, <span style={{ color: 'var(--brand)' }}>Predictive &amp; Fast</span>
        </h1>
        <p className="text-muted" style={{ fontSize: '1.05rem', maxWidth: '680px', margin: '0 auto 1.5rem', lineHeight: 1.6 }}>
          Zero out-of-stock surprises with transactional inventory reservation, double-entry settlement ledgers, and tool-governed conversational intelligence.
        </p>
        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
          <Link to="/search" className="btn btn-primary" style={{ padding: '0.75rem 1.75rem', fontSize: '1rem' }}>
            Start Instant Shopping
          </Link>
          <Link to="/analytics" className="btn btn-secondary" style={{ padding: '0.75rem 1.5rem', fontSize: '1rem' }}>
            Live Telemetry &amp; SRE
          </Link>
        </div>
      </section>

      {/* Horizontal Category Pills Strip (Quick Commerce Style) */}
      {rootCategories.length > 0 && (
        <section style={{ marginBottom: '2rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', overflowX: 'auto', paddingBottom: '0.5rem' }}>
            <button
              type="button"
              onClick={() => setSelectedCategory(null)}
              style={{
                padding: '0.5rem 1.25rem',
                borderRadius: '999px',
                border: selectedCategory === null ? '2px solid var(--brand)' : '1px solid var(--border)',
                background: selectedCategory === null ? 'rgba(37, 99, 235, 0.15)' : 'var(--bg-card)',
                color: selectedCategory === null ? 'var(--brand)' : 'var(--text-main)',
                fontWeight: selectedCategory === null ? 700 : 500,
                fontSize: '0.85rem',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              🔥 All Deals
            </button>
            {rootCategories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setSelectedCategory(cat.id === selectedCategory ? null : cat.id)}
                style={{
                  padding: '0.5rem 1.25rem',
                  borderRadius: '999px',
                  border: selectedCategory === cat.id ? '2px solid var(--brand)' : '1px solid var(--border)',
                  background: selectedCategory === cat.id ? 'rgba(37, 99, 235, 0.15)' : 'var(--bg-card)',
                  color: selectedCategory === cat.id ? 'var(--brand)' : 'var(--text-main)',
                  fontWeight: selectedCategory === cat.id ? 700 : 500,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                🏷️ {cat.name} Deals
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Featured / Trending Quick-Add Products (Blinkit Card Layout) */}
      <section style={{ marginBottom: '3rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div>
            <h2 className="font-display" style={{ fontSize: '1.5rem', color: 'var(--text-main)' }}>
              ⚡ Trending Products
            </h2>
            <p className="text-muted" style={{ fontSize: '0.85rem' }}>
              Real-time available offers with verified merchant allocations
            </p>
          </div>
          <Link to="/search" style={{ fontSize: '0.9rem', color: 'var(--brand)', textDecoration: 'none', fontWeight: 600 }}>
            View All ({products.length}) &rarr;
          </Link>
        </div>

        {displayedProducts.length === 0 ? (
          <div className="card" style={{ padding: '2rem', textAlign: 'center' }}>
            <p className="text-muted">No products found in this category.</p>
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: '1.25rem',
            }}
          >
            {displayedProducts.map((p) => {
              const bestOffer = p.bestOffer || p.offers?.[0];
              const cartItem = cart?.items?.find((it) => it.listingId === bestOffer?.listingId);

              return (
                <div
                  key={p.productId}
                  className="card card-hover"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    padding: '1.25rem',
                    position: 'relative',
                  }}
                >
                  {/* Delivery ETA Tag */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
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
                    <span style={{ fontSize: '0.75rem', color: 'var(--primary-muted)' }}>
                      {p.totalOffersCount} {p.totalOffersCount === 1 ? 'seller' : 'sellers'}
                    </span>
                  </div>

                  {/* Brand & Title */}
                  <div style={{ marginBottom: '0.75rem' }}>
                    {p.brand && (
                      <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--primary-muted)', letterSpacing: '0.05em' }}>
                        {p.brand}
                      </span>
                    )}
                    <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: '0.2rem 0', color: 'var(--text-main)', lineHeight: 1.4 }}>
                      <Link to={`/product/${p.productId}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                        {p.title}
                      </Link>
                    </h3>
                    {bestOffer?.merchantName && (
                      <div style={{ fontSize: '0.75rem', color: 'var(--primary-muted)' }}>
                        Sold by <span style={{ color: 'var(--text-main)' }}>{bestOffer.merchantName}</span>
                      </div>
                    )}
                  </div>

                  {/* Price & Action Row */}
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginTop: 'auto' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--brand)' }}>
                          {formatPrice(p.minPrice, p.currency)}
                        </div>
                        <span style={{ fontSize: '0.7rem', color: p.hasInStockOffer ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                          {p.hasInStockOffer ? 'In Stock' : 'Out of Stock'}
                        </span>
                      </div>

                      {/* Quick Blinkit Add / Quantity Selector */}
                      <div>
                        {p.hasInStockOffer && bestOffer ? (
                          cartItem ? (
                            <div
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                background: 'var(--brand)',
                                borderRadius: '6px',
                                overflow: 'hidden',
                              }}
                            >
                              <button
                                type="button"
                                style={{
                                  background: 'transparent',
                                  border: 'none',
                                  color: '#fff',
                                  padding: '0.35rem 0.6rem',
                                  cursor: 'pointer',
                                  fontWeight: 700,
                                }}
                                disabled={actionLoadingId === cartItem.id}
                                onClick={() => handleUpdateQty(cartItem.id, cartItem.quantity, -1)}
                              >
                                &minus;
                              </button>
                              <span style={{ color: '#fff', fontWeight: 700, fontSize: '0.85rem', padding: '0 0.4rem' }}>
                                {cartItem.quantity}
                              </span>
                              <button
                                type="button"
                                style={{
                                  background: 'transparent',
                                  border: 'none',
                                  color: '#fff',
                                  padding: '0.35rem 0.6rem',
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
                              style={{ padding: '0.35rem 0.9rem', fontSize: '0.8rem', fontWeight: 700 }}
                              disabled={actionLoadingId === bestOffer.listingId}
                              onClick={() => handleAddToCart(bestOffer.listingId)}
                            >
                              {actionLoadingId === bestOffer.listingId ? 'Adding...' : 'ADD'}
                            </button>
                          )
                        ) : (
                          <Link
                            to={`/product/${p.productId}`}
                            className="btn btn-secondary"
                            style={{ padding: '0.35rem 0.6rem', fontSize: '0.75rem' }}
                          >
                            Offers
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Recommendations Section (Section 15 & 16) */}
      {recommendations.length > 0 && (
        <section style={{ marginBottom: '3rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
            <div>
              <h2 className="font-display" style={{ fontSize: '1.5rem', color: 'var(--text-main)' }}>
                ✨ Personalized For You
              </h2>
              <p className="text-muted" style={{ fontSize: '0.85rem' }}>
                Derived by machine-learned affinity ranking, browsing context &amp; cart items
              </p>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1.25rem' }}>
            {recommendations.map((item) => {
              const bestOffer = item.activeOffers?.[0];
              return (
                <Link
                  key={item.productId}
                  to={`/product/${item.productId}`}
                  className="card card-hover"
                  style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column', height: '100%', padding: '1.25rem' }}
                >
                  <div style={{ fontWeight: 700, fontSize: '1.05rem', marginBottom: '0.4rem', color: 'var(--text-main)' }}>
                    {item.title}
                  </div>
                  {item.explanation && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--brand)', marginBottom: '0.75rem' }}>
                      {item.explanation}
                    </div>
                  )}
                  <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      {bestOffer ? (
                        <span style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--brand)' }}>
                          {formatPrice(bestOffer.priceAmount, bestOffer.currency)}
                        </span>
                      ) : (
                        <span className="text-muted" style={{ fontSize: '0.85rem' }}>Check listings</span>
                      )}
                    </div>
                    <span
                      style={{
                        fontSize: '0.75rem',
                        padding: '2px 8px',
                        borderRadius: '999px',
                        background: item.isAvailable ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                        color: item.isAvailable ? 'var(--accent-green)' : 'var(--accent-red)',
                        fontWeight: 600,
                      }}
                    >
                      {item.isAvailable ? 'In Stock' : 'Out of Stock'}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Shop by Category Grid */}
      <section>
        <h2 className="font-display" style={{ fontSize: '1.5rem', marginBottom: '1.25rem' }}>
          Shop by Category
        </h2>
        {rootCategories.length === 0 ? (
          <div className="card" style={{ padding: '2rem', textAlign: 'center' }}>
            <p className="text-muted">No categories found.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '1rem' }}>
            {rootCategories.map((category) => (
              <Link
                key={category.id}
                to={`/category/${category.id}`}
                className="card card-hover"
                style={{
                  padding: '1.25rem',
                  textDecoration: 'none',
                  color: 'inherit',
                  display: 'block',
                }}
              >
                <div style={{ fontSize: '1.15rem', fontWeight: 600, color: 'var(--text-main)', marginBottom: '0.25rem' }}>
                  {category.name}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>
                  Browse Products &rarr;
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
