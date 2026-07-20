// apps/demo-app/src/services/adminService.ts — in-memory admin and
// super-admin accounts (the demo app's OWN business roles — unrelated to
// Vayo's own viewer/editor/owner doc-collaborator roles).

export interface AdminAccount {
  id: string;
  name: string;
  email: string;
  password: string;
  role: "admin" | "super_admin";
}

const admins: AdminAccount[] = [
  { id: "adm_1", name: "Priya Shah", email: "priya@shop.internal", password: "pass1234", role: "admin" },
  { id: "adm_2", name: "Root Admin", email: "root@shop.internal", password: "pass1234", role: "super_admin" },
];

export function findAdminByEmail(email: string): AdminAccount | undefined {
  return admins.find((a) => a.email === email);
}

export function listAdmins(): AdminAccount[] {
  return admins;
}

export function createAdmin(input: { name: string; email: string; password: string; role: "admin" | "super_admin" }): AdminAccount {
  const admin: AdminAccount = { id: `adm_${admins.length + 1}`, ...input };
  admins.push(admin);
  return admin;
}

export function updateAdmin(id: string, patch: Partial<Pick<AdminAccount, "role" | "name">>): AdminAccount | undefined {
  const admin = admins.find((a) => a.id === id);
  if (admin) Object.assign(admin, patch);
  return admin;
}
