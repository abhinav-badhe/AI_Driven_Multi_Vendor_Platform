import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { cartApi, type CartDto } from './api/cart';
import { useAuth } from '../auth/AuthContext';

interface CartContextType {
  cart: CartDto | null;
  itemCount: number;
  isLoading: boolean;
  addItem: (listingId: string, quantity?: number) => Promise<void>;
  updateQuantity: (itemId: string, quantity: number) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  refreshCart: () => Promise<void>;
}

const CartContext = createContext<CartContextType | null>(null);

export const CartProvider = ({ children }: { children: ReactNode }) => {
  const { isAuthenticated } = useAuth();
  const [cart, setCart] = useState<CartDto | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refreshCart = useCallback(async () => {
    if (!isAuthenticated) {
      setCart(null);
      return;
    }
    setIsLoading(true);
    try {
      const data = await cartApi.getCart();
      setCart(data);
    } catch {
      // Cart may not exist yet or user not logged in
      setCart(null);
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    refreshCart();
  }, [refreshCart]);

  const addItem = async (listingId: string, quantity = 1) => {
    const updated = await cartApi.addItem(listingId, quantity);
    setCart(updated);
  };

  const updateQuantity = async (itemId: string, quantity: number) => {
    const updated = await cartApi.updateQuantity(itemId, quantity);
    setCart(updated);
  };

  const removeItem = async (itemId: string) => {
    const updated = await cartApi.removeItem(itemId);
    setCart(updated);
  };

  const itemCount = cart?.items?.reduce((sum, it) => sum + it.quantity, 0) ?? 0;

  return (
    <CartContext.Provider
      value={{
        cart,
        itemCount,
        isLoading,
        addItem,
        updateQuantity,
        removeItem,
        refreshCart,
      }}
    >
      {children}
    </CartContext.Provider>
  );
};

export const useCart = () => {
  const context = useContext(CartContext);
  if (!context) {
    return {
      cart: null,
      itemCount: 0,
      isLoading: false,
      addItem: async () => {},
      updateQuantity: async () => {},
      removeItem: async () => {},
      refreshCart: async () => {},
    };
  }
  return context;
};
