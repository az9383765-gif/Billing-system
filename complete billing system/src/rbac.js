// Frontend mirror of the server permission matrix (server/lib.js -> can()).
// Keep the two lists in sync: what the UI hides must also be refused by the API.
//
// The signed-in user's per-person overrides (user.perms, sent by login/me) win
// over the role matrix for THIS session's UI. roleCan() stays pure — use it for
// maths about somebody ELSE (e.g. the Head editing another person's modules).

let activeRole = null;
let activePerms = null;

export function syncActiveUser(u) {
  activeRole = u?.role || null;
  activePerms = u?.perms || null;
}

const ALL_CAPS = [
  'products_manage',
  'stock_add',
  'stock_request',
  'stock_approve',
  'stock_view',
  'lowstock_view',
  'reports_view',
  'invoices_create',
  'invoices_view',
  'invoices_void',
  'returns',
  'invoices_export',
  'customers_manage',
  'customers_delete',
  'settings',
  'users',
  'expenses_view',
  'expenses_manage',
  'sync'
];

export const MATRIX = {
  // Head controls everything and every person
  admin: new Set(ALL_CAPS),

  // Inventory Manager: asks for stock (Head approves) + reads sales reports
  inventory: new Set([
    'stock_request', 'stock_view', 'lowstock_view', 'reports_view',
    'invoices_create', 'invoices_view', 'invoices_export',
    'customers_manage'
  ]),

  // Cashier: scans, bills, prints, sees low stock
  cashier: new Set([
    'lowstock_view', 'invoices_create', 'invoices_view', 'customers_manage'
  ])
};

export const ROLE_LABELS = {
  admin: 'Head',
  inventory: 'Inventory Manager',
  cashier: 'Cashier'
};

export const ROLES = ['admin', 'inventory', 'cashier'];

export function can(role, cap) {
  // a list of caps means "any one of these opens the door" — e.g. Settings
  // opens for the Settings module OR the Users module
  if (Array.isArray(cap)) return cap.some(c => can(role, c));
  if (activePerms && role === activeRole && Object.prototype.hasOwnProperty.call(activePerms, cap)) {
    return Boolean(activePerms[cap]);
  }
  const set = MATRIX[role];
  return Boolean(set && set.has(cap));
}

// pure role matrix — never consults the signed-in person's overrides
export function roleCan(role, cap) {
  const set = MATRIX[role];
  return Boolean(set && set.has(cap));
}
