import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Store, id, now, hash } from "../store.js";
import { isRecoveryLocked } from "../recovery-lock.js";
import { createCheckout, CheckoutError } from "../payments/checkout.js";
import type { CommerceSettings } from "./config.js";
import { readiness, fulfillmentReadiness } from "./config.js";
import type { OrderRow, CheckoutAttempt, RefundRow } from "./schema.js";
import {
  preparePrint,
  loadPrintBundle,
  verifyPrintProduct,
  type PrintBundle,
} from "./print.js";
const Address = z.object({
  line1: z.string().min(1),
  line2: z.string().nullable().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  postal_code: z.string().min(1),
  country: z.literal("US"),
});
const Recipient = z.object({ name: z.string().min(1), address: Address });
const host = (mode: string) =>
  mode === "live"
    ? "https://api.prodigi.com"
    : "https://api.sandbox.prodigi.com";
export function order(s: Store, oid: string, owner?: string) {
  const row = s.one<OrderRow>("SELECT * FROM book_orders WHERE id=?", oid);
  if (!row || (owner && row.ownerId !== owner))
    throw new CheckoutError("Order unavailable.");
  return row;
}
export function view(o: OrderRow) {
  return {
    id: o.id,
    projectId: o.projectId,
    editionId: o.editionId,
    status: o.status,
    amountCents: o.amountCents,
    currency: "USD",
    checkoutUrl: o.status === "awaiting_payment" ? o.checkoutUrl : null,
    error: o.error,
    createdAt: o.createdAt,
    taxCents: o.taxCents,
    refundedCents: o.refundedCents,
    totalCents: o.totalCents,
    receiptUrl: o.receiptUrl,
    tracking: o.tracking ? JSON.parse(o.tracking) : [],
    canRenew: o.status === "checkout_expired",
    duplicatePayment: Boolean(o.duplicatePayment),
  };
}
async function json(request: typeof fetch, url: string, init: RequestInit) {
  const r = await request(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw new CheckoutError(
      "Provider request was not confirmed. Completed work is retained.",
    );
  }
  return r.json();
}
function printAssets(bundle: PrintBundle) {
  return bundle.version === 2
    ? bundle.assets
    : [
        {
          printArea: "default",
          pdfHash: bundle.pdfHash,
          pageCount: bundle.pageCount,
        },
      ];
}
export async function prepareProductPrint(
  s: Store,
  projectId: string,
  editionId: string,
  c: CommerceSettings,
  request: typeof fetch = fetch,
) {
  if (!c.sku || !c.prodigiKey) return preparePrint(s, projectId, editionId);
  const catalog = await json(
    request,
    `${host(c.mode)}/v4.0/products/${encodeURIComponent(c.sku)}`,
    { headers: { "X-API-Key": c.prodigiKey } },
  );
  const areas = z
    .object({
      product: z.object({
        printAreas: z.record(z.string(), z.object({ required: z.boolean() })),
      }),
    })
    .parse(catalog).product.printAreas;
  const spine = areas.spine?.required
    ? await json(request, `${host(c.mode)}/v4.0/products/spine`, {
        method: "POST",
        headers: {
          "X-API-Key": c.prodigiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sku: c.sku,
          destinationCountryCode: "US",
          numberOfPages: 34,
        }),
      })
    : undefined;
  const product = verifyPrintProduct(catalog, c.sku, { spine });
  return preparePrint(s, projectId, editionId, { product });
}
export async function startOrder(
  s: Store,
  owner: string,
  projectId: string,
  editionId: string,
  c: CommerceSettings,
  request: typeof fetch = fetch,
) {
  if (isRecoveryLocked(s))
    throw new CheckoutError(
      "This restored service needs operator reconciliation before accepting payments.",
    );
  const reasons = readiness(c);
  if (reasons.length) throw new CheckoutError(reasons.join(" "));
  if (
    !s.one("SELECT id FROM projects WHERE id=? AND ownerId=?", projectId, owner)
  )
    throw new CheckoutError("Saved edition unavailable.");
  const existing = s.one<OrderRow>(
    "SELECT * FROM book_orders WHERE ownerId=? AND editionId=?",
    owner,
    editionId,
  );
  if (existing) {
    if (existing.status === "creating_checkout")
      return openAttempt(s, existing.id, c, request);
    return view(existing);
  }
  const bundle = await prepareProductPrint(s, projectId, editionId, c, request);
  if (!bundle.ready) throw new CheckoutError(bundle.issues.join(" "));
  const quoteResponse = await json(request, `${host(c.mode)}/v4.0/quotes`, {
    method: "POST",
    headers: { "X-API-Key": c.prodigiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      shippingMethod: c.shippingMethod,
      destinationCountryCode: "US",
      currencyCode: "USD",
      items: [
        {
          sku: c.sku,
          copies: 1,
          attributes:
            bundle.version === 2 ? (bundle.product?.attributes ?? {}) : {},
          assets: printAssets(bundle).map((asset) => ({
            printArea: asset.printArea,
            pageCount: asset.pageCount,
          })),
        },
      ],
    }),
  });
  const money = z.object({
    amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
    currency: z.literal("USD"),
  });
  const quotes = z
    .object({
      outcome: z.literal("Created"),
      quotes: z
        .array(
          z.object({
            shipmentMethod: z.string(),
            costSummary: z.object({ items: money, shipping: money }),
          }),
        )
        .min(1),
    })
    .parse(quoteResponse);
  const quote = quotes.quotes.find(
    (q) => q.shipmentMethod === c.shippingMethod,
  );
  if (!quote)
    throw new CheckoutError(
      "Standard delivery is unavailable for this product.",
    );
  const cents = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  };
  const estimatedCents =
    cents(quote.costSummary.items.amount) +
    cents(quote.costSummary.shipping.amount);
  if (!Number.isSafeInteger(estimatedCents) || estimatedCents > c.priceCents)
    throw new CheckoutError(
      "The configured selling price does not cover the current print and shipping estimate.",
    );
  const oid = s.transaction(() => {
    const found = s.one<OrderRow>(
      "SELECT * FROM book_orders WHERE ownerId=? AND editionId=?",
      owner,
      editionId,
    );
    if (found) return found.id;
    const oid = id();
    s.run(
      "INSERT INTO book_orders(id,ownerId,projectId,editionId,bundleId,amountCents,mode,sku,shippingMethod,automaticTax,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,'creating_checkout',?,?)",
      oid,
      owner,
      projectId,
      editionId,
      bundle.id,
      c.priceCents,
      c.mode,
      c.sku,
      c.shippingMethod,
      c.automaticTax ? 1 : 0,
      now(),
      now(),
    );
    s.run(
      "INSERT INTO print_quotes VALUES(?,?,?,?)",
      oid,
      JSON.stringify(quote),
      estimatedCents,
      now(),
    );
    return oid;
  });
  return openAttempt(s, oid, c, request);
}

