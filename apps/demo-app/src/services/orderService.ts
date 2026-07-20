// apps/demo-app/src/services/orderService.ts — in-memory orders.

export interface Order {
  id: string;
  customerId: string;
  items: Array<{ productId: string; quantity: number }>;
  total: number;
  status: "pending" | "shipped" | "delivered" | "cancelled";
  createdAt: string;
}

const orders: Order[] = [
  {
    id: "ord_1",
    customerId: "cus_1",
    items: [{ productId: "prod_1", quantity: 2 }],
    total: 49.98,
    status: "shipped",
    createdAt: new Date().toISOString(),
  },
];

export function listOrdersForCustomer(customerId: string): Order[] {
  return orders.filter((o) => o.customerId === customerId);
}

export function listAllOrders(): Order[] {
  return orders;
}

export function getOrderById(id: string): Order | undefined {
  return orders.find((o) => o.id === id);
}

export function createOrder(customerId: string, items: Array<{ productId: string; quantity: number }>, total: number): Order {
  const order: Order = { id: `ord_${orders.length + 1}`, customerId, items, total, status: "pending", createdAt: new Date().toISOString() };
  orders.push(order);
  return order;
}

export function updateOrderStatus(id: string, status: Order["status"]): Order | undefined {
  const order = orders.find((o) => o.id === id);
  if (order) order.status = status;
  return order;
}
