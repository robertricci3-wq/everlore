import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadStripeConnection,
  saveVerifiedStripeConnection,
  verifyStripeConnection,
} from "../src/server/payments/connection.js";

const key = "sk_test_synthetickeyfortestonly";
const response = () => Response.json({ object: "balance", livemode: false });
test("Stripe verification uses a fixed authenticated GET without redirect or order dispatch", async () => {
  const seen: string[] = [];
  const request: typeof fetch = async (url, init) => {
    seen.push(String(url));
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      `Bearer ${key}`,
    );
    return response();
  };
  {
    const result = await verifyStripeConnection(key, request);
    assert.equal(result.authenticated, true);
    assert.equal(result.checkoutEnabled, false);
    assert.ok(!JSON.stringify(result).includes(key));
  }
  assert.deepEqual(seen, ["https://api.stripe.com/v1/balance"]);
});

test("verified Stripe credentials persist privately and a rejected replacement preserves them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "everlore-stripe-"));
  try {
    await saveVerifiedStripeConnection(dir, key, async () => response());
    const path = join(dir, "stripe-connection.json"),
      before = readFileSync(path, "utf8");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(loadStripeConnection(dir)?.apiKey, key);
    await assert.rejects(
      saveVerifiedStripeConnection(
        dir,
        "sk_test_rejectedsynthetickey",
        async () => new Response(key, { status: 401 }),
      ),
      /rejected this key/,
    );
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transport failures and malformed successes never leak credentials or persist a connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "everlore-stripe-"));
  try {
    let calls = 0;
    await assert.rejects(
      saveVerifiedStripeConnection(dir, key, async () => {
        calls++;
        throw new Error(key);
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(key));
        return true;
      },
    );
    assert.equal(calls, 1);
    await assert.rejects(
      saveVerifiedStripeConnection(dir, key, async () =>
        Response.json({ outcome: "Ok", key }),
      ),
      /unexpected response/,
    );
    assert.equal(loadStripeConnection(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale connection check cannot overwrite a newer saved key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "everlore-stripe-"));
  try {
    await saveVerifiedStripeConnection(dir, key, async () => response());
    const path = join(dir, "stripe-connection.json");
    await assert.rejects(
      saveVerifiedStripeConnection(
        dir,
        "sk_test_stalesynthetickey",
        async () => {
          const next = JSON.parse(readFileSync(path, "utf8"));
          next.apiKey = "sk_test_newersynthetickey";
          writeFileSync(path, JSON.stringify(next));
          return response();
        },
      ),
      /changed during verification/,
    );
    assert.equal(
      loadStripeConnection(dir)?.apiKey,
      "sk_test_newersynthetickey",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrong key types are rejected locally without transmitting them", async () => {
  let calls = 0;
  for (const key of [
    "mk_synthetic1234567890",
    "pk_test_synthetic1234567890",
    "sk_live_short",
  ]) {
    await assert.rejects(
      verifyStripeConnection(key, async () => {
        calls++;
        return response();
      }),
      /Secret key/,
    );
  }
  assert.equal(calls, 0);
});
test("a successful response for the wrong environment cannot validate a key", async () => {
  await assert.rejects(
    verifyStripeConnection("sk_live_synthetickeyfortestonly", async () =>
      response(),
    ),
    /unexpected response/,
  );
});