async function openAttempt(
  s: Store,
  oid: string,
  c: CommerceSettings,
  request: typeof fetch,
) {
  const attempt = s.transaction(() => {
    const o = order(s, oid);
    if (o.status !== "creating_checkout" || o.recipient) return null;
    const sequence =
      (s.one<{ n: number }>(
        "SELECT COALESCE(MAX(sequence),0) n FROM checkout_attempts WHERE orderId=?",
        oid,
      )?.n ?? 0) + 1;
    const aid = id();
    s.run(
      "INSERT INTO checkout_attempts(id,orderId,sequence,status,idempotencyKey,createdAt,updatedAt) VALUES(?,?,?,'request_sent',?,?,?)",
      aid,
      oid,
      sequence,
      `everlore-checkout-${aid}`,
      now(),
      now(),
    );
    s.run(
      "UPDATE book_orders SET status='checkout_request_sent',error=NULL,updatedAt=? WHERE id=?",
      now(),
      oid,
    );
    return s.one<CheckoutAttempt>(
      "SELECT * FROM checkout_attempts WHERE id=?",
      aid,
    )!;
  });
  if (!attempt) return view(order(s, oid));
  const o = order(s, oid);
  try {
    const session = await createCheckout(
      c.stripeKey,
      {
        orderId: oid,
        editionId: o.editionId,
        amountCents: o.amountCents,
        origin: c.origin!,
        attemptId: attempt.id,
        automaticTax: Boolean(o.automaticTax),
      },
      request,
    );
    s.transaction(() => {
      // A webhook can complete first. A late POST response must not undo the payment.
      s.run(
        "UPDATE checkout_attempts SET sessionId=COALESCE(sessionId,?),url=?,status=CASE WHEN status='request_sent' THEN 'open' ELSE status END,updatedAt=? WHERE id=?",
        session.id,
        session.url,
        now(),
        attempt.id,
      );
      s.run(
        "UPDATE book_orders SET checkoutId=?,checkoutUrl=?,status='awaiting_payment',updatedAt=? WHERE id=? AND status='checkout_request_sent' AND recipient IS NULL",
        session.id,
        session.url,
        now(),
        oid,
      );
    });
  } catch {
    s.run(
      "UPDATE checkout_attempts SET status='unknown',error='Checkout response was not confirmed.',updatedAt=? WHERE id=? AND status='request_sent'",
      now(),
      attempt.id,
    );
    s.run(
      "UPDATE book_orders SET status='needs_attention',error='Checkout was not confirmed. We will reconcile this order before trying again.',updatedAt=? WHERE id=? AND status='checkout_request_sent' AND recipient IS NULL",
      now(),
      oid,
    );
  }
  return view(order(s, oid));
}

