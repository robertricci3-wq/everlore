import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { Store, hash } from "../src/server/store.js";
import {
  HOSTED_BOOK_TEST,
  openReadOnlyBookStore,
  reportHostedBook,
} from "../scripts/hosted-book-test.js";

const secret = "DO_NOT_REPORT_PRIVATE_CONTENT";
const at = "2026-10-08T12:00:00.000Z";
const profileHash = hash("synthetic pinned profile");
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-hosted-report-"));
  const store = new Store(dir);
  store.run(
    "INSERT INTO users VALUES('operator',?,?, 'private',?)",
    HOSTED_BOOK_TEST.operatorName,
    secret,
    at,
  );
  store.run(
    "INSERT INTO users VALUES('other','Other family',?,'private',?)",
    secret,
    at,
  );
  store.run(
    "INSERT INTO projects VALUES('project','operator',?,'live','ready',1,?,?,?)",
    secret,
    JSON.stringify({ rawText: secret }),
    at,
    at,
  );
  store.run(
    "INSERT INTO projects VALUES('other-project','other',?,'manual','draft',0,NULL,?,?)",
    secret,
    at,
    at,
  );
  const recording = store.putAsset(
    "project",
    `RIFF synthetic audio ${secret}`,
    "audio",
  );
  store.run(
    "INSERT INTO recordings VALUES('rec','project',?,'audio/wav',1,'upload',?)",
    recording,
    at,
  );
  const spreads = [];
  for (let i = 0; i < 12; i++) {
    const png = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: i * 10, g: 120, b: 60 },
      },
    })
      .png()
      .toBuffer();
    spreads.push({
      id: `spread-${i}`,
      text: secret,
      artHash: store.putAsset("project", png, "image"),
    });
  }
  const book = {
    title: secret,
    spreads,
    sourceHash: hash(secret),
    transcript: { rawText: secret },
    production: { engineProfile: { hash: profileHash, instructions: secret } },
  };
  const contentHash = hash(JSON.stringify(book));
  store.run(
    "INSERT INTO revisions VALUES('project',1,?,?)",
    JSON.stringify(book),
    contentHash,
  );
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 14; i++) pdf.addPage([1200, 600]);
  const pdfHash = store.putAsset("project", await pdf.save(), "pdf");
  store.run(
    "INSERT INTO editions VALUES('edition','project',1,?,?,?,?)",
    contentHash,
    pdfHash,
    JSON.stringify(book),
    at,
  );
  store.run(
    "INSERT INTO studio_jobs(id,projectId,baseRevision,kind,status,stage,request,state,profile,allowance,error,createdAt) VALUES('job','project',0,'generation','complete','complete',?,?,?,7500,?,?)",
    JSON.stringify({ secret }),
    JSON.stringify({ secret }),
    profileHash,
    secret,
    at,
  );
  store.run(
    "INSERT INTO studio_steps VALUES('job','source',?,'complete',?)",
    hash(secret),
    JSON.stringify({ transcript: secret }),
  );
  for (const [id, status, estimate, actual] of [
    ["call-1", "completed", 125, 40],
    ["call-2", "failed", 200, null],
    ["call-3", "rejected", 300, null],
    ["call-4", "started", 75, null],
  ] as const) {
    store.run(
      "INSERT INTO studio_calls VALUES(?, 'job','draft','text','synthetic-model',?,?,10,?,?, ?,?,?)",
      id,
      hash(secret),
      status,
      `req_${id}`,
      JSON.stringify({
        input_tokens: 10,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 3, secret },
        secret,
        text: secret,
      }),
      estimate,
      actual,
      at,
    );
  }
  return {
    dir,
    store,
    recording,
    contentHash,
    pdfHash,
    spreads,
    book,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("read-only report retains every attempt and separates estimates from unknown billing without exposing source or secrets", async () => {
  const t = await fixture();
  try {
    const before = t.store.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM studio_calls",
    )!.count;
    const report = await reportHostedBook(t.store, "project", {
      sourceHash: t.recording,
      profileHash,
      observedAt: at,
    });
    assert.equal(report.testPlan.name, "synthetic-rosa-hosted-v1");
    assert.equal(report.operatorNameMatches, true);
    assert.equal(report.sourceMatchesExpected, true);
    assert.equal(report.profilesMatchExpected, true);
    assert.deepEqual(report.profileHashes, [profileHash]);
    assert.equal(report.jobs[0].allowanceCents, 7500);
    assert.equal(report.jobs[0].errorRecorded, true);
    assert.deepEqual(
      report.jobs[0].calls.map((c) => c.status),
      ["completed", "failed", "rejected", "started"],
    );
    assert.deepEqual(report.jobs[0].calls[0].usage, {
      input_tokens: 10,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 3 },
    });
    assert.equal(report.costs.estimatedAllAttemptsCents, 700);
    assert.equal(report.costs.estimatedPotentiallyBilledCents, 400);
    assert.equal(report.costs.knownActualSubtotalCents, 40);
    assert.equal(report.costs.actualCents, null);
    assert.equal(report.costs.attemptsWithoutActualBilling, 3);
    assert.equal(report.book.readableImages, 12);
    assert.equal(report.book.uniqueImageHashes, 12);
    assert.equal(report.book.profileHash, profileHash);
    assert.equal(report.book.sourceHash, hash(secret));
    assert.equal(report.editions[0].contentHash, t.contentHash);
    assert.equal(report.editions[0].pdfHash, t.pdfHash);
    assert.equal(report.editions[0].pdf.pages, 14);
    assert.equal(report.outputChecks.currentEditionReadable, true);
    assert.equal(report.outputChecks.twelveReadableIllustrations, true);
    assert.equal(report.outputChecks.browserJourney, "unverified");
    assert.equal(report.outputChecks.visualQuality, "unverified");
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(
      t.store.one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM studio_calls",
      )!.count,
      before,
    );
  } finally {
    t.close();
  }
});

