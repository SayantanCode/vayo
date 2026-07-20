// apps/demo-app/src/services/cartService.ts — in-memory per-customer cart.

export interface CartItem {
  itemId: string;
  productId: string;
  quantity: number;
}

const cartsByCustomerId = new Map<string, CartItem[]>();

function cartFor(customerId: string): CartItem[] {
  if (!cartsByCustomerId.has(customerId)) cartsByCustomerId.set(customerId, []);
  return cartsByCustomerId.get(customerId)!;
}

export function getCart(customerId: string): CartItem[] {
  return cartFor(customerId);
}

export function addCartItem(customerId: string, productId: string, quantity: number): CartItem {
  const items = cartFor(customerId);
  const item: CartItem = { itemId: `item_${items.length + 1}`, productId, quantity };
  items.push(item);
  return item;
}

export function updateCartItem(customerId: string, itemId: string, quantity: number): CartItem | undefined {
  const item = cartFor(customerId).find((i) => i.itemId === itemId);
  if (item) item.quantity = quantity;
  return item;
}

export function removeCartItem(customerId: string, itemId: string): void {
  const items = cartFor(customerId);
  const index = items.findIndex((i) => i.itemId === itemId);
  if (index !== -1) items.splice(index, 1);
}
