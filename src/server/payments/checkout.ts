import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const Purchase = z.object({
  orderId: z.string().uuid(),
  editionId: z.string().uuid(),
  attemptId: z.string().uuid().optional(),
  automaticTax: z.boolean().optional(),
  amountCents: z.number().int().min(50).max(1000000),
  origin: z
    .string()
    .url()
    .refine((v) => {
      const u = new URL(v);
      return u.protocol === "https:" && u.origin === v;
    }),
});
export class CheckoutError extends Error {}
// Transport errors are deliberately not retried. The caller must retain the order ID
// and reconcile using that same idempotency key, never create a second order.
export async function createCheckout(
  key: string,
  purchase: z.infer<typeof Purchase>,
  request: typeof fetch = fetch,
) {
  const p = Purchase.parse(purchase);
  if (!/^sk_(test|live)_[A-Za-z0-9]{16,}$/.test(key))
    throw new CheckoutError("Stripe server connection is unavailable.");
  const form = new URLSearchParams({
    mode: "payment",
    client_reference_id: p.orderId,
    "metadata[orderId]": p.orderId,
    "metadata[editionId]": p.editionId,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(p.amountCents),
    "line_items[0][price_data][product_data][name]": "Everlore hardcover book",
    "line_items[0][quantity]": "1",
    "shipping_address_collection[allowed_countries][0]": "US",
    success_url: `${p.origin}/#/order/${p.orderId}`,
    cancel_url: `${p.origin}/#/order/${p.orderId}?cancelled=1`,
  });
  if (p.attemptId) form.set("metadata[attemptId]", p.attemptId);
  if (p.automaticTax) {
    form.set("automatic_tax[enabled]", "true");
    form.set("line_items[0][price_data][tax_behavior]", "exclusive");
    // Stripe account tax registrations and product tax settings remain authoritative.
  }
  let response: Response;
  try {
    response = await request("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `everlore-checkout-${p.attemptId ?? p.orderId}`,
      },
      body: form.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new CheckoutError(
      "Checkout response unknown. Retain this order and reconcile before retrying.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new CheckoutError(
      "Stripe did not return a checkout session. Retain this order for reconciliation.",
    );
  }
  try {
    const result = z
      .object({
        id: z.string().regex(/^cs_[A-Za-z0-9_]+$/),
        url: z.string().url(),
        livemode: z.boolean(),
      })
      .parse(await response.json());
    const u = new URL(result.url);
    if (
      u.origin !== "https://checkout.stripe.com" ||
      result.livemode !== key.startsWith("sk_live_")
    )
      throw new Error();
    return result;
  } catch {
    throw new CheckoutError(
      "Unexpected checkout response. Retain this order for reconciliation.",
    );
  }
}
export function verifyStripeEvent(
  body: Buffer,
  signature: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (!secret.startsWith("whsec_"))
    throw new CheckoutError("Payment webhook is not configured.");
  const parts = signature.split(",").map((p) => p.split("="));
  const times = parts.filter(([key]) => key === "t");
  if (times.length !== 1 || !/^\d+$/.test(times[0][1] ?? ""))
    throw new CheckoutError("Invalid payment signature.");
  const timestamp = Number(times[0][1]);
  if (Math.abs(nowSeconds - timestamp) > 300)
    throw new CheckoutError("Expired payment signature.");
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest();
  const valid = parts
    .filter(([k]) => k === "v1")
    .some(
      ([, v]) =>
        /^[a-f0-9]{64}$/.test(v ?? "") &&
        timingSafeEqual(Buffer.from(v, "hex"), expected),
    );
  if (!valid) throw new CheckoutError("Invalid payment signature.");
  try {
    return z
      .object({
        id: z.string(),
        type: z.string(),
        livemode: z.boolean(),
        data: z.object({ object: z.record(z.string(), z.unknown()) }),
      })
      .parse(JSON.parse(body.toString("utf8")));
  } catch {
    throw new CheckoutError("Invalid payment event.");
  }
}
