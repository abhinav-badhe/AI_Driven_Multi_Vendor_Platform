/**
 * Shared cache key/tag vocabulary.
 *
 * Lives in infra (dependency-free) so both HTTP routes and domain modules
 * can invalidate the same entries without layering violations.
 * Tag format: `<group>` for whole collections, `<group>:<scope>:<id>`
 * for scoped entries.
 */

export const CacheGroups = {
  categories: 'catalog:categories',
  products: 'catalog:products',
  skus: 'catalog:skus',
  reviews: 'catalog:reviews',
  listings: 'marketplace:listings',
  inventory: 'inventory:items',
  availability: 'inventory:availability',
  search: 'search:results',
  recommendations: 'recommendations:results',
  analytics: 'analytics:results',
  mlSignals: 'ml:signals',
  orders: 'orders:views',
  fulfillment: 'fulfillment:views',
  settlement: 'settlement:views',
  merchant: 'merchant:views',
} as const;

export function categoryTag(id: string): string {
  return `${CacheGroups.categories}:${id}`;
}

export function productTag(id: string): string {
  return `${CacheGroups.products}:${id}`;
}

export function skuTag(id: string): string {
  return `${CacheGroups.skus}:${id}`;
}

export function listingTag(id: string): string {
  return `${CacheGroups.listings}:${id}`;
}

export function listingMerchantTag(tenantId: string): string {
  return `${CacheGroups.listings}:merchant:${tenantId}`;
}

export function listingSkuTag(skuId: string): string {
  return `${CacheGroups.listings}:sku:${skuId}`;
}

export function inventoryListingTag(listingId: string): string {
  return `${CacheGroups.inventory}:listing:${listingId}`;
}

export function inventoryItemTag(inventoryId: string): string {
  return `${CacheGroups.inventory}:item:${inventoryId}`;
}

export function inventoryMerchantTag(tenantId: string): string {
  return `${CacheGroups.inventory}:merchant:${tenantId}`;
}
