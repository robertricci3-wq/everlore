import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const Key = z
  .string()
  .trim()
  .max(500)
  .regex(/^sk_(test|live)_[A-Za-z0-9]{16,}$/);
const Saved = z.object({
  version: z.literal(1),
  provider: z.literal("stripe"),
  apiKey: Key,
  environment: z.enum(["test", "live"]),
  checkedAt: z.iso.datetime(),
});
const file = (directory: string) => join(directory, "stripe-connection.json");
export class StripeConnectionError extends Error {}

export function loadStripeConnection(directory: string) {
  if (!existsSync(file(directory))) return null;
  try {
    return Saved.parse(JSON.parse(readFileSync(file(directory), "utf8")));
  } catch {
    throw new StripeConnectionError(
      "The saved Stripe connection could not be read.",
    );
  }
}

export async function verifyStripeConnection(
  apiKey: string,
  request: typeof fetch = fetch,
) {
  const parsed = Key.safeParse(apiKey);
  if (!parsed.success)
    throw new StripeConnectionError(
      "Use the Secret key from Stripe: sk_test_ for testing or sk_live_ for live payments. This value was not saved or sent.",
    );
  const environment = parsed.data.startsWith("sk_live_")
    ? ("live" as const)
    : ("test" as const);
  let response: Response;
  try {
    response = await request("https://api.stripe.com/v1/balance", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${parsed.data}`,
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new StripeConnectionError(
      "Could not reach Stripe. No payment was created and the saved connection was not changed.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new StripeConnectionError(
      response.status === 401 || response.status === 403
        ? "Stripe rejected this key or its permissions. Check the Secret key in your Stripe dashboard."
        : "Stripe could not verify the connection. Try again later; no payment was created.",
    );
  }
  try {
    const result = z
      .object({ object: z.literal("balance"), livemode: z.boolean() })
      .parse(await response.json());
    if (result.livemode !== (environment === "live"))
      throw new Error("mode mismatch");
  } catch {
    throw new StripeConnectionError(
      "Stripe returned an unexpected response. The connection was not saved.",
    );
  }
  return {
    provider: "stripe" as const,
    environment,
    checkedAt: new Date().toISOString(),
    authenticated: true as const,
    checkoutEnabled: false as const,
  };
}

export async function saveVerifiedStripeConnection(
  directory: string,
  apiKey: string,
  request: typeof fetch = fetch,
) {
  const read = () =>
    existsSync(file(directory)) ? readFileSync(file(directory), "utf8") : null;
  const before = read();
  const checked = await verifyStripeConnection(apiKey, request);
  if (before !== read())
    throw new StripeConnectionError(
      "The Stripe connection changed during verification. Check again before replacing it.",
    );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `stripe-connection.json.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(
      temporary,
      JSON.stringify(
        Saved.parse({ version: 1, ...checked, apiKey: apiKey.trim() }),
      ),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temporary, file(directory));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return checked;
}
