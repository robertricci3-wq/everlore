import { z } from "zod";
import { loadStripeConnection } from "../payments/connection.js";
import { loadPrintConnection } from "../print/connection.js";
import { publicOrigin } from "../hosting.js";
export const CommerceConfig = z.object({
  enabled: z.boolean(),
  automaticTax: z.boolean().default(true),
  origin: z.string().url().nullable(),
  stripeKey: z.string(),
  webhookSecret: z.string(),
  assetSecret: z.string(),
  prodigiKey: z.string(),
  mode: z.enum(["test", "live"]),
  sku: z.string(),
  priceCents: z.number().int().min(0),
  physicalProofApproved: z.boolean(),
  shippingMethod: z.enum(["Budget", "Standard", "Express", "Overnight"]),
});
export type CommerceSettings = z.infer<typeof CommerceConfig>;
export function commerceConfig(dir: string): CommerceSettings {
  const stripe = loadStripeConnection(dir),
    print = loadPrintConnection(dir);
  return CommerceConfig.parse({
    enabled: process.env.CHECKOUT_ENABLED === "true",
    automaticTax: true,
    origin: publicOrigin(),
    stripeKey: process.env.STRIPE_SECRET_KEY ?? stripe?.apiKey ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    assetSecret: process.env.PRINT_ASSET_SECRET ?? "",
    prodigiKey: process.env.PRODIGI_API_KEY ?? print?.apiKey ?? "",
    mode: process.env.COMMERCE_MODE ?? "test",
    sku: process.env.PRINT_SKU ?? "",
    priceCents: Number(process.env.BOOK_PRICE_CENTS ?? 14900),
    physicalProofApproved: process.env.PRINT_PROOF_APPROVED === "true",
    shippingMethod: "Standard",
  });
}
// Existing paid orders use their frozen SKU, price and approval. Closing sales must not strand them.
export function fulfillmentReadiness(c: CommerceSettings) {
  const reasons: string[] = [];
  if (!c.origin) reasons.push("The public website is not configured.");
  if (!c.prodigiKey)
    reasons.push("Print provider connection is not configured.");
  if (c.assetSecret.length < 32)
    reasons.push("Private print delivery needs configuration.");
  return reasons;
}
export function readiness(c: CommerceSettings) {
  const reasons: string[] = [];
  if (!c.enabled) reasons.push("Hardcover ordering is not open yet.");
  if (!c.origin) reasons.push("The public website is not configured.");
  if (!c.stripeKey.startsWith(c.mode === "live" ? "sk_live_" : "sk_test_"))
    reasons.push("Payment connection is not configured for this environment.");
  if (!c.webhookSecret.startsWith("whsec_") || c.assetSecret.length < 32)
    reasons.push(
      "Payment confirmation and private print delivery need configuration.",
    );
  if (!c.prodigiKey || !c.sku)
    reasons.push("The hardcover product needs configuration.");
  if (c.priceCents < 50) reasons.push("The book price has not been set.");
  if (c.mode === "live" && !c.physicalProofApproved)
    reasons.push("The hardcover format is awaiting its print proof.");
  return reasons;
}
