// apps/demo-app/src/services/customerService.ts — in-memory customer
// accounts. No real datastore: this fixture is about realistic route SHAPE
// for Vayo to document, not about being an actual store.

export interface Customer {
  id: string;
  name: string;
  email: string;
  password: string;
  role: "customer";
  status: "active" | "suspended";
}

const customers: Customer[] = [
  { id: "cus_1", name: "Jane Doe", email: "jane@example.com", password: "pass1234", role: "customer", status: "active" },
  { id: "cus_2", name: "Sam Lee", email: "sam@example.com", password: "pass1234", role: "customer", status: "active" },
];

export function findCustomerByEmail(email: string): Customer | undefined {
  return customers.find((c) => c.email === email);
}

export function getCustomerById(id: string): Customer | undefined {
  return customers.find((c) => c.id === id);
}

export function listCustomers(): Customer[] {
  return customers;
}

export function createCustomer(input: { name: string; email: string; password: string }): Customer {
  const customer: Customer = { id: `cus_${customers.length + 1}`, role: "customer", status: "active", ...input };
  customers.push(customer);
  return customer;
}
