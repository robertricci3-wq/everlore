import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { Store, id, now } from "../src/server/store.js";
import { sampleBook } from "../src/shared/fixture.js";
import { migrateCommerce } from "../src/server/commerce/schema.js";
import {
  preparePrint,
  verifyPrintProduct,
} from "../src/server/commerce/print.js";
import {
  startOrder,
  reconcilePayment,
  fulfillOne,
  refreshShipping,
  order,
  printBytes,
  recoverCheckout,
  renewCheckout,
  pollShippingOne,
  refundOrder,
  reconcileRefund,
} from "../src/server/commerce/service.js";
import type { CommerceSettings } from "../src/server/commerce/config.js";
const settings: CommerceSettings = {
  enabled: true,
  automaticTax: false,
  origin: "https://books.example.com",
  stripeKey: "sk_test_syntheticfixturekey",
  webhookSecret: "whsec_fixture",
  assetSecret: "a".repeat(64),
  prodigiKey: "synthetic-print-key",
  mode: "test",
  sku: "SYNTHETIC-SQUARE-BOOK",
  priceCents: 5000,
  physicalProofApproved: true,
  shippingMethod: "Standard",
};
const catalog = {
  outcome: "Ok",
  product: {
    sku: settings.sku,
    description: "Matte hardcover photo book on uncoated paper",
    productDimensions: { width: 210, height: 210, units: "mm" },
    printAreas: { default: { required: true } },
    variants: [{ shipsTo: ["US"] }],
  },
};
const product = verifyPrintProduct(catalog, settings.sku);
async function setup(pixels = 2400) {
  const dir = mkdtempSync(join(tmpdir(), "everlore-commerce-")),
    s = new Store(dir);
  migrateCommerce(s);
  s.run(
    "INSERT INTO users VALUES('owner','Owner','unused','private',?)",
    now(),
  );
  const pid = id(),
    eid = id();
  s.run(
    "INSERT INTO projects VALUES(?,'owner','Synthetic','sample','complete',1,NULL,?,?)",
    pid,
    now(),
    now(),
  );
  const png = await sharp({
      create: {
        width: pixels,
        height: pixels,
        channels: 3,
        background: "#92ad99",
      },
    })
      .png()
      .toBuffer(),
    art = s.putAsset(pid, png, "art"),
    book = sampleBook();
  for (const spread of book.spreads) spread.artHash = art;
  s.run(
    "INSERT INTO editions VALUES(?,?,?,?,?,?,?)",
    eid,
    pid,
    1,
    book.contentHash,
    "0".repeat(64),
    JSON.stringify(book),
    now(),
  );
  return {
    s,
    pid,
    eid,
    close() {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("print preparation produces 34 square pages, preserves edition, and refuses insufficient pixels", async () => {
  const t = await setup(1024);
  try {
    const before = t.s.one<{ book: string }>(
      "SELECT book FROM editions WHERE id=?",
      t.eid,
    )!.book;
    const b = await preparePrint(t.s, t.pid, t.eid, { product });
    assert.equal(b.ready, false);
    assert.match(b.issues.join(), /300/);
    const pdf = await PDFDocument.load(t.s.readAsset(t.pid, b.pdfHash));
    assert.equal(pdf.getPageCount(), 34);
    assert.ok(Math.abs(pdf.getPage(0).getWidth() - 595.275) < 0.01);
    assert.equal((await preparePrint(t.s, t.pid, t.eid, { product })).id, b.id);
    assert.equal(
      t.s.one<{ book: string }>("SELECT book FROM editions WHERE id=?", t.eid)!
        .book,
      before,
    );
  } finally {
    t.close();
  }
});
test("saved edition → checkout → verified payment → one print order → shipped, retaining signed assets", async () => {
  const t = await setup();
  let oid = "",
    printCalls = 0,
    checkoutCalls = 0,
    asset = "";
  try {
    const request: typeof fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("/products/")) return Response.json(catalog);
      if (u.endsWith("/quotes"))
        return Response.json({
          outcome: "Created",
          quotes: [
            {
              shipmentMethod: "Standard",
              costSummary: {
                items: { amount: "20.00", currency: "USD" },
                shipping: { amount: "5.00", currency: "USD" },
              },
            },
          ],
        });
      if (u.endsWith("/checkout/sessions")) {
        checkoutCalls++;
        oid = new URLSearchParams(String(init?.body)).get("metadata[orderId]")!;
        return Response.json({
          id: "cs_test_fixture",
          url: "https://checkout.stripe.com/c/pay/fixture",
          livemode: false,
        });
      }
      if (u.includes("/checkout/sessions/"))
        return Response.json({
          id: "cs_test_fixture",
          mode: "payment",
          livemode: false,
          status: "complete",
          payment_status: "paid",
          currency: "usd",
          amount_total: 5000,
          client_reference_id: oid,
          metadata: { orderId: oid, editionId: t.eid },
          shipping_details: {
            name: "Synthetic Reader",
            address: {
              line1: "123 Example Street",
              city: "Example",
              state: "CA",
              postal_code: "90210",
              country: "US",
            },
          },
        });
      if (u.endsWith("/orders")) {
        printCalls++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.idempotencyKey, oid);
        assert.equal(body.items[0].assets[0].pageCount, 34);
        asset = body.items[0].assets[0].url;
        return Response.json({
          outcome: "Created",
          order: { id: "ord_fixture" },
        });
      }
      return Response.json({
        order: { id: "ord_fixture", status: { stage: "Complete" } },
      });
    };
    const created = await startOrder(
      t.s,
      "owner",
      t.pid,
      t.eid,
      settings,
      request,
    );
    assert.equal(created.status, "awaiting_payment");
    await startOrder(t.s, "owner", t.pid, t.eid, settings, request);
    assert.equal(checkoutCalls, 1);
    assert.throws(() => order(t.s, oid, "other"), /unavailable/);
    await reconcilePayment(t.s, oid, settings, request);
    await reconcilePayment(t.s, oid, settings, request);
    assert.equal(order(t.s, oid).status, "paid");
    await Promise.all([
      fulfillOne(
        t.s,
        {
          ...settings,
          enabled: false,
          sku: "",
          priceCents: 0,
          physicalProofApproved: false,
        },
        request,
      ),
      fulfillOne(t.s, { ...settings, enabled: false }, request),
    ]);
    assert.equal(printCalls, 1);
    assert.equal(order(t.s, oid).status, "submitted");
    const u = new URL(asset),
      digest = u.pathname.split("/").at(-1)!;
    assert.ok(
      printBytes(
        t.s,
        oid,
        digest,
        Number(u.searchParams.get("expires")),
        u.searchParams.get("token")!,
        settings,
      ).length,
    );
    assert.throws(
      () =>
        printBytes(t.s, oid, digest, 0, u.searchParams.get("token")!, settings),
      /expired/,
    );
    await refreshShipping(t.s, oid, settings, request);
    assert.equal(order(t.s, oid).status, "shipped");
  } finally {
    t.close();
  }
});
test("ambiguous print dispatch is retained and never replayed", async () => {
  const t = await setup();
  try {
    const b = await preparePrint(t.s, t.pid, t.eid, { product }),
      oid = id();
    t.s.run(
      "INSERT INTO book_orders(id,ownerId,projectId,editionId,bundleId,amountCents,mode,sku,shippingMethod,status,recipient,createdAt,updatedAt) VALUES(?,'owner',?,?,?,5000,'test',?,'Standard','paid',?,?,?)",
      oid,
      t.pid,
      t.eid,
      b.id,
      settings.sku,
      JSON.stringify({
        name: "Reader",
        address: {
          line1: "123 Example",
          city: "Example",
          state: "CA",
          postal_code: "90210",
          country: "US",
        },
      }),
      now(),
      now(),
    );
    let calls = 0;
    const request: typeof fetch = async () => {
      calls++;
      throw new Error("Unknown response");
    };
    await fulfillOne(t.s, settings, request);
    await fulfillOne(t.s, settings, request);
    assert.equal(calls, 1);
    assert.equal(order(t.s, oid).status, "needs_attention");
  } finally {
    t.close();
  }
});

