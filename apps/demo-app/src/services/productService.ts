// apps/demo-app/src/services/productService.ts — in-memory product catalog.

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  sku: string;
}

const products: Product[] = [
  { id: "prod_1", name: "Wireless Mouse", description: "Ergonomic 2.4GHz wireless mouse.", price: 24.99, sku: "WM-001" },
  { id: "prod_2", name: "Mechanical Keyboard", description: "Hot-swappable mechanical keyboard.", price: 89.99, sku: "MK-014" },
  { id: "prod_3", name: "USB-C Hub", description: "7-in-1 USB-C hub with HDMI.", price: 34.5, sku: "UH-007" },
];

export function listProducts(): Product[] {
  return products;
}

export function getProductById(id: string): Product | undefined {
  return products.find((p) => p.id === id);
}

export function createProduct(input: { name: string; description: string; price: number; sku: string }): Product {
  const product: Product = { id: `prod_${products.length + 1}`, ...input };
  products.push(product);
  return product;
}

export function updateProduct(id: string, patch: Partial<Pick<Product, "name" | "description" | "price">>): Product | undefined {
  const product = products.find((p) => p.id === id);
  if (product) Object.assign(product, patch);
  return product;
}
