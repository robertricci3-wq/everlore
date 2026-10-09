import { now, type Store } from "../store.js";
export function migrateCommerce(s: Store) {
  s.db.exec(`
CREATE TABLE IF NOT EXISTS print_bundles(id TEXT PRIMARY KEY,editionId TEXT NOT NULL UNIQUE,projectId TEXT NOT NULL,body TEXT NOT NULL,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS book_orders(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL,projectId TEXT NOT NULL,editionId TEXT NOT NULL,bundleId TEXT NOT NULL,amountCents INTEGER NOT NULL,mode TEXT NOT NULL,sku TEXT NOT NULL,shippingMethod TEXT NOT NULL,status TEXT NOT NULL,checkoutId TEXT UNIQUE,checkoutUrl TEXT,providerId TEXT,recipient TEXT,error TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,UNIQUE(ownerId,editionId));
CREATE TABLE IF NOT EXISTS print_quotes(orderId TEXT PRIMARY KEY,body TEXT NOT NULL,estimatedCents INTEGER NOT NULL,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payment_events(id TEXT PRIMARY KEY,orderId TEXT NOT NULL,createdAt TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS checkout_attempts(id TEXT PRIMARY KEY,orderId TEXT NOT NULL,sequence INTEGER NOT NULL,status TEXT NOT NULL,idempotencyKey TEXT NOT NULL UNIQUE,sessionId TEXT UNIQUE,url TEXT,error TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,UNIQUE(orderId,sequence));
CREATE TABLE IF NOT EXISTS order_refunds(id TEXT PRIMARY KEY,orderId TEXT NOT NULL UNIQUE,status TEXT NOT NULL,amountCents INTEGER NOT NULL,reason TEXT NOT NULL,providerId TEXT UNIQUE,error TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS order_support(id TEXT PRIMARY KEY,orderId TEXT NOT NULL,ownerId TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
`);
  const columns = new Set(
    s
      .all<{ name: string }>("PRAGMA table_info(book_orders)")
      .map((x) => x.name),
  );
  for (const [name, type] of Object.entries({
    automaticTax: "INTEGER NOT NULL DEFAULT 0",
    taxCents: "INTEGER",
    totalCents: "INTEGER",
    paymentFeeCents: "INTEGER",
    refundedCents: "INTEGER NOT NULL DEFAULT 0",
    paymentIntent: "TEXT",
    receiptUrl: "TEXT",
    tracking: "TEXT",
    shippingCheckedAt: "TEXT",
    shippingNextCheckAt: "TEXT",
    duplicatePayment: "INTEGER NOT NULL DEFAULT 0",
    providerCosts: "TEXT",
  }))
    if (!columns.has(name))
      s.db.exec(`ALTER TABLE book_orders ADD COLUMN ${name} ${type}`);
  // Preserve historical checkout sessions as attempt 1; never create a second charge on migration.
  s.run(`INSERT OR IGNORE INTO checkout_attempts(id,orderId,sequence,status,idempotencyKey,sessionId,url,createdAt,updatedAt)
    SELECT 'legacy-'||id,id,1,CASE WHEN recipient IS NOT NULL THEN 'paid' ELSE 'open' END,
    'everlore-checkout-'||id,checkoutId,checkoutUrl,createdAt,updatedAt FROM book_orders WHERE checkoutId IS NOT NULL`);
  s.run(`INSERT OR IGNORE INTO checkout_attempts(id,orderId,sequence,status,idempotencyKey,createdAt,updatedAt)
    SELECT 'legacy-'||id,id,1,'unknown','everlore-checkout-'||id,createdAt,updatedAt FROM book_orders
    WHERE checkoutId IS NULL AND recipient IS NULL AND status IN ('checkout_request_sent','needs_attention')
    AND NOT EXISTS(SELECT 1 FROM checkout_attempts a WHERE a.orderId=book_orders.id)`);
}
export interface CheckoutAttempt {
  id: string;
  orderId: string;
  sequence: number;
  status: string;
  idempotencyKey: string;
  sessionId: string | null;
  url: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface RefundRow {
  id: string;
  orderId: string;
  status: string;
  amountCents: number;
  reason: string;
  providerId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface OrderRow {
  id: string;
  ownerId: string;
  projectId: string;
  editionId: string;
  bundleId: string;
  amountCents: number;
  mode: "test" | "live";
  sku: string;
  shippingMethod: string;
  status: string;
  checkoutId: string | null;
  checkoutUrl: string | null;
  providerId: string | null;
  recipient: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  automaticTax: number;
  taxCents: number | null;
  totalCents: number | null;
  paymentFeeCents: number | null;
  refundedCents: number;
  paymentIntent: string | null;
  receiptUrl: string | null;
  tracking: string | null;
  shippingCheckedAt: string | null;
  shippingNextCheckAt: string | null;
  duplicatePayment: number;
  providerCosts: string | null;
}

/** Run once when the exclusive process starts, never as part of a read-only migration. */
export function recoverInterruptedCommerce(s: Store) {
  s.run(
    "UPDATE book_orders SET status='needs_attention',error='The service restarted during a provider request. Reconciliation is required.',updatedAt=? WHERE status IN ('dispatching','checkout_request_sent')",
    now(),
  );
  s.run(
    "UPDATE checkout_attempts SET status='unknown',error='The service restarted during checkout creation.',updatedAt=? WHERE status='request_sent'",
    now(),
  );
  s.run(
    "UPDATE order_refunds SET status='unknown',error='The service restarted during a refund request. Reconciliation is required.',updatedAt=? WHERE status='request_sent'",
    now(),
  );
}