test("signed webhook verifies paid state through Stripe and deduplicates notifications", async () => {
  const { default: express } = await import("express");
  const { createHmac } = await import("node:crypto");
  const { installCommercePublic } =
    await import("../src/server/commerce/routes.js");
  const t = await setup();
  const app = express();
  let checks = 0,
    refunded = false;
  const oid = id();
  t.s.run(
    "INSERT INTO book_orders(id,ownerId,projectId,editionId,bundleId,amountCents,mode,sku,shippingMethod,status,checkoutId,createdAt,updatedAt) VALUES(?,'owner',?,?,'fixture',5000,'test',?,'Standard','awaiting_payment','cs_test_fixture',?,?)",
    oid,
    t.pid,
    t.eid,
    settings.sku,
    now(),
    now(),
  );
  installCommercePublic(
    app,
    t.s,
    () => settings,
    async () => {
      checks++;
      return Response.json({
        id: "cs_test_fixture",
        mode: "payment",
        livemode: false,
        status: "complete",
        payment_status: "paid",
        currency: "usd",
        amount_total: 5000,
        payment_intent: {
          id: "pi_webhook",
          latest_charge: { refunded, amount_refunded: refunded ? 5000 : 0 },
        },
        client_reference_id: oid,
        metadata: { orderId: oid, editionId: t.eid },
        shipping_details: {
          name: "Reader",
          address: {
            line1: "Example",
            city: "Example",
            state: "CA",
            postal_code: "90210",
            country: "US",
          },
        },
      });
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/payments/stripe/webhook`;
  try {
    const body = JSON.stringify({
        id: "evt_test",
        type: "checkout.session.completed",
        livemode: false,
        data: { object: { id: "cs_test_fixture", metadata: { orderId: oid } } },
      }),
      stamp = Math.floor(Date.now() / 1000),
      sig = `t=${stamp},v1=${createHmac("sha256", settings.webhookSecret).update(`${stamp}.${body}`).digest("hex")}`;
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": "bad",
          },
          body,
        })
      ).status,
      400,
    );
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "stripe-signature": sig,
            },
            body,
          })
        ).status,
        200,
      );
    assert.equal(checks, 1);
    assert.equal(order(t.s, oid).status, "paid");
    refunded = true;
    const refundBody = JSON.stringify({
      id: "evt_refunded",
      type: "charge.refunded",
      livemode: false,
      data: { object: { payment_intent: "pi_webhook" } },
    });
    const refundSig = `t=${stamp},v1=${createHmac("sha256", settings.webhookSecret).update(`${stamp}.${refundBody}`).digest("hex")}`;
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": refundSig,
          },
          body: refundBody,
        })
      ).status,
      200,
    );
    assert.equal(order(t.s, oid).status, "refunded");
    assert.equal(checks, 2);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    t.close();
  }
});

test("wrong amount, missing address and unpaid sessions cannot become print jobs", async () => {
  const t = await setup();
  const oid = id();
  try {
    t.s.run(
      "INSERT INTO book_orders(id,ownerId,projectId,editionId,bundleId,amountCents,mode,sku,shippingMethod,status,checkoutId,createdAt,updatedAt) VALUES(?,'owner',?,?,'fixture',5000,'test',?,'Standard','awaiting_payment','cs_test_fixture',?,?)",
      oid,
      t.pid,
      t.eid,
      settings.sku,
      now(),
      now(),
    );
    const session = {
      id: "cs_test_fixture",
      mode: "payment",
      livemode: false,
      status: "complete",
      payment_status: "paid",
      currency: "usd",
      amount_total: 4000,
      client_reference_id: oid,
      metadata: { orderId: oid, editionId: t.eid },
    };
    await assert.rejects(
      reconcilePayment(t.s, oid, settings, async () => Response.json(session)),
      /match/,
    );
    await assert.rejects(
      reconcilePayment(t.s, oid, settings, async () =>
        Response.json({ ...session, amount_total: 5000 }),
      ),
      /delivery address/,
    );
    await reconcilePayment(t.s, oid, settings, async () =>
      Response.json({
        ...session,
        amount_total: 5000,
        payment_status: "unpaid",
      }),
    );
    assert.equal(order(t.s, oid).status, "awaiting_payment");
  } finally {
    t.close();
  }
});

function seedOrder(
  t: Awaited<ReturnType<typeof setup>>,
  overrides: { state?: string; tax?: number } = {},
) {
  const oid = id();
  t.s.run(
    "INSERT INTO book_orders(id,ownerId,projectId,editionId,bundleId,amountCents,mode,sku,shippingMethod,status,checkoutId,automaticTax,createdAt,updatedAt) VALUES(?,'owner',?,?,'fixture',5000,'test',?,'Standard',?,'cs_test_initial',?,?,?)",
    oid,
    t.pid,
    t.eid,
    settings.sku,
    overrides.state ?? "awaiting_payment",
    overrides.tax ?? 0,
    now(),
    now(),
  );
  const aid = id();
  t.s.run(
    "INSERT INTO checkout_attempts(id,orderId,sequence,status,idempotencyKey,sessionId,createdAt,updatedAt) VALUES(?,?,1,'open',?,'cs_test_initial',?,?)",
    aid,
    oid,
    `everlore-checkout-${aid}`,
    now(),
    now(),
  );
  return { oid, aid };
}
function payment(
  t: Awaited<ReturnType<typeof setup>>,
  oid: string,
  aid: string,
  extra: object = {},
) {
  return {
    id: "cs_test_initial",
    mode: "payment",
    livemode: false,
    status: "complete",
    payment_status: "paid",
    currency: "usd",
    amount_subtotal: 5000,
    amount_total: 5000,
    total_details: { amount_tax: 0, amount_shipping: 0, amount_discount: 0 },
    client_reference_id: oid,
    metadata: { orderId: oid, editionId: t.eid, attemptId: aid },
    payment_intent: {
      id: "pi_fixture",
      latest_charge: { receipt_url: "https://pay.stripe.com/receipts/fixture" },
    },
    shipping_details: {
      name: "Reader",
      address: {
        line1: "Example",
        city: "Example",
        state: "CA",
        postal_code: "90210",
        country: "US",
      },
    },
    ...extra,
  };
}
test("tax reconciliation verifies frozen subtotal, exact tax arithmetic and completed automatic calculation", async () => {
  const t = await setup(16);
  try {
    const { oid, aid } = seedOrder(t, { tax: 1 });
    const good = payment(t, oid, aid, {
      amount_total: 5437,
      total_details: {
        amount_tax: 437,
        amount_shipping: 0,
        amount_discount: 0,
      },
      automatic_tax: { enabled: true, status: "complete" },
    });
    for (const change of [
      { amount_total: 5438 },
      { amount_subtotal: 4999 },
      { automatic_tax: { enabled: true, status: "failed" } },
      {
        total_details: {
          amount_tax: 437,
          amount_shipping: 1,
          amount_discount: 0,
        },
      },
    ]) {
      await assert.rejects(
        reconcilePayment(t.s, oid, settings, async () =>
          Response.json({ ...good, ...change }),
        ),
        /match|complete/,
      );
      assert.equal(order(t.s, oid).status, "awaiting_payment");
    }
    await reconcilePayment(t.s, oid, settings, async () => Response.json(good));
    assert.equal(order(t.s, oid).totalCents, 5437);
    assert.equal(order(t.s, oid).taxCents, 437);
    assert.equal(
      order(t.s, oid).receiptUrl,
      "https://pay.stripe.com/receipts/fixture",
    );
  } finally {
    t.close();
  }
});
test("renewal only follows verified expired unpaid sessions; late notifications cannot duplicate fulfillment", async () => {
  const t = await setup(16);
  try {
    const { oid, aid } = seedOrder(t);
    let state = "open",
      posts = 0,
      nextAid = "";
    const request: typeof fetch = async (url, init) => {
      if (init?.method === "POST") {
        posts++;
        nextAid = new URLSearchParams(String(init.body)).get(
          "metadata[attemptId]",
        )!;
        return Response.json({
          id: "cs_test_next",
          livemode: false,
          url: "https://checkout.stripe.com/c/pay/next",
        });
      }
      assert.match(String(url), /cs_test_initial/);
      return Response.json(
        payment(t, oid, aid, {
          status: state,
          payment_status: "unpaid",
          url: "https://checkout.stripe.com/c/pay/initial",
        }),
      );
    };
    await renewCheckout(t.s, oid, "owner", settings, request);
    assert.equal(posts, 0);
    state = "expired";
    await Promise.all([
      renewCheckout(t.s, oid, "owner", settings, request),
      renewCheckout(t.s, oid, "owner", settings, request),
    ]);
    assert.equal(posts, 1);
    assert.equal(
      t.s.all("SELECT * FROM checkout_attempts WHERE orderId=?", oid).length,
      2,
    );
    await reconcilePayment(
      t.s,
      oid,
      settings,
      async () =>
        Response.json(payment(t, oid, nextAid, { id: "cs_test_next" })),
      "cs_test_next",
    );
    await reconcilePayment(
      t.s,
      oid,
      settings,
      async () => Response.json(payment(t, oid, aid)),
      "cs_test_initial",
    );
    assert.equal(order(t.s, oid).status, "paid");
    assert.equal(order(t.s, oid).checkoutId, "cs_test_next");
    assert.equal(order(t.s, oid).duplicatePayment, 1);
  } finally {
    t.close();
  }
});
test("unknown checkout searches are read-only; absence does not permit another paid request", async () => {
  const t = await setup(16);
  try {
    const { oid, aid } = seedOrder(t, { state: "needs_attention" });
    t.s.run("UPDATE book_orders SET checkoutId=NULL WHERE id=?", oid);
    t.s.run(
      "UPDATE checkout_attempts SET sessionId=NULL,status='unknown' WHERE id=?",
      aid,
    );
    let calls = 0;
    await recoverCheckout(t.s, oid, settings, async (_url, init) => {
      calls++;
      assert.notEqual(init?.method, "POST");
      return Response.json({ data: [], has_more: false });
    });
    assert.equal(calls, 1);
    await assert.rejects(
      renewCheckout(t.s, oid, "owner", settings),
      /reconciled/,
    );
    const request: typeof fetch = async (url, init) => {
      assert.notEqual(init?.method, "POST");
      return String(url).includes("/cs_test_initial")
        ? Response.json(payment(t, oid, aid))
        : Response.json({
            data: [{ id: "cs_test_initial", client_reference_id: oid }],
            has_more: false,
          });
    };
    await recoverCheckout(t.s, oid, settings, request);
    assert.equal(order(t.s, oid).status, "paid");
  } finally {
    t.close();
  }
});
test("shipping polling is bounded, retains tracking and surfaces provider cancellation", async () => {
  const t = await setup(16);
  try {
    const { oid } = seedOrder(t, { state: "submitted" });
    t.s.run("UPDATE book_orders SET providerId='ord_fixture' WHERE id=?", oid);
    let calls = 0;
    const request: typeof fetch = async () => {
      calls++;
      return Response.json({
        order: {
          id: "ord_fixture",
          merchantReference: oid,
          status: { stage: "InProgress", issues: [{ code: "assetRejected" }] },
          shipments: [
            {
              id: "shp_one",
              status: "Processing",
              tracking: { url: "javascript:alert(1)", number: "123" },
            },
          ],
        },
      });
    };
    await Promise.all([
      pollShippingOne(t.s, settings, request),
      pollShippingOne(t.s, settings, request),
    ]);
    assert.equal(calls, 1);
    assert.equal(order(t.s, oid).status, "provider_failed");
    assert.equal(JSON.parse(order(t.s, oid).tracking!)[0].url, null);
    await refreshShipping(t.s, oid, settings, async () =>
      Response.json({
        order: { id: "ord_fixture", status: { stage: "Cancelled" } },
      }),
    );
    assert.equal(order(t.s, oid).status, "cancelled");
  } finally {
    t.close();
  }
});
test("refund requests are explicit, retained once, and ambiguous outcomes only reconcile through GET", async () => {
  const t = await setup(16);
  try {
    const { oid, aid } = seedOrder(t);
    await reconcilePayment(t.s, oid, settings, async () =>
      Response.json(payment(t, oid, aid)),
    );
    let posts = 0;
    const request: typeof fetch = async (_url, init) => {
      assert.equal(init?.method, "POST");
      posts++;
      throw new Error("Unknown paid outcome");
    };
    const result = await refundOrder(
      t.s,
      oid,
      "Customer requested cancellation",
      settings,
      request,
    );
    await refundOrder(
      t.s,
      oid,
      "Customer requested cancellation",
      settings,
      request,
    );
    assert.equal(posts, 1);
    assert.equal(result.status, "unknown");
    assert.equal(order(t.s, oid).status, "refund_pending");
    await reconcileRefund(
      t.s,
      oid,
      settings,
      async (_url, init) => {
        assert.notEqual(init?.method, "POST");
        return Response.json({
          id: "re_fixture",
          amount: 5000,
          currency: "usd",
          payment_intent: "pi_fixture",
          status: "succeeded",
          metadata: { orderId: oid, refundId: result.id },
        });
      },
      "re_fixture",
    );
    assert.equal(order(t.s, oid).status, "refunded");
  } finally {
    t.close();
  }
});

test("a payment webhook arriving before checkout POST returns cannot be overwritten", async () => {
  const t = await setup(16);
  try {
    const { oid } = seedOrder(t, { state: "creating_checkout" });
    t.s.run("DELETE FROM checkout_attempts WHERE orderId=?", oid);
    t.s.run("UPDATE book_orders SET checkoutId=NULL WHERE id=?", oid);
    const result = await startOrder(
      t.s,
      "owner",
      t.pid,
      t.eid,
      settings,
      async (_url, init) => {
        const aid = new URLSearchParams(String(init?.body)).get(
          "metadata[attemptId]",
        )!;
        await reconcilePayment(
          t.s,
          oid,
          settings,
          async () => Response.json(payment(t, oid, aid)),
          "cs_test_initial",
        );
        return Response.json({
          id: "cs_test_initial",
          url: "https://checkout.stripe.com/c/pay/initial",
          livemode: false,
        });
      },
    );
    assert.equal(result.status, "paid");
    assert.equal(result.checkoutUrl, null);
  } finally {
    t.close();
  }
});

test("restart retains uncertain checkout, print and refund checkpoints without provider requests", async () => {
  const { default: express } = await import("express");
  const { installCommercePublic } =
    await import("../src/server/commerce/routes.js");
  const t = await setup(16);
  try {
    const { oid, aid } = seedOrder(t, { state: "checkout_request_sent" });
    t.s.run(
      "UPDATE checkout_attempts SET status='request_sent' WHERE id=?",
      aid,
    );
    const rid = id();
    t.s.run(
      "INSERT INTO order_refunds(id,orderId,status,amountCents,reason,createdAt,updatedAt) VALUES(?,?,'request_sent',5000,'Synthetic',?,?)",
      rid,
      oid,
      now(),
      now(),
    );
    let calls = 0;
    installCommercePublic(
      express(),
      t.s,
      () => settings,
      async () => {
        calls++;
        throw new Error("Must not call");
      },
    );
    assert.equal(calls, 0);
    assert.equal(order(t.s, oid).status, "needs_attention");
    assert.equal(
      t.s.one<{ status: string }>(
        "SELECT status FROM checkout_attempts WHERE id=?",
        aid,
      )!.status,
      "unknown",
    );
    assert.equal(
      t.s.one<{ status: string }>(
        "SELECT status FROM order_refunds WHERE id=?",
        rid,
      )!.status,
      "unknown",
    );
  } finally {
    t.close();
  }
});

test("customer history and support stay private; operator recovery requires operator access", async () => {
  const { default: express } = await import("express");
  const { installCommerceRoutes, installCommerceOperatorRoutes } =
    await import("../src/server/commerce/routes.js");
  const t = await setup(16),
    app = express(),
    { oid } = seedOrder(t);
  app.use(express.json());
  const auth: import("express").RequestHandler = (req, res, next) => {
    if (!req.get("x-test-user")) res.status(401).end();
    else next();
  };
  const operator: import("express").RequestHandler = (req, res, next) => {
    if (req.get("x-test-user") !== "operator") res.status(403).end();
    else next();
  };
  installCommerceRoutes(
    app,
    t.s,
    auth,
    (req) => ({ id: req.get("x-test-user")! }),
    () => settings,
  );
  let providerCalls = 0;
  installCommerceOperatorRoutes(
    app,
    t.s,
    operator,
    () => settings,
    async () => {
      providerCalls++;
      throw new Error("Must not call");
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const get = (path: string, user = "owner") =>
      fetch(`${base}/api${path}`, { headers: { "x-test-user": user } });
    assert.equal((await (await get("/orders")).json()).length, 1);
    assert.deepEqual(await (await get("/orders", "other")).json(), []);
    assert.equal((await get(`/orders/${oid}`, "other")).status, 404);
    assert.equal((await get("/operator/orders", "owner")).status, 403);
    assert.equal((await get("/operator/orders", "operator")).status, 200);
    const support = (user: string) =>
      fetch(`${base}/api/orders/${oid}/support`, {
        method: "POST",
        headers: { "x-test-user": user, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Please check the delivery status." }),
      });
    assert.equal((await support("other")).status, 400);
    assert.equal((await support("owner")).status, 200);
    await support("owner");
    assert.equal(t.s.all("SELECT * FROM order_support").length, 1);
    const denied = await fetch(`${base}/api/operator/orders/${oid}/refund`, {
      method: "POST",
      headers: { "x-test-user": "owner", "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Test", confirm: true }),
    });
    assert.equal(denied.status, 403);
    assert.equal(providerCalls, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    t.close();
  }
});

test("legacy uncertain checkout survives additive migration and reconciles without retrying POST", async () => {
  const t = await setup(16);
  try {
    const { oid, aid } = seedOrder(t, { state: "needs_attention" });
    t.s.run("DELETE FROM checkout_attempts WHERE orderId=?", oid);
    t.s.run("UPDATE book_orders SET checkoutId=NULL WHERE id=?", oid);
    migrateCommerce(t.s);
    const old = payment(t, oid, aid, {
      metadata: { orderId: oid, editionId: t.eid },
    });
    await recoverCheckout(
      t.s,
      oid,
      settings,
      async (_url, init) => {
        assert.notEqual(init?.method, "POST");
        return Response.json(old);
      },
      "cs_test_initial",
    );
    assert.equal(order(t.s, oid).status, "paid");
    assert.equal(
      t.s.all("SELECT * FROM checkout_attempts WHERE orderId=?", oid).length,
      1,
    );
  } finally {
    t.close();
  }
});

test("late shipping reads cannot reverse shipped or erase recorded tracking", async () => {
  const t = await setup(16);
  try {
    const { oid } = seedOrder(t, { state: "submitted" });
    t.s.run("UPDATE book_orders SET providerId='ord_fixture' WHERE id=?", oid);
    let release!: (r: Response) => void;
    const slow = refreshShipping(
      t.s,
      oid,
      settings,
      async () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    await refreshShipping(t.s, oid, settings, async () =>
      Response.json({
        order: {
          id: "ord_fixture",
          status: { stage: "Complete" },
          shipments: [
            {
              id: "shp_one",
              status: "Shipped",
              tracking: {
                number: "TRACK1",
                url: "https://tracking.example.com/TRACK1",
              },
            },
          ],
        },
      }),
    );
    release(
      Response.json({
        order: { id: "ord_fixture", status: { stage: "InProgress" } },
      }),
    );
    await slow;
    assert.equal(order(t.s, oid).status, "shipped");
    assert.equal(JSON.parse(order(t.s, oid).tracking!)[0].number, "TRACK1");
    await refreshShipping(t.s, oid, settings, async () =>
      Response.json({
        order: { id: "ord_fixture", status: { stage: "Complete" } },
      }),
    );
    assert.equal(JSON.parse(order(t.s, oid).tracking!)[0].number, "TRACK1");
  } finally {
    t.close();
  }
});

test("late pending refund reads cannot reverse a confirmed successful refund", async () => {
  const t = await setup(16);
  try {
    const { oid, aid } = seedOrder(t);
    await reconcilePayment(t.s, oid, settings, async () =>
      Response.json(payment(t, oid, aid)),
    );
    const r = await refundOrder(
      t.s,
      oid,
      "Synthetic refund",
      settings,
      async () => {
        throw new Error("Unknown response");
      },
    );
    const record = {
      id: "re_fixture",
      amount: 5000,
      currency: "usd",
      payment_intent: "pi_fixture",
      status: "succeeded",
      metadata: { orderId: oid, refundId: r.id },
    };
    let release!: (response: Response) => void;
    const slow = reconcileRefund(
      t.s,
      oid,
      settings,
      async () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
      "re_fixture",
    );
    await reconcileRefund(
      t.s,
      oid,
      settings,
      async () => Response.json(record),
      "re_fixture",
    );
    release(Response.json({ ...record, status: "pending" }));
    await slow;
    assert.equal(order(t.s, oid).status, "refunded");
    assert.equal(
      t.s.one<{ status: string }>(
        "SELECT status FROM order_refunds WHERE orderId=?",
        oid,
      )!.status,
      "succeeded",
    );
  } finally {
    t.close();
  }
});

test("restore recovery lock permits payment inspection but blocks all new paid actions", async () => {
  const t = await setup(16);
  try {
    const { oid, aid } = seedOrder(t);
    t.s.run(
      "INSERT INTO recovery_locks VALUES(?,?,?,NULL,NULL)",
      id(),
      now(),
      now(),
    );
    let gets = 0,
      posts = 0;
    const request: typeof fetch = async (_url, init) => {
      if (init?.method === "POST") posts++;
      else gets++;
      return Response.json(payment(t, oid, aid));
    };
    await reconcilePayment(t.s, oid, settings, request);
    assert.equal(order(t.s, oid).status, "paid");
    assert.equal(await fulfillOne(t.s, settings, request), false);
    await assert.rejects(
      startOrder(t.s, "owner", t.pid, t.eid, settings, request),
      /reconciliation/,
    );
    await assert.rejects(
      renewCheckout(t.s, oid, "owner", settings, request),
      /reconciliation/,
    );
    await assert.rejects(
      refundOrder(t.s, oid, "Synthetic refund", settings, request),
      /reconciliation/,
    );
    assert.equal(gets, 1);
    assert.equal(posts, 0);
  } finally {
    t.close();
  }
});

test("reconciling a legacy paid order fills payment details without requeueing printing", async () => {
  const t = await setup(16);
  try {
    const { oid, aid } = seedOrder(t, { state: "submitted" });
    const p = payment(t, oid, aid);
    t.s.run(
      "UPDATE book_orders SET providerId='ord_fixture',recipient=? WHERE id=?",
      JSON.stringify(p.shipping_details),
      oid,
    );
    await reconcilePayment(t.s, oid, settings, async () => Response.json(p));
    assert.equal(order(t.s, oid).status, "submitted");
    assert.equal(order(t.s, oid).totalCents, 5000);
    assert.equal(order(t.s, oid).paymentIntent, "pi_fixture");
  } finally {
    t.close();
  }
});

test("refunds recorded outside the app block printing and cannot be reversed by stale paid sessions", async () => {
  const t = await setup(16);
  try {
    const { oid, aid } = seedOrder(t);
    const result = (amount: number) =>
      payment(t, oid, aid, {
        payment_intent: {
          id: "pi_fixture",
          latest_charge: { refunded: amount === 5000, amount_refunded: amount },
        },
      });
    await reconcilePayment(t.s, oid, settings, async () =>
      Response.json(result(1000)),
    );
    assert.equal(order(t.s, oid).status, "needs_attention");
    assert.equal(
      await fulfillOne(t.s, settings, async () => {
        throw new Error("Must not print");
      }),
      false,
    );
    await reconcilePayment(t.s, oid, settings, async () =>
      Response.json(result(5000)),
    );
    assert.equal(order(t.s, oid).status, "refunded");
    assert.equal(order(t.s, oid).refundedCents, 5000);
    await reconcilePayment(t.s, oid, settings, async () =>
      Response.json(result(0)),
    );
    assert.equal(order(t.s, oid).status, "refunded");
    assert.equal(order(t.s, oid).refundedCents, 5000);
  } finally {
    t.close();
  }
});
