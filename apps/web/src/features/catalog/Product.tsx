import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { catalogApi, type Product, type Sku } from './api/catalog';
import { marketplaceApi, type Listing } from '../marketplace/api/marketplace';
import { recommendationsApi, type RecommendationItemDto } from '../recommendations/api/recommendations';
import { useCart } from '../cart/CartContext';
import { useAuth } from '../auth/AuthContext';

export const ProductPage = () => {
  const { id } = useParams<{ id: string }>();
  const { addItem } = useCart();
  const { isAuthenticated, login } = useAuth();
  const [product, setProduct] = useState<Product | null>(null);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [selectedSku, setSelectedSku] = useState<Sku | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [addingListingId, setAddingListingId] = useState<string | null>(null);
  const [addedListingId, setAddedListingId] = useState<string | null>(null);
  
  const [isLoadingProduct, setIsLoadingProduct] = useState(true);
  const [isLoadingListings, setIsLoadingListings] = useState(false);
  const [alternatives, setAlternatives] = useState<RecommendationItemDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [listingsError, setListingsError] = useState<string | null>(null);

  // Load product and SKUs
  useEffect(() => {
    if (!id) return;
    const fetchProduct = async () => {
      setIsLoadingProduct(true);
      setError(null);
      try {
        const [productData, skusData] = await Promise.all([
          catalogApi.getProduct(id),
          catalogApi.getProductSkus(id)
        ]);
        setProduct(productData);
        // Backend now securely filters SKUs based on authorization.
        setSkus(skusData);
        if (skusData.length > 0) {
          setSelectedSku(skusData[0] ?? null);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load product');
      } finally {
        setIsLoadingProduct(false);
      }
    };
    fetchProduct();
  }, [id]);

  // Load marketplace listings when a SKU is selected
  useEffect(() => {
    if (!selectedSku) {
      setListings([]);
      return;
    }
    const fetchListings = async () => {
      setIsLoadingListings(true);
      setListingsError(null);
      try {
        const listingsData = await marketplaceApi.getSkuListings(selectedSku.id);
        setListings(listingsData);
        if (listingsData.length === 0 && product) {
          recommendationsApi.getSimilar(product.id, 3)
            .then(res => setAlternatives(res.items || []))
            .catch(() => setAlternatives([]));
        }
      } catch (err: unknown) {
        setListingsError(err instanceof Error ? err.message : 'Failed to load offers');
      } finally {
        setIsLoadingListings(false);
      }
    };
    fetchListings();
  }, [selectedSku, product]);

  if (isLoadingProduct) return <div className="p-4">Loading product details...</div>;
  if (error) return <div className="p-4 text-red-600">Error: {error}</div>;
  if (!product) return <div className="p-4">Product not found.</div>;

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <div className="mb-4 text-sm text-gray-500">
        <Link to="/" className="hover:underline">Home</Link>
        {product.categoryId && (
          <> / <Link to={`/category/${product.categoryId}`} className="hover:underline">Category</Link></>
        )}
        {' '} / {product.title}
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Product Details - Catalog Authoritative */}
        <div>
          <h1 className="text-3xl font-bold mb-2">{product.title}</h1>
          {product.brand && <p className="text-lg text-gray-600 mb-4">{product.brand}</p>}
          <div className="prose mb-6">
            <p>{product.description || 'No description available.'}</p>
          </div>
          
          {/* Variants / SKUs */}
          {skus.length > 0 ? (
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-3">Select Variant:</h3>
              <div className="flex flex-wrap gap-2">
                {skus.map(sku => (
                  <button
                    key={sku.id}
                    onClick={() => setSelectedSku(sku)}
                    className={`px-4 py-2 border rounded ${
                      selectedSku?.id === sku.id 
                        ? 'border-blue-600 bg-blue-50 text-blue-700' 
                        : 'border-gray-300 hover:border-gray-400'
                    }`}
                  >
                    {sku.skuCode}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mb-6 p-4 bg-yellow-50 text-yellow-800 rounded">
              No active variants available for this product.
            </div>
          )}
        </div>

        {/* Marketplace Listings - Seller/Price Authoritative */}
        <div>
          <h2 className="text-2xl font-bold mb-4 border-b pb-2">Seller Offers</h2>
          
          {!selectedSku ? (
            <p className="text-gray-500">Select a variant to see available offers.</p>
          ) : isLoadingListings ? (
            <p className="text-gray-500">Loading offers...</p>
          ) : listingsError ? (
            <p className="text-red-600">Error loading offers: {listingsError}</p>
          ) : listings.length === 0 ? (
            <div className="p-6 border rounded-lg bg-gray-50 text-center">
              <p className="text-gray-600">Currently unavailable.</p>
              <p className="text-sm text-gray-500 mt-2">No merchants are actively selling this item.</p>

              {alternatives.length > 0 && (
                <div style={{ marginTop: '1.5rem', textAlign: 'left' }}>
                  <h4 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--text-main)' }}>
                    ✨ Recommended Alternatives (Section 7.5):
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {alternatives.map((alt) => (
                      <Link
                        key={alt.productId}
                        to={`/product/${alt.productId}`}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '0.65rem 0.85rem',
                          background: '#ffffff',
                          borderRadius: '6px',
                          border: '1px solid var(--border)',
                          textDecoration: 'none',
                          color: 'inherit',
                          fontSize: '0.85rem',
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{alt.title}</span>
                        <span style={{ color: 'var(--brand)', fontWeight: 600 }}>Compare Offers &rarr;</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {listings.map(listing => (
                <div key={listing.id} className="p-4 border rounded-lg flex justify-between items-center bg-white shadow-sm hover:shadow">
                  <div>
                    <div className="font-semibold text-lg">
                      {listing.priceAmount.toFixed(2)} {listing.currency}
                    </div>
                    {listing.compareAtPrice && listing.compareAtPrice > listing.priceAmount && (
                      <div className="text-sm text-gray-500 line-through">
                        {listing.compareAtPrice.toFixed(2)} {listing.currency}
                      </div>
                    )}
                    <div className="text-xs text-gray-500 mt-1">
                      Sold by Merchant: {listing.tenantId.slice(0, 8)}...
                    </div>
                  </div>
                  <div>
                    {addedListingId === listing.id ? (
                      <Link
                        to="/cart"
                        className="btn btn-primary"
                        style={{ padding: '0.5rem 1rem', fontSize: '0.9rem' }}
                      >
                        ✓ In Cart &rarr;
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ padding: '0.5rem 1.25rem', fontSize: '0.9rem' }}
                        disabled={addingListingId === listing.id}
                        onClick={async () => {
                          setAddingListingId(listing.id);
                          try {
                            if (!isAuthenticated) {
                              await login({ email: 'customer@example.com', password: 'password123' });
                            }
                            await addItem(listing.id, 1);
                            setAddedListingId(listing.id);
                          } catch (err: unknown) {
                            alert(err instanceof Error ? err.message : 'Failed to add item to cart');
                          } finally {
                            setAddingListingId(null);
                          }
                        }}
                      >
                        {addingListingId === listing.id ? 'Adding...' : 'Add to Cart'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
