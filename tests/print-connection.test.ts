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
  loadPrintConnection,
  PRODIGI_PROBE_SKU,
  saveVerifiedPrintConnection,
  verifyProdigiConnection,
} from "../src/server/print/connection.js";

const key = "synthetic-prodigi-key-for-test-only";
const response = () =>
  Response.json({ outcome: "Ok", product: { sku: PRODIGI_PROBE_SKU } });
test("Prodigi verification uses a fixed authenticated GET without redirect or order dispatch", async () => {
  const seen: string[] = [];
  const request: typeof fetch = async (url, init) => {
    seen.push(String(url));
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("X-API-Key"), key);
    return response();
  };
  for (const environment of ["live", "sandbox"] as const) {
    const result = await verifyProdigiConnection(key, environment, request);
    assert.equal(result.catalogueAccess, true);
    assert.equal(result.orderingEnabled, false);
    assert.ok(!JSON.stringify(result).includes(key));
  }
  assert.deepEqual(seen, [
    `https://api.prodigi.com/v4.0/products/${PRODIGI_PROBE_SKU}`,
    `https://api.sandbox.prodigi.com/v4.0/products/${PRODIGI_PROBE_SKU}`,
  ]);
});

test("verified print credentials persist privately and a rejected replacement preserves them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "everlore-print-"));
  try {
    await saveVerifiedPrintConnection(dir, key, "live", async () => response());
    const path = join(dir, "prodigi-connection.json"),
      before = readFileSync(path, "utf8");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(loadPrintConnection(dir)?.apiKey, key);
    await assert.rejects(
      saveVerifiedPrintConnection(
        dir,
        "rejected-synthetic-key",
        "live",
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
  const dir = mkdtempSync(join(tmpdir(), "everlore-print-"));
  try {
    let calls = 0;
    await assert.rejects(
      saveVerifiedPrintConnection(dir, key, "live", async () => {
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
      saveVerifiedPrintConnection(dir, key, "live", async () =>
        Response.json({ outcome: "Ok", key }),
      ),
      /unexpected catalogue response/,
    );
    assert.equal(loadPrintConnection(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale connection check cannot overwrite a newer saved key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "everlore-print-"));
  try {
    await saveVerifiedPrintConnection(dir, key, "live", async () => response());
    const path = join(dir, "prodigi-connection.json");
    await assert.rejects(
      saveVerifiedPrintConnection(
        dir,
        "stale-synthetic-key",
        "live",
        async () => {
          const next = JSON.parse(readFileSync(path, "utf8"));
          next.apiKey = "newer-synthetic-key";
          writeFileSync(path, JSON.stringify(next));
          return response();
        },
      ),
      /changed during verification/,
    );
    assert.equal(loadPrintConnection(dir)?.apiKey, "newer-synthetic-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
