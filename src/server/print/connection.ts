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
  .min(16)
  .max(500)
  .regex(/^[\x21-\x7e]+$/);
const Environment = z.enum(["sandbox", "live"]);
const SavedConnection = z.object({
  version: z.literal(1),
  provider: z.literal("prodigi"),
  environment: Environment,
  apiKey: Key,
  checkedAt: z.iso.datetime(),
  probeSku: z.string(),
});
export type PrintEnvironment = z.infer<typeof Environment>;
const hosts: Record<PrintEnvironment, string> = {
  live: "https://api.prodigi.com",
  sandbox: "https://api.sandbox.prodigi.com",
};
// An official sample-book SKU. This checks authentication/catalogue access only;
// it does not select Everlore's eventual product, quote, or place an order.
export const PRODIGI_PROBE_SKU = "BOOK-FE-A4-L-LF-G";
const file = (directory: string) => join(directory, "prodigi-connection.json");

export class PrintConnectionError extends Error {}

export function loadPrintConnection(directory: string) {
  if (!existsSync(file(directory))) return null;
  try {
    return SavedConnection.parse(
      JSON.parse(readFileSync(file(directory), "utf8")),
    );
  } catch {
    throw new PrintConnectionError(
      "The saved print connection could not be read.",
    );
  }
}

export async function verifyProdigiConnection(
  apiKey: string,
  environment: PrintEnvironment,
  request: typeof fetch = fetch,
) {
  const key = Key.safeParse(apiKey),
    target = Environment.safeParse(environment);
  if (!key.success || !target.success)
    throw new PrintConnectionError(
      "Enter a valid Prodigi key and environment.",
    );
  let response: Response;
  try {
    response = await request(
      `${hosts[target.data]}/v4.0/products/${PRODIGI_PROBE_SKU}`,
      {
        method: "GET",
        headers: { "X-API-Key": key.data, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    throw new PrintConnectionError(
      "Could not reach Prodigi. No order was placed and no connection was changed.",
    );
  }
  if (!response.ok) {
    const message =
      response.status === 401 || response.status === 403
        ? "Prodigi rejected this key for the selected environment."
        : response.status === 429
          ? "Prodigi is limiting requests. Try the connection check later."
          : "Prodigi could not verify catalogue access. No order was placed.";
    // Never expose provider bodies: they can contain credentials or account data.
    await response.body?.cancel();
    throw new PrintConnectionError(message);
  }
  try {
    const result = z
      .object({
        outcome: z.literal("Ok"),
        product: z.object({ sku: z.literal(PRODIGI_PROBE_SKU) }),
      })
      .parse(await response.json());
    return {
      provider: "prodigi" as const,
      environment,
      checkedAt: new Date().toISOString(),
      probeSku: result.product.sku,
      catalogueAccess: true as const,
      orderingEnabled: false as const,
    };
  } catch {
    throw new PrintConnectionError(
      "Prodigi returned an unexpected catalogue response. The connection was not saved.",
    );
  }
}

export async function saveVerifiedPrintConnection(
  directory: string,
  apiKey: string,
  environment: PrintEnvironment,
  request: typeof fetch = fetch,
) {
  const before = existsSync(file(directory))
    ? readFileSync(file(directory), "utf8")
    : null;
  const checked = await verifyProdigiConnection(apiKey, environment, request);
  const current = existsSync(file(directory))
    ? readFileSync(file(directory), "utf8")
    : null;
  if (before !== current)
    throw new PrintConnectionError(
      "The print connection changed during verification. Check it again before replacing it.",
    );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `prodigi-connection.json.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(
      temporary,
      JSON.stringify(
        SavedConnection.parse({
          version: 1,
          ...checked,
          apiKey: apiKey.trim(),
        }),
      ),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temporary, file(directory));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return checked;
}