test("explicit source/profile mismatches and budget excess are reported rather than triggering a retry", async () => {
  const t = await fixture();
  try {
    t.store.run(
      "UPDATE studio_calls SET estimatedCents=8000,actualCents=9000 WHERE id='call-2'",
    );
    const report = await reportHostedBook(t.store, "project", {
      sourceHash: hash("different audio"),
      profileHash: hash("different profile"),
    });
    assert.equal(report.sourceMatchesExpected, false);
    assert.equal(report.profilesMatchExpected, false);
    assert.equal(report.costs.withinEstimatedTestCeiling, false);
    assert.equal(report.jobs.length, 1);
    assert.equal(report.jobs[0].calls.length, 4);
    await assert.rejects(
      reportHostedBook(t.store, "project", { sourceHash: secret }),
      /SHA-256/,
    );
    await assert.rejects(
      reportHostedBook(t.store, "missing"),
      /explicitly selected/,
    );
  } finally {
    t.close();
  }
});

test("corrupt images, another family's asset and an invalid PDF cannot pass artifact checks", async () => {
  const t = await fixture();
  try {
    writeFileSync(join(t.dir, "media", t.spreads[0].artHash), "corrupt");
    const otherHash = t.store.putAsset(
      "other-project",
      "other family asset",
      "image",
    );
    t.book.spreads[1].artHash = otherHash;
    t.store.run(
      "UPDATE revisions SET book=? WHERE projectId='project'",
      JSON.stringify(t.book),
    );
    const invalidPdf = t.store.putAsset("project", "not a PDF", "pdf");
    t.store.run("UPDATE editions SET pdfHash=? WHERE id='edition'", invalidPdf);
    const report = await reportHostedBook(t.store, "project");
    assert.equal(report.book.readableImages, 10);
    assert.equal(report.book.images[0].integrity, "unavailable_or_corrupt");
    assert.equal(report.book.images[1].integrity, "unavailable_or_corrupt");
    assert.equal(report.outputChecks.twelveReadableIllustrations, false);
    assert.equal(report.editions[0].pdf.integrity, "verified");
    assert.equal(report.editions[0].pdf.pages, null);
    assert.equal(report.outputChecks.currentEditionReadable, false);
  } finally {
    t.close();
  }
});

test("opening the report store is genuinely read-only, does not migrate and leaves database/media unchanged", async () => {
  const t = await fixture();
  try {
    t.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const databaseBefore = hash(readFileSync(join(t.dir, "evermore.sqlite")));
    const tablesBefore = t.store.all(
      "SELECT name,sql FROM sqlite_master ORDER BY name",
    );
    const assetsBefore = readdirSync(join(t.dir, "media"))
      .sort()
      .map((name) => [name, hash(readFileSync(join(t.dir, "media", name)))]);
    const reader = openReadOnlyBookStore(t.dir);
    try {
      const report = await reportHostedBook(reader, "project", {
        observedAt: at,
      });
      assert.equal(report.book.readableImages, 12);
      assert.throws(
        () =>
          reader.one("DELETE FROM projects WHERE id='project' RETURNING id"),
        /readonly|read.only/i,
      );
    } finally {
      reader.close();
    }
    assert.equal(
      hash(readFileSync(join(t.dir, "evermore.sqlite"))),
      databaseBefore,
    );
    assert.deepEqual(
      t.store.all("SELECT name,sql FROM sqlite_master ORDER BY name"),
      tablesBefore,
    );
    assert.deepEqual(
      readdirSync(join(t.dir, "media"))
        .sort()
        .map((name) => [name, hash(readFileSync(join(t.dir, "media", name)))]),
      assetsBefore,
    );
  } finally {
    t.close();
  }
});

test("an unstarted recording has no invented cost, pin, edition or completion evidence", async () => {
  const t = await fixture();
  try {
    const report = await reportHostedBook(t.store, "other-project", {
      profileHash,
    });
    assert.equal(report.source, null);
    assert.equal(report.sourceMatchesExpected, null);
    assert.equal(report.profilesMatchExpected, false);
    assert.equal(report.costs.actualCents, null);
    assert.equal(report.jobs.length, 0);
    assert.equal(report.editions.length, 0);
    assert.equal(report.outputChecks.completedGeneration, false);
    assert.equal(report.outputChecks.currentEditionReadable, false);
    assert.equal(report.outputChecks.twelveReadableIllustrations, false);
  } finally {
    t.close();
  }
});
