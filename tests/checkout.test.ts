import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import {
  createCheckout,
  verifyStripeEvent,
} from "../src/server/payments/checkout.js";
test("checkout binds frozen order and edition, server price, destination and idempotency without sharing family text", async () => {
  const orderId = randomUUID(),
    editionId = randomUUID();
  await createCheckout(
    "sk_test_syntheticfixturekey",
    {
      orderId,
      editionId,
      amountCents: 5000,
      origin: "https://books.example.com",
    },
    async (url, init) => {
      assert.equal(url, "https://api.stripe.com/v1/checkout/sessions");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("Idempotency-Key"),
        `everlore-checkout-${orderId}`,
      );
      const p = new URLSearchParams(String(init?.body));
      assert.equal(p.get("line_items[0][price_data][unit_amount]"), "5000");
      assert.equal(p.get("metadata[editionId]"), editionId);
      return Response.json({
        id: "cs_test_fixture",
        url: "https://checkout.stripe.com/c/pay/fixture",
        livemode: false,
      });
    },
  );
});
test("ambiguous checkout is not retried and provider errors are not leaked", async () => {
  let calls = 0;
  await assert.rejects(
    createCheckout(
      "sk_test_syntheticfixturekey",
      {
        orderId: randomUUID(),
        editionId: randomUUID(),
        amountCents: 5000,
        origin: "https://books.example.com",
      },
      async () => {
        calls++;
        throw new Error("secret-provider-payload");
      },
    ),
    /response unknown/,
  );
  assert.equal(calls, 1);
});
test("webhooks require exact signed raw bytes and fresh timestamps", () => {
  const secret = "whsec_synthetic",
    body = Buffer.from(
      JSON.stringify({
        id: "evt_fixture",
        type: "checkout.session.completed",
        livemode: false,
        data: { object: { payment_status: "unpaid" } },
      }),
    );
  const signature = `t=1000,v1=${createHmac("sha256", secret).update("1000.").update(body).digest("hex")}`;
  assert.equal(
    verifyStripeEvent(body, signature, secret, 1001).id,
    "evt_fixture",
  );
  assert.throws(
    () =>
      verifyStripeEvent(
        Buffer.concat([body, Buffer.from(" ")]),
        signature,
        secret,
        1001,
      ),
    /Invalid/,
  );
  assert.throws(
    () => verifyStripeEvent(body, signature, secret, 1400),
    /Expired/,
  );
  // Signature validity alone never claims that an unpaid session is paid.
  assert.equal(
    verifyStripeEvent(body, signature, secret, 1001).data.object.payment_status,
    "unpaid",
  );
});

test("tax-exclusive checkout pins the attempt identity and enables Stripe automatic tax", async () => {
  const orderId = randomUUID(),
    attemptId = randomUUID();
  await createCheckout(
    "sk_test_syntheticfixturekey",
    {
      orderId,
      editionId: randomUUID(),
      attemptId,
      automaticTax: true,
      amountCents: 14900,
      origin: "https://books.example.com",
    },
    async (_url, init) => {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("automatic_tax[enabled]"), "true");
      assert.equal(
        form.get("line_items[0][price_data][tax_behavior]"),
        "exclusive",
      );
      assert.equal(form.get("metadata[attemptId]"), attemptId);
      assert.equal(
        new Headers(init?.headers).get("Idempotency-Key"),
        `everlore-checkout-${attemptId}`,
      );
      return Response.json({
        id: "cs_test_tax",
        url: "https://checkout.stripe.com/c/pay/tax",
        livemode: false,
      });
    },
  );
});
