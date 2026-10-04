import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { catalogApi, type Category, type Product } from './api/catalog';

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
          catalogApi.getProducts({ categoryId: id, status: 'ACTIVE' })
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

  if (isLoading) return <div className="p-4">Loading category...</div>;
  if (error) return <div className="p-4 text-red-600">Error: {error}</div>;
  if (!category) return <div className="p-4">Category not found.</div>;

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <div className="mb-4 text-sm text-gray-500">
        <Link to="/" className="hover:underline">Home</Link> / {category.name}
      </div>
      <h1 className="text-3xl font-bold mb-6">{category.name}</h1>
      
      {products.length === 0 ? (
        <div className="text-gray-500 py-8 text-center border rounded-lg bg-gray-50">
          No products currently available in this category.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
          {products.map(product => (
            <Link 
              key={product.id} 
              to={`/product/${product.id}`}
              className="p-4 border rounded-lg hover:shadow-lg transition-shadow bg-white flex flex-col"
            >
              <h2 className="text-lg font-medium mb-2">{product.title}</h2>
              {product.brand && <p className="text-sm text-gray-500 mb-2">{product.brand}</p>}
              <p className="text-sm text-gray-700 flex-grow line-clamp-2">
                {product.description || 'No description available.'}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
};
