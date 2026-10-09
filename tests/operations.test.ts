import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, now } from "../src/server/store.js";
import { createBackup, restoreBackup, verifyBackup } from "../src/server/backup.js";
import { startWorkerLanes } from "../src/server/worker-lanes.js";
import { migrateCommerce } from "../src/server/commerce/schema.js";
import { isRecoveryLocked, releaseRecoveryLock } from "../src/server/recovery-lock.js";

test("fulfillment runs while creative work is pending and shutdown drains active work", async () => {
  let release!: () => void, fulfilled = 0, active = 0, maxActive = 0;
  const gate = new Promise<void>(r => release = r);
  const workers = startWorkerLanes([
    { name: "creative", run: async () => { active++; maxActive = Math.max(maxActive, active); await gate; active--; } },
    { name: "fulfillment", run: async () => { fulfilled++; } },
  ], { intervalMs: 100000 });
  workers.tick(); await new Promise(r => setImmediate(r));
  workers.tick(); await new Promise(r => setImmediate(r));
  assert.equal(maxActive, 1); assert.equal(active, 1); assert.equal(fulfilled, 2);
  let closed = false;
  const drain = workers.stop().then(() => closed = true);
  await new Promise(r => setImmediate(r)); assert.equal(closed, false);
  release(); await drain; assert.equal(closed, true);
  workers.tick(); await new Promise(r => setImmediate(r)); assert.equal(fulfilled, 2);
});

test("full backup restores assets and payment deduplication without overwriting family work", async () => {
  const root = mkdtempSync(join(tmpdir(), "everlore-backup-")), s = new Store(join(root, "source"));
  try {
    migrateCommerce(s);
    s.run("INSERT INTO users VALUES('owner','Owner','private-password-hash','private',?)", now());
    s.run("INSERT INTO projects VALUES('project','owner','A book','sample','complete',1,NULL,?,?)", now(), now());
    const digest = s.putAsset("project", Buffer.from("saved art"), "art");
    s.run("INSERT INTO book_orders(id,ownerId,projectId,editionId,bundleId,amountCents,mode,sku,shippingMethod,status,createdAt,updatedAt) VALUES('order','owner','project','edition','bundle',14900,'test','test-sku','Standard','paid',?,?)", now(), now());
    s.run("INSERT INTO payment_events VALUES('evt_paid','order',?)", now());
    writeFileSync(join(s.dir, "stripe-connection.json"), '{"synthetic":"not-a-real-key"}', {mode:0o600});
    const dest = join(root, "snapshot"); await createBackup(s, dest);
    assert.ok(verifyBackup(dest).files.some(f => f.path === `media/${digest}`));
    assert.throws(() => restoreBackup(dest, s.dir), /new data directory/);
    const restored = join(root, "restored"); restoreBackup(dest, restored);
    const copy = new Store(restored);
    try {
      assert.equal(copy.one<{status:string}>("SELECT status FROM book_orders WHERE id='order'")?.status, "paid");
      assert.ok(copy.one("SELECT id FROM payment_events WHERE id='evt_paid'"));
      assert.equal(copy.readAsset("project", digest).toString(), "saved art");
      assert.equal(readFileSync(join(restored,"stripe-connection.json"),"utf8"), '{"synthetic":"not-a-real-key"}');
      assert.equal(isRecoveryLocked(copy), true);
      assert.equal(isRecoveryLocked(s), false);
      assert.throws(() => releaseRecoveryLock(copy, "checked"), /evidence/);
      let calls = 0;
      const workers = startWorkerLanes([{ name: "paid", run: async () => { calls++; } }], { intervalMs: 100000, disabled: () => isRecoveryLocked(copy) });
      workers.tick(); await new Promise(r => setImmediate(r));
      assert.equal(calls, 0);
      releaseRecoveryLock(copy, "Synthetic provider ledger reconciled through snapshot recovery time.");
      workers.tick(); await new Promise(r => setImmediate(r));
      assert.equal(calls, 1);
      await workers.stop();
      assert.equal(isRecoveryLocked(copy), false);
    } finally { copy.close(); }
    writeFileSync(join(dest,"media",digest),"corrupt");
    assert.throws(() => verifyBackup(dest), /integrity/);
    assert.throws(() => restoreBackup(dest, join(root,"bad")), /integrity/);
  } finally { s.close(); rmSync(root, {recursive:true,force:true}); }
});
