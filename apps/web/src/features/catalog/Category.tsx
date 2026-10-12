import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { PackageSearch } from 'lucide-react';
import { catalogApi, type Category, type Product } from './api/catalog';
import { Alert } from '../../components/ui/alert';
import { EmptyState, Skeleton } from '../../components/ui/empty';
import { Rating } from '../../components/product/display';

export const CategoryPage = () => {
  const { id } = useParams<{ id: string }>();
  const [category, setCategory] = useState<Category | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [categoryData, productsData] = await Promise.all([
          catalogApi.getCategory(id),
          catalogApi.getProducts({ categoryId: id, status: 'ACTIVE' }),
        ]);
        setCategory(categoryData);
        setProducts(productsData);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load category data');
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, [id]);

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-3 p-4" aria-label="Loading category">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-6 w-56" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="mx-auto w-full max-w-6xl p-4">
        <Alert tone="error" title="Category could not be loaded">
          Error: {error}
        </Alert>
      </div>
    );
  }
  if (!category) {
    return (
      <div className="mx-auto w-full max-w-6xl p-4">
        <EmptyState
          icon={PackageSearch}
          title="Category not found"
          description="This category may have been removed. Browse the catalog instead."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl p-4">
      <nav aria-label="Breadcrumb" className="text-[13px] text-muted-foreground">
        <Link to="/" className="hover:underline">
          Home
        </Link>
        <span aria-current="page"> / {category.name}</span>
      </nav>
      <div className="mt-1 flex items-end justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{category.name}</h1>
        <p className="text-[13px] text-muted-foreground">
          {products.length} {products.length === 1 ? 'product' : 'products'}
        </p>
      </div>

      {products.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={PackageSearch}
            title="No products currently available in this category."
            description="Check back later or browse other categories."
          />
        </div>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => (
            <Link
              key={product.id}
              to={`/product/${product.id}`}
              className="rounded-lg border border-border p-4 transition-colors duration-150 hover:bg-muted"
            >
              {(product.thumbnailUrl ?? product.images?.[0]) && (
                <img
                  src={product.thumbnailUrl ?? product.images?.[0]}
                  alt=""
                  loading="lazy"
                  className="mb-2 aspect-square w-full rounded-md border border-border object-cover"
                />
              )}
              <p className="text-sm font-medium leading-snug">{product.title}</p>
              {product.brand && (
                <p className="mt-0.5 text-xs text-muted-foreground">{product.brand}</p>
              )}
              <div className="mt-1">
                <Rating rating={product.rating} reviewCount={product.reviewCount} />
              </div>
              {product.description && (
                <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">
                  {product.description}
                </p>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
};