const cents = z.number().int().nonnegative().safe();
const PaidSession = z.object({
  id: z.string(),
  mode: z.literal("payment"),
  livemode: z.boolean(),
  payment_status: z.string(),
  status: z.string(),
  currency: z.string().nullable(),
  amount_total: cents.nullable(),
  amount_subtotal: cents.optional().nullable(),
  total_details: z
    .object({
      amount_tax: cents,
      amount_shipping: cents,
      amount_discount: cents,
    })
    .optional(),
  automatic_tax: z
    .object({ enabled: z.boolean(), status: z.string().nullable() })
    .optional(),
  client_reference_id: z.string(),
  metadata: z.object({
    orderId: z.string(),
    editionId: z.string(),
    attemptId: z.string().optional(),
  }),
  url: z.string().nullable().optional(),
  payment_intent: z
    .union([
      z.string(),
      z.object({
        id: z.string(),
        latest_charge: z
          .union([
            z.string(),
            z.object({
              receipt_url: z.string().nullable().optional(),
              refunded: z.boolean().optional(),
              amount_refunded: cents.optional(),
              balance_transaction: z
                .union([
                  z.string(),
                  z.object({ fee: cents, currency: z.string() }),
                ])
                .nullable()
                .optional(),
            }),
          ])
          .nullable()
          .optional(),
      }),
    ])
    .nullable()
    .optional(),
  shipping_details: Recipient.nullable().optional(),
  collected_information: z
    .object({ shipping_details: Recipient.nullable().optional() })
    .optional(),
});
function safeHttps(value: string | null | undefined, stripeOnly = false) {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (!stripeOnly || u.hostname.endsWith(".stripe.com"))
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export async function reconcilePayment(
  s: Store,
  oid: string,
  c: CommerceSettings,
  request: typeof fetch = fetch,
  sessionId?: string,
) {
  const o = order(s, oid),
    sid = sessionId ?? o.checkoutId;
  if (!sid || !/^cs_[A-Za-z0-9_]+$/.test(sid) || o.mode !== c.mode) return;
  const p = PaidSession.parse(
    await json(
      request,
      `https://api.stripe.com/v1/checkout/sessions/${sid}?expand[]=payment_intent.latest_charge.balance_transaction`,
      { headers: { Authorization: `Bearer ${c.stripeKey}` } },
    ),
  );
  if (
    p.id !== sid ||
    p.livemode !== (o.mode === "live") ||
    p.client_reference_id !== oid ||
    p.metadata.orderId !== oid ||
    p.metadata.editionId !== o.editionId
  )
    throw new CheckoutError("Payment does not match the saved order.");
  let attempt = s.one<CheckoutAttempt>(
    "SELECT * FROM checkout_attempts WHERE orderId=? AND sessionId=?",
    oid,
    sid,
  );
  if (!attempt && p.metadata.attemptId)
    attempt = s.one<CheckoutAttempt>(
      "SELECT * FROM checkout_attempts WHERE orderId=? AND id=?",
      oid,
      p.metadata.attemptId,
    );
  if (!attempt && !p.metadata.attemptId)
    attempt = s.one<CheckoutAttempt>(
      "SELECT * FROM checkout_attempts WHERE orderId=? AND id=? AND sessionId IS NULL",
      oid,
      `legacy-${oid}`,
    );
  // Compatibility for sessions saved before attempts were introduced.
  if (
    !attempt &&
    o.checkoutId === sid &&
    !s.one("SELECT id FROM checkout_attempts WHERE orderId=?", oid)
  ) {
    s.run(
      "INSERT INTO checkout_attempts(id,orderId,sequence,status,idempotencyKey,sessionId,createdAt,updatedAt) VALUES(?,?,1,'open',?,?,?,?)",
      `legacy-${oid}`,
      oid,
      `everlore-checkout-${oid}`,
      sid,
      now(),
      now(),
    );
    attempt = s.one<CheckoutAttempt>(
      "SELECT * FROM checkout_attempts WHERE orderId=? AND sessionId=?",
      oid,
      sid,
    );
  }
  if (
    !attempt ||
    (attempt.sessionId && attempt.sessionId !== sid) ||
    (p.metadata.attemptId && p.metadata.attemptId !== attempt.id)
  )
    throw new CheckoutError(
      "Payment session does not match a saved checkout attempt.",
    );
  const subtotal =
    p.amount_subtotal ?? (!o.automaticTax ? p.amount_total : null);
  const tax = p.total_details?.amount_tax ?? 0;
  if (
    p.currency !== "usd" ||
    subtotal !== o.amountCents ||
    p.amount_total !== o.amountCents + tax ||
    (p.total_details?.amount_discount ?? 0) !== 0 ||
    (p.total_details?.amount_shipping ?? 0) !== 0 ||
    (!o.automaticTax && tax !== 0) ||
    (o.automaticTax && (!p.total_details || !p.automatic_tax?.enabled))
  )
    throw new CheckoutError(
      "Payment amount or tax does not match the saved order.",
    );
  if (p.payment_status !== "paid" || p.status !== "complete") {
    if (p.status === "expired" && p.payment_status === "unpaid") {
      s.run(
        "UPDATE checkout_attempts SET sessionId=?,status='expired',updatedAt=? WHERE id=? AND status!='paid'",
        sid,
        now(),
        attempt.id,
      );
      s.run(
        "UPDATE book_orders SET status='checkout_expired',error=NULL,updatedAt=? WHERE id=? AND recipient IS NULL AND status IN ('awaiting_payment','needs_attention','checkout_request_sent') AND NOT EXISTS(SELECT 1 FROM checkout_attempts WHERE orderId=? AND status!='expired')",
        now(),
        oid,
        oid,
      );
    } else if (p.status === "open" && p.payment_status === "unpaid") {
      const url = safeHttps(p.url, true);
      s.run(
        "UPDATE checkout_attempts SET sessionId=?,url=COALESCE(?,url),status='open',error=NULL,updatedAt=? WHERE id=? AND status!='paid'",
        sid,
        url,
        now(),
        attempt.id,
      );
      if (url)
        s.run(
          "UPDATE book_orders SET checkoutId=?,checkoutUrl=?,status='awaiting_payment',error=NULL,updatedAt=? WHERE id=? AND recipient IS NULL AND status IN ('needs_attention','checkout_request_sent','awaiting_payment')",
          sid,
          url,
          now(),
          oid,
        );
    }
    return;
  }
  if (o.automaticTax && p.automatic_tax?.status !== "complete")
    throw new CheckoutError("Payment tax calculation is not complete.");
  const recipient =
    p.collected_information?.shipping_details ?? p.shipping_details;
  if (!recipient)
    throw new CheckoutError("A complete US delivery address is required.");
  const pi =
    typeof p.payment_intent === "string"
      ? p.payment_intent
      : (p.payment_intent?.id ?? null);
  const charge =
    typeof p.payment_intent === "object"
      ? p.payment_intent?.latest_charge
      : null;
  const receipt =
    charge && typeof charge === "object"
      ? safeHttps(charge.receipt_url, true)
      : null;
  const transaction =
    charge && typeof charge === "object" ? charge.balance_transaction : null;
  const fee =
    transaction &&
    typeof transaction === "object" &&
    transaction.currency === "usd"
      ? transaction.fee
      : null;
  const refundedCents =
    charge && typeof charge === "object"
      ? charge.refunded
        ? p.amount_total!
        : (charge.amount_refunded ?? 0)
      : 0;
  if (refundedCents > p.amount_total!)
    throw new CheckoutError("Refunded amount does not match the payment.");
  s.transaction(() => {
    const recordExternalRefund = () => {
      if (refundedCents > 0)
        s.run(
          "UPDATE book_orders SET refundedCents=?,status=?,error=?,updatedAt=? WHERE id=? AND checkoutId=? AND refundedCents<?",
          refundedCents,
          refundedCents === p.amount_total ? "refunded" : "needs_attention",
          refundedCents === p.amount_total
            ? null
            : "This payment was partially refunded. Support must reconcile it before further fulfillment.",
          now(),
          oid,
          sid,
          refundedCents,
        );
    };
    s.run(
      "UPDATE checkout_attempts SET sessionId=?,status='paid',error=NULL,updatedAt=? WHERE id=?",
      sid,
      now(),
      attempt.id,
    );
    const current = order(s, oid);
    if (current.recipient) {
      if (current.checkoutId !== sid)
        s.run(
          "UPDATE book_orders SET duplicatePayment=1,error='An additional payment was detected and needs operator reconciliation. No duplicate print order will be placed.',updatedAt=? WHERE id=?",
          now(),
          oid,
        );
      else
        s.run(
          "UPDATE book_orders SET paymentIntent=COALESCE(paymentIntent,?),receiptUrl=COALESCE(receiptUrl,?),taxCents=COALESCE(taxCents,?),totalCents=COALESCE(totalCents,?),paymentFeeCents=COALESCE(paymentFeeCents,?) WHERE id=?",
          pi,
          receipt,
          tax,
          p.amount_total,
          fee,
          oid,
        );
      recordExternalRefund();
      return;
    }
    s.run(
      "UPDATE book_orders SET status='paid',recipient=?,checkoutId=?,taxCents=?,totalCents=?,paymentIntent=?,receiptUrl=?,paymentFeeCents=?,error=NULL,updatedAt=? WHERE id=? AND recipient IS NULL AND providerId IS NULL",
      JSON.stringify(recipient),
      sid,
      tax,
      p.amount_total,
      pi,
      receipt,
      fee,
      now(),
      oid,
    );
    recordExternalRefund();
  });
}

// A bounded, read-only search can recover a lost POST response. An absent result is never proof that it failed.
export async function recoverCheckout(
  s: Store,
  oid: string,
  c: CommerceSettings,
  request: typeof fetch = fetch,
  sessionId?: string,
) {
  const o = order(s, oid);
  if (o.mode !== c.mode)
    throw new CheckoutError("Payment environment mismatch.");
  if (sessionId || o.checkoutId)
    await reconcilePayment(s, oid, c, request, sessionId);
  else {
    let after = "";
    for (let page = 0; page < 5; page++) {
      const query = new URLSearchParams({
        limit: "100",
        "created[gte]": String(Math.floor(Date.parse(o.createdAt) / 1000) - 60),
      });
      if (after) query.set("starting_after", after);
      const result = z
        .object({
          data: z.array(
            z.object({
              id: z.string(),
              client_reference_id: z.string().nullable(),
            }),
          ),
          has_more: z.boolean(),
        })
        .parse(
          await json(
            request,
            `https://api.stripe.com/v1/checkout/sessions?${query}`,
            { headers: { Authorization: `Bearer ${c.stripeKey}` } },
          ),
        );
      for (const item of result.data)
        if (item.client_reference_id === oid)
          await reconcilePayment(s, oid, c, request, item.id);
      if (!result.has_more || !result.data.length) break;
      after = result.data[result.data.length - 1].id;
    }
  }
  return view(order(s, oid));
}
export async function renewCheckout(
  s: Store,
  oid: string,
  owner: string,
  c: CommerceSettings,
  request: typeof fetch = fetch,
) {
  if (isRecoveryLocked(s))
    throw new CheckoutError(
      "This restored service needs operator reconciliation before accepting payments.",
    );
  if (readiness(c).length)
    throw new CheckoutError("New checkout is not available yet.");
  const o = order(s, oid, owner);
  if (o.recipient || o.mode !== c.mode) return view(o);
  const attempts = s.all<CheckoutAttempt>(
    "SELECT * FROM checkout_attempts WHERE orderId=? ORDER BY sequence",
    oid,
  );
  if (!attempts.length || attempts.some((a) => !a.sessionId))
    throw new CheckoutError("Checkout must be reconciled before renewal.");
  // Re-read every prior session immediately before renewing; only expired AND unpaid sessions qualify.
  for (const a of attempts)
    await reconcilePayment(s, oid, c, request, a.sessionId!);
  const claimed = s.transaction(() => {
    const current = order(s, oid);
    if (
      current.recipient ||
      current.status !== "checkout_expired" ||
      s.one(
        "SELECT id FROM checkout_attempts WHERE orderId=? AND status!='expired'",
        oid,
      )
    )
      return false;
    s.run(
      "UPDATE book_orders SET status='creating_checkout',checkoutId=NULL,checkoutUrl=NULL,updatedAt=? WHERE id=?",
      now(),
      oid,
    );
    return true;
  });
  if (claimed) return openAttempt(s, oid, c, request);
  return view(order(s, oid));
}
export function assetToken(
  oid: string,
  digest: string,
  expires: number,
  secret: string,
) {
  return createHmac("sha256", secret)
    .update(`${oid}:${digest}:${expires}`)
    .digest("hex");
}
export function printBytes(
  s: Store,
  oid: string,
  digest: string,
  expires: number,
  token: string,
  c: CommerceSettings,
) {
  if (
    !c.assetSecret ||
    !Number.isSafeInteger(expires) ||
    expires < Date.now() ||
    expires > Date.now() + 8 * 86400000 ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    throw new CheckoutError("Print asset link expired or unavailable.");
  const expected = assetToken(oid, digest, expires, c.assetSecret);
  if (!timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex")))
    throw new CheckoutError("Print asset unavailable.");
  const o = order(s, oid),
    b = loadPrintBundle(s, o.bundleId);
  if (
    !printAssets(b).some((a) => a.pdfHash === digest) ||
    !(
      [
        "paid",
        "dispatching",
        "submitted",
        "shipped",
        "needs_attention",
      ].includes(o.status) ||
      (Boolean(o.providerId) &&
        ["refund_pending", "refunded"].includes(o.status))
    ) ||
    !o.recipient
  )
    throw new CheckoutError("Print asset unavailable.");
  const bytes = s.readAsset(o.projectId, digest);
  if (hash(bytes) !== digest)
    throw new CheckoutError("Print asset integrity failure.");
  return bytes;
}
export async function fulfillOne(
  s: Store,
  c: CommerceSettings,
  request: typeof fetch = fetch,
) {
  if (isRecoveryLocked(s) || fulfillmentReadiness(c).length) return false;
  const o = s.transaction(() => {
    const r = s.one<OrderRow>(
      "SELECT * FROM book_orders WHERE status='paid' AND mode=? ORDER BY createdAt LIMIT 1",
      c.mode,
    );
    if (r)
      s.run(
        "UPDATE book_orders SET status='dispatching',updatedAt=? WHERE id=? AND status='paid'",
        now(),
        r.id,
      );
    return r;
  });
  if (!o) return false;
  try {
    const b = loadPrintBundle(s, o.bundleId),
      r = Recipient.parse(JSON.parse(o.recipient!));
    if (!b.ready || !c.origin || (b.version === 2 && b.product?.sku !== o.sku))
      throw new Error("Print not ready");
    const expires = Date.now() + 7 * 86400000;
    const assets = printAssets(b).map((asset) => ({
      printArea: asset.printArea,
      pageCount: asset.pageCount,
      url: `${c.origin}/api/print-assets/${o.id}/${asset.pdfHash}?expires=${expires}&token=${assetToken(o.id, asset.pdfHash, expires, c.assetSecret)}`,
    }));
    const result = await json(request, `${host(o.mode)}/v4.0/orders`, {
      method: "POST",
      headers: {
        "X-API-Key": c.prodigiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        merchantReference: o.id,
        idempotencyKey: o.id,
        shippingMethod: o.shippingMethod,
        recipient: {
          name: r.name,
          address: {
            line1: r.address.line1,
            line2: r.address.line2 ?? "",
            postalOrZipCode: r.address.postal_code,
            countryCode: r.address.country,
            townOrCity: r.address.city,
            stateOrCounty: r.address.state,
          },
        },
        items: [
          {
            sku: o.sku,
            copies: 1,
            sizing: "fillPrintArea",
            attributes: b.version === 2 ? (b.product?.attributes ?? {}) : {},
            assets,
          },
        ],
      }),
    });
    const parsed = z
      .object({
        outcome: z.string(),
        order: z.object({ id: z.string().min(1) }),
      })
      .parse(result);
    if (
      !["created", "onhold", "createdwithissues", "alreadyexists"].includes(
        parsed.outcome.toLowerCase(),
      )
    )
      throw new Error("Unconfirmed print result");
    s.run(
      "UPDATE book_orders SET status='submitted',providerId=?,updatedAt=? WHERE id=? AND status='dispatching'",
      parsed.order.id,
      now(),
      o.id,
    );
  } catch {
    s.run(
      "UPDATE book_orders SET status='needs_attention',error=?,updatedAt=? WHERE id=? AND status='dispatching'",
      "Printing was not confirmed. Your payment and book are saved; this order needs reconciliation before another submission.",
      now(),
      o.id,
    );
  }
  return true;
}
const Shipment = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  carrier: z
    .object({ name: z.string().optional() })
    .passthrough()
    .nullable()
    .optional(),
  dispatchDate: z.string().nullable().optional(),
  tracking: z
    .object({
      url: z.string().nullable().optional(),
      number: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
const ProviderOrder = z.object({
  id: z.string(),
  merchantReference: z.string().optional(),
  status: z
    .object({
      stage: z.string().optional(),
      issues: z.array(z.unknown()).optional(),
    })
    .nullable()
    .optional(),
  shipments: z.array(Shipment).optional(),
  charges: z.array(z.unknown()).optional(),
});
function applyShipping(s: Store, o: OrderRow, raw: unknown) {
  const p = ProviderOrder.parse(raw);
  if (
    p.id !== o.providerId ||
    (p.merchantReference && p.merchantReference !== o.id)
  )
    throw new CheckoutError("Shipment mismatch.");
  const current = order(s, o.id);
  const stage = p.status?.stage?.toLowerCase();
  // A slower earlier GET must not reverse a shipment/cancellation already observed.
  if (
    (current.status === "shipped" && stage !== "complete") ||
    (current.status === "cancelled" && stage !== "cancelled")
  )
    return;

  const failed = Boolean(p.status?.issues?.length);
  const status =
    stage === "cancelled"
      ? "cancelled"
      : stage === "complete"
        ? "shipped"
        : failed
          ? "provider_failed"
          : "submitted";
  const tracking = (p.shipments ?? []).map((shipment) => ({
    id: shipment.id ?? "",
    status: shipment.status ?? "Processing",
    carrier: shipment.carrier?.name ?? null,
    dispatchedAt: shipment.dispatchDate ?? null,
    number: shipment.tracking?.number ?? null,
    url: safeHttps(shipment.tracking?.url),
  }));
  s.run(
    "UPDATE book_orders SET status=?,tracking=?,providerCosts=?,shippingCheckedAt=?,shippingNextCheckAt=?,error=?,updatedAt=? WHERE id=? AND status IN ('submitted','provider_failed','shipped','cancelled')",
    status,
    tracking.length ? JSON.stringify(tracking) : (current.tracking ?? "[]"),
    p.charges?.length
      ? JSON.stringify(p.charges)
      : (current.providerCosts ?? "[]"),
    now(),
    new Date(Date.now() + 15 * 60000).toISOString(),
    status === "cancelled"
      ? "The printer cancelled this order. Support needs to arrange the next step."
      : failed
        ? "The printer reported an issue. Your order is saved for support."
        : null,
    now(),
    o.id,
  );
}
export async function refreshShipping(
  s: Store,
  oid: string,
  c: CommerceSettings,
  request: typeof fetch = fetch,
) {
  const o = order(s, oid);
  if (
    !o.providerId ||
    o.mode !== c.mode ||
    !["submitted", "provider_failed", "shipped", "cancelled"].includes(o.status)
  )
    return;
  const result = z
    .object({ order: z.unknown() })
    .parse(
      await json(
        request,
        `${host(o.mode)}/v4.0/orders/${encodeURIComponent(o.providerId)}`,
        { headers: { "X-API-Key": c.prodigiKey } },
      ),
    );
  applyShipping(s, o, result.order);
}
// Claim one due poll before network I/O. Restart and concurrent ticks cannot create a tight retry loop.
export async function pollShippingOne(
  s: Store,
  c: CommerceSettings,
  request: typeof fetch = fetch,
) {
  if (!c.prodigiKey) return false;
  const o = s.transaction(() => {
    const row = s.one<OrderRow>(
      "SELECT * FROM book_orders WHERE mode=? AND providerId IS NOT NULL AND (status IN ('submitted','provider_failed') OR (status='shipped' AND createdAt>datetime('now','-30 days'))) AND (shippingNextCheckAt IS NULL OR shippingNextCheckAt<=?) ORDER BY COALESCE(shippingNextCheckAt,createdAt) LIMIT 1",
      c.mode,
      now(),
    );
    if (row)
      s.run(
        "UPDATE book_orders SET shippingNextCheckAt=? WHERE id=?",
        new Date(Date.now() + 15 * 60000).toISOString(),
        row.id,
      );
    return row;
  });
  if (!o) return false;
  try {
    await refreshShipping(s, o.id, c, request);
  } catch {
    s.run(
      "UPDATE book_orders SET error='Shipment check is delayed. The saved order has not been resubmitted.',updatedAt=? WHERE id=?",
      now(),
      o.id,
    );
  }
  return true;
}

// Operator recovery is read-only at the provider. It never submits another print order.
export async function reconcilePrint(
  s: Store,
  oid: string,
  providerId: string,
  c: CommerceSettings,
  request: typeof fetch = fetch,
) {
  const o = order(s, oid);
  if (o.status !== "needs_attention" || !o.recipient || o.mode !== c.mode)
    throw new CheckoutError("This order is not awaiting print reconciliation.");
  const raw = await json(
    request,
    `${host(o.mode)}/v4.0/orders/${encodeURIComponent(providerId)}`,
    { headers: { "X-API-Key": c.prodigiKey } },
  );
  const result = z
    .object({
      order: z.object({
        id: z.string(),
        merchantReference: z.string(),
        status: z.object({ stage: z.string() }),
        items: z.array(z.object({ sku: z.string(), copies: z.number() })),
      }),
    })
    .parse(raw).order;
  if (
    result.id !== providerId ||
    result.merchantReference !== oid ||
    result.items.length !== 1 ||
    result.items[0].sku !== o.sku ||
    result.items[0].copies !== 1
  )
    throw new CheckoutError(
      "The provider order does not match this saved purchase.",
    );
  if (!["InProgress", "Complete", "Cancelled"].includes(result.status.stage))
    throw new CheckoutError(
      "The provider order needs further support; no new order was placed.",
    );
  s.run(
    "UPDATE book_orders SET providerId=?,status=?,error=NULL,updatedAt=? WHERE id=? AND status='needs_attention'",
    providerId,
    result.status.stage === "Complete"
      ? "shipped"
      : result.status.stage === "Cancelled"
        ? "cancelled"
        : "submitted",
    now(),
    oid,
  );
  return view(order(s, oid));
}

// Full refunds only in the pilot. An uncertain request is retained and reconciled with GET; never replayed.
export async function refundOrder(
  s: Store,
  oid: string,
  reason: string,
  c: CommerceSettings,
  request: typeof fetch = fetch,
) {
  if (isRecoveryLocked(s))
    throw new CheckoutError(
      "This restored service needs operator reconciliation before issuing refunds.",
    );
  if (!c.stripeKey.startsWith(c.mode === "live" ? "sk_live_" : "sk_test_"))
    throw new CheckoutError("The payment connection needs configuration.");
  if (!reason.trim() || reason.length > 1000)
    throw new CheckoutError("A short refund reason is required.");
  const claim = s.transaction(() => {
    const o = order(s, oid);
    const prior = s.one<RefundRow>(
      "SELECT * FROM order_refunds WHERE orderId=?",
      oid,
    );
    if (prior) return { o, refund: prior, send: false };
    if (
      o.mode !== c.mode ||
      !o.paymentIntent ||
      !o.recipient ||
      !o.totalCents ||
      o.duplicatePayment ||
      ![
        "paid",
        "submitted",
        "shipped",
        "cancelled",
        "provider_failed",
      ].includes(o.status)
    )
      throw new CheckoutError(
        "Reconcile the payment and printing outcome before refunding this order.",
      );
    const rid = id();
    s.run(
      "INSERT INTO order_refunds(id,orderId,status,amountCents,reason,createdAt,updatedAt) VALUES(?,?,'request_sent',?,?,?,?)",
      rid,
      oid,
      o.totalCents,
      reason.trim(),
      now(),
      now(),
    );
    s.run(
      "UPDATE book_orders SET status='refund_pending',updatedAt=? WHERE id=?",
      now(),
      oid,
    );
    return {
      o,
      refund: s.one<RefundRow>("SELECT * FROM order_refunds WHERE id=?", rid)!,
      send: true,
    };
  });
  if (!claim.send) return claim.refund;
  try {
    const form = new URLSearchParams({
      payment_intent: claim.o.paymentIntent!,
      amount: String(claim.refund.amountCents),
      "metadata[orderId]": oid,
      "metadata[refundId]": claim.refund.id,
    });
    const raw = await json(request, "https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `everlore-refund-${claim.refund.id}`,
      },
      body: form.toString(),
    });
    saveRefund(s, claim.refund, claim.o, raw);
  } catch {
    s.run(
      "UPDATE order_refunds SET status='unknown',error='Refund response was not confirmed. Reconcile before any further action.',updatedAt=? WHERE id=? AND status='request_sent'",
      now(),
      claim.refund.id,
    );
    s.run(
      "UPDATE book_orders SET error='Refund confirmation is pending. No refund request will be repeated automatically.',updatedAt=? WHERE id=?",
      now(),
      oid,
    );
  }
  return s.one<RefundRow>(
    "SELECT * FROM order_refunds WHERE id=?",
    claim.refund.id,
  )!;
}
function saveRefund(s: Store, r: RefundRow, o: OrderRow, raw: unknown) {
  const p = z
    .object({
      id: z.string().regex(/^re_/),
      amount: cents,
      currency: z.literal("usd"),
      payment_intent: z.string(),
      status: z.enum([
        "pending",
        "requires_action",
        "succeeded",
        "failed",
        "canceled",
      ]),
      metadata: z.object({ orderId: z.string(), refundId: z.string() }),
    })
    .parse(raw);
  if (
    p.amount !== r.amountCents ||
    p.payment_intent !== o.paymentIntent ||
    p.metadata.orderId !== o.id ||
    p.metadata.refundId !== r.id ||
    (r.providerId && r.providerId !== p.id)
  )
    throw new CheckoutError("Refund does not match this order.");
  s.transaction(() => {
    const latest = s.one<RefundRow>(
      "SELECT * FROM order_refunds WHERE id=?",
      r.id,
    )!;
    // Terminal provider outcomes are monotonic even when an earlier request resolves later.
    if (
      ["succeeded", "failed", "canceled"].includes(latest.status) &&
      latest.status !== p.status
    )
      return;
    s.run(
      "UPDATE order_refunds SET status=?,providerId=?,error=NULL,updatedAt=? WHERE id=?",
      p.status,
      p.id,
      now(),
      r.id,
    );
    s.run(
      "UPDATE book_orders SET status=?,error=?,updatedAt=? WHERE id=?",
      p.status === "succeeded" ? "refunded" : "refund_pending",
      ["failed", "canceled", "requires_action"].includes(p.status)
        ? "The refund requires operator attention. No further request will be made automatically."
        : null,
      now(),
      o.id,
    );
    if (p.status === "succeeded")
      s.run(
        "UPDATE book_orders SET refundedCents=MAX(refundedCents,?) WHERE id=?",
        p.amount,
        o.id,
      );
  });
}
export async function reconcileRefund(
  s: Store,
  oid: string,
  c: CommerceSettings,
  request: typeof fetch = fetch,
  refundId?: string,
) {
  const o = order(s, oid),
    r = s.one<RefundRow>("SELECT * FROM order_refunds WHERE orderId=?", oid);
  if (!r || o.mode !== c.mode) throw new CheckoutError("Refund unavailable.");
  const pid = refundId ?? r.providerId;
  if (!pid || !/^re_[A-Za-z0-9]+$/.test(pid))
    throw new CheckoutError(
      "A Stripe refund ID is required to reconcile this request.",
    );
  saveRefund(
    s,
    r,
    o,
    await json(request, `https://api.stripe.com/v1/refunds/${pid}`, {
      headers: { Authorization: `Bearer ${c.stripeKey}` },
    }),
  );
  return s.one<RefundRow>("SELECT * FROM order_refunds WHERE orderId=?", oid)!;
}
