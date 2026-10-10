import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp } from "../src/server/app.js";
import { hash, id, now, Store } from "../src/server/store.js";
import { sampleBook } from "../src/shared/fixture.js";
import { finalizeBook } from "../src/server/layout.js";
import { startOrder } from "../src/server/commerce/service.js";
import type { CommerceSettings } from "../src/server/commerce/config.js";
import type { EditionView } from "../src/shared/contracts.js";

process.env.CHECKOUT_ENABLED = "false";
process.env.BOOK_PRICE_CENTS = "14900";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "everlore-purchase-journey-"));
  const store = new Store(directory);
  const app = createApp(
    store,
    undefined,
    async () => {
      throw new Error("No provider calls in this test.");
    },
    null,
  );
  for (const owner of ["owner", "other"]) {
    store.run(
      "INSERT INTO users VALUES(?,?,?,?,?)",
      owner,
      owner,
      "unused",
      "private",
      now(),
    );
    store.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(`${owner}-session`),
      owner,
      Date.now() + 60000,
    );
  }
  const pid = id();
  let book = sampleBook();
  store.run(
    "INSERT INTO projects VALUES(?,'owner',?,'synthetic_fixture','ready_for_review',1,NULL,?,?)",
    pid,
    book.title,
    now(),
    now(),
  );
  const pixels = await sharp({
    create: { width: 2560, height: 2560, channels: 3, background: "#abc5ad" },
  })
    .png()
    .toBuffer();
  const art = store.putAsset(pid, pixels, "art");
  for (const spread of book.spreads) {
    spread.artHash = art;
  }
  book = await finalizeBook(book);
  store.run(
    "INSERT INTO revisions VALUES(?,?,?,?)",
    pid,
    book.revision,
    JSON.stringify(book),
    book.contentHash,
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, body?: unknown, owner = "owner") =>
    fetch(`${base}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Evermore-Client": "1",
        Cookie: owner ? `evermore=${owner}-session` : "",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    store,
    pid,
    book,
    call,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("pre-edition availability is private, read-only, priced by the server and rejects a stale displayed book", async () => {
  const t = await fixture();
  try {
    const changes = () =>
      t.store.one<{ n: number }>("SELECT total_changes() n")!.n;
    const before = changes();
    const path = `/projects/${t.pid}/purchase?revision=1&contentHash=${t.book.contentHash}`;
    const response = await t.call(path);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.priceCents, 14900);
    assert.equal(data.editionId, null);
    assert.equal(data.bundle, null);
    assert.equal(data.order, null);
    assert.ok(data.reasons.includes("Hardcover ordering is not open yet."));
    assert.equal(changes(), before);
    assert.equal((await t.call(path, undefined, "")).status, 401);
    assert.equal((await t.call(path, undefined, "other")).status, 404);
    assert.equal(
      (await t.call(`/projects/${t.pid}/purchase?revision=2`)).status,
      409,
    );
    assert.equal(
      (await t.call(`/projects/${t.pid}/purchase?contentHash=stale`)).status,
      409,
    );
    assert.equal(t.store.all("SELECT id FROM editions").length, 0);
    assert.equal(t.store.all("SELECT id FROM book_orders").length, 0);
  } finally {
    await t.close();
  }
});

test("freezing the displayed book is idempotent, and availability recovers that same edition without preparing print", async () => {
  const t = await fixture();
  try {
    const payload = { baseRevision: 1, contentHash: t.book.contentHash };
    const results = await Promise.all([
      t.call(`/projects/${t.pid}/editions`, payload),
      t.call(`/projects/${t.pid}/editions`, payload),
    ]);
    const first = (await results[0].json()) as EditionView,
      second = (await results[1].json()) as EditionView;
    assert.equal(first.id, second.id);
    assert.equal(t.store.all("SELECT id FROM editions").length, 1);
    const before = t.store.one<{ n: number }>("SELECT total_changes() n")!.n;
    for (const path of [
      `/projects/${t.pid}/purchase`,
      `/projects/${t.pid}/editions/${first.id}/purchase`,
    ]) {
      const data = await (await t.call(path)).json();
      assert.equal(data.editionId, first.id);
      assert.equal(data.bundle, null);
    }
    assert.equal(
      t.store.one<{ n: number }>("SELECT total_changes() n")!.n,
      before,
    );
    const stored = t.store.one<{ book: string }>(
      "SELECT book FROM editions WHERE id=?",
      first.id,
    )!;
    assert.deepEqual(JSON.parse(stored.book), t.book);
    const stale = await t.call(`/projects/${t.pid}/editions`, {
      ...payload,
      contentHash: "f".repeat(64),
    });
    assert.equal(stale.status, 409);
  } finally {
    await t.close();
  }
});

test("pending changes still block freezing and disabled checkout never calls a provider", async () => {
  const t = await fixture();
  try {
    t.store.run(
      "INSERT INTO corrections VALUES(?,?,1,'fact','Keep the blue coat',NULL,'pending_editorial')",
      id(),
      t.pid,
    );
    const rejected = await t.call(`/projects/${t.pid}/editions`, {
      baseRevision: 1,
      contentHash: t.book.contentHash,
    });
    assert.equal(rejected.status, 409);
    assert.equal(t.store.all("SELECT id FROM editions").length, 0);
    const settings: CommerceSettings = {
      enabled: false,
      automaticTax: true,
      origin: "https://books.example.com",
      stripeKey: "sk_test_syntheticfixturekey",
      webhookSecret: "whsec_fixture",
      assetSecret: "a".repeat(64),
      prodigiKey: "synthetic-print-key",
      mode: "test",
      sku: "SYNTHETIC-SQUARE-BOOK",
      priceCents: 14900,
      physicalProofApproved: false,
      shippingMethod: "Standard",
    };
    let calls = 0;
    await assert.rejects(
      () =>
        startOrder(t.store, "owner", t.pid, id(), settings, async () => {
          calls++;
          throw new Error("Must not dispatch");
        }),
      /ordering is not open/,
    );
    assert.equal(calls, 0);
    assert.equal(t.store.all("SELECT id FROM book_orders").length, 0);
  } finally {
    await t.close();
  }
});
