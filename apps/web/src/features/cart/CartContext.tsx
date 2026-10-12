import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { cartApi, type CartDto, type CartItemDto } from './api/cart';
import { useAuth } from '../auth/AuthContext';

export interface OptimisticItemSnapshot {
  skuId: string;
  merchantTenantId: string;
  unitPriceAmount: number;
  currency: string;
  productTitle?: string | null;
  productThumbnailUrl?: string | null;
}

interface CartContextType {
  cart: CartDto | null;
  itemCount: number;
  isLoading: boolean;
  /** Number of in-flight cart mutations (drives pending UI without blocking). */
  pendingMutations: number;
  addItem: (
    listingId: string,
    quantity?: number,
    optimistic?: OptimisticItemSnapshot,
  ) => Promise<void>;
  updateQuantity: (itemId: string, quantity: number) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  refreshCart: () => Promise<void>;
}

const CartContext = createContext<CartContextType | null>(null);

const totalsOf = (
  items: CartItemDto[],
): { subtotalAmount: number; itemCount: number; currency: string | null } => {
  const subtotalAmount = items.reduce((sum, it) => sum + it.quantity * it.unitPriceAmount, 0);
  const itemCount = items.reduce((sum, it) => sum + it.quantity, 0);
  const currency = items.length > 0 ? (items[0]?.currency ?? null) : null;
  return { subtotalAmount, itemCount, currency };
};

type MutationOutcome<T> =
  { ok: true; result: T; isLatest: boolean } | { ok: false; error: unknown; isLatest: boolean };

export const CartProvider = ({ children }: { children: ReactNode }) => {
  const { isAuthenticated } = useAuth();
  const [cart, setCart] = useState<CartDto | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingMutations, setPendingMutations] = useState(0);
  // Monotonic generation: only the latest-started mutation may write its
  // server response or roll back, so a slow earlier request can never
  // overwrite newer optimistic state.
  const generationRef = useRef(0);

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

  const runMutation = useCallback(
    async <T,>(work: () => Promise<T>): Promise<MutationOutcome<T>> => {
      const generation = ++generationRef.current;
      setPendingMutations((n) => n + 1);
      try {
        const result = await work();
        return { ok: true, result, isLatest: generation === generationRef.current };
      } catch (error) {
        return { ok: false, error, isLatest: generation === generationRef.current };
      } finally {
        setPendingMutations((n) => Math.max(0, n - 1));
      }
    },
    [],
  );

  const addItem = useCallback(
    async (listingId: string, quantity = 1, optimistic?: OptimisticItemSnapshot) => {
      const previous = cart;
      if (previous && optimistic) {
        const existing = previous.items.find((it) => it.listingId === listingId);
        let items: CartItemDto[];
        if (existing) {
          items = previous.items.map((it) =>
            it.listingId === listingId
              ? {
                  ...it,
                  quantity: it.quantity + quantity,
                  lineTotalAmount: (it.quantity + quantity) * it.unitPriceAmount,
                }
              : it,
          );
        } else {
          const now = new Date().toISOString();
          items = [
            ...previous.items,
            {
              id: `temp-${listingId}`,
              listingId,
              skuId: optimistic.skuId,
              merchantTenantId: optimistic.merchantTenantId,
              productId: null,
              productTitle: optimistic.productTitle ?? null,
              productBrand: null,
              productThumbnailUrl: optimistic.productThumbnailUrl ?? null,
              quantity,
              unitPriceAmount: optimistic.unitPriceAmount,
              lineTotalAmount: quantity * optimistic.unitPriceAmount,
              currency: optimistic.currency,
              listingStatus: 'ACTIVE',
              isAvailable: true,
              createdAt: now,
              updatedAt: now,
            },
          ];
        }
        const totals = totalsOf(items);
        setCart({
          ...previous,
          items,
          itemCount: totals.itemCount,
          subtotalAmount: totals.subtotalAmount,
          currency: totals.currency ?? previous.currency,
        });
      }
      const outcome = await runMutation(() => cartApi.addItem(listingId, quantity));
      if (outcome.ok) {
        if (outcome.isLatest) setCart(outcome.result);
      } else {
        if (outcome.isLatest) setCart(previous);
        throw outcome.error;
      }
    },
    [cart, runMutation],
  );

  const updateQuantity = useCallback(
    async (itemId: string, quantity: number) => {
      const previous = cart;
      if (previous) {
        const items = previous.items.map((it) =>
          it.id === itemId
            ? { ...it, quantity, lineTotalAmount: quantity * it.unitPriceAmount }
            : it,
        );
        const totals = totalsOf(items);
        setCart({
          ...previous,
          items,
          itemCount: totals.itemCount,
          subtotalAmount: totals.subtotalAmount,
          currency: totals.currency ?? previous.currency,
        });
      }
      const outcome = await runMutation(() => cartApi.updateQuantity(itemId, quantity));
      if (outcome.ok) {
        if (outcome.isLatest) setCart(outcome.result);
      } else {
        if (outcome.isLatest) setCart(previous);
        throw outcome.error;
      }
    },
    [cart, runMutation],
  );

  const removeItem = useCallback(
    async (itemId: string) => {
      const previous = cart;
      if (previous) {
        const items = previous.items.filter((it) => it.id !== itemId);
        const totals = totalsOf(items);
        setCart({
          ...previous,
          items,
          itemCount: totals.itemCount,
          subtotalAmount: totals.subtotalAmount,
          currency: totals.currency ?? previous.currency,
        });
      }
      const outcome = await runMutation(() => cartApi.removeItem(itemId));
      if (outcome.ok) {
        if (outcome.isLatest) setCart(outcome.result);
      } else {
        if (outcome.isLatest) setCart(previous);
        throw outcome.error;
      }
    },
    [cart, runMutation],
  );

  const itemCount = cart?.items?.reduce((sum, it) => sum + it.quantity, 0) ?? 0;

  return (
    <CartContext.Provider
      value={{
        cart,
        itemCount,
        isLoading,
        pendingMutations,
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
      pendingMutations: 0,
      addItem: async () => {},
      updateQuantity: async () => {},
      removeItem: async () => {},
      refreshCart: async () => {},
    };
  }
  return context;
};
