import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { OpenAIProvider } from "../src/server/engine/provider.js";
import {
  PRINT_RENDER_CANDIDATE,
  ImageRenderSpec,
} from "../src/shared/imageRender.js";
import { activeProfile, verifyProfile } from "../src/server/lab/profiles.js";
import { Store, hash, canonical, id, now } from "../src/server/store.js";
import { testConfig } from "./support/studio-fixtures.js";
import { sampleBook } from "../src/shared/fixture.js";
import { migrateCommerce } from "../src/server/commerce/schema.js";
import {
  preparePrint,
  loadPrintBundle,
  latestPrintBundle,
  renderPrintPreview,
  verifyPrintProduct,
} from "../src/server/commerce/print.js";
const png = (pixels: number) =>
  sharp({
    create: {
      width: pixels,
      height: pixels,
      channels: 3,
      background: "#92ad99",
    },
  })
    .png()
    .toBuffer();

test("native image size is pinned, sent for edits, and receipts preserve dimensions and reference hashes", async () => {
  const output = await png(2560),
    reference = await png(1024);
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    assert.match(String(url), /images\/edits$/);
    const form = init?.body as FormData;
    assert.equal(form.get("size"), "2560x2560");
    assert.equal(form.get("model"), "gpt-image-2");
    assert.equal(form.get("quality"), "high");
    return Response.json({
      data: [{ b64_json: output.toString("base64") }],
      usage: { output_tokens: 100 },
    });
  };
  const provider = new OpenAIProvider(
    { ...testConfig, imageModel: "gpt-image-2" },
    request,
  ).withImageRender(PRINT_RENDER_CANDIDATE);
  assert.equal(
    hash(await provider.image("synthetic test", reference)),
    hash(output),
  );
  const receipt = provider.takeReceipt()!;
  assert.equal(receipt.imageRender?.actual.width, 2560);
  assert.equal(receipt.imageRender?.actual.height, 2560);
  assert.equal(receipt.imageRender?.transformation, "provider_original");
  assert.equal(receipt.imageRender?.specification.capability, "unverified");
  assert.deepEqual(receipt.imageRender?.referenceHashes, [hash(reference)]);
  assert.equal(receipt.imageRender?.outputHash, hash(output));
  assert.equal(calls, 1);
});
test("wrong native resolution is rejected without retry or silent resizing", async () => {
  const output = await png(1024);
  let calls = 0;
  const provider = new OpenAIProvider(
    { ...testConfig, imageModel: "gpt-image-2" },
    async () => {
      calls++;
      return Response.json({ data: [{ b64_json: output.toString("base64") }] });
    },
  ).withImageRender(PRINT_RENDER_CANDIDATE);
  await assert.rejects(
    provider.image("synthetic test"),
    /Unexpected illustration/,
  );
  assert.equal(calls, 1);
  assert.equal(provider.takeReceipt()?.imageRender?.dimensionsMatch, false);
  assert.equal(
    ImageRenderSpec.safeParse({ ...PRINT_RENDER_CANDIDATE, width: 2561 })
      .success,
    false,
  );
  assert.equal(
    ImageRenderSpec.safeParse({
      ...PRINT_RENDER_CANDIDATE,
      capability: "verified",
    }).success,
    false,
  );
});
test("legacy profiles retain their hashes and new baseline profiles remain 1024 until a separate release", () => {
  const dir = mkdtempSync(join(tmpdir(), "everlore-render-profile-")),
    s = new Store(dir);
  try {
    const p = activeProfile(s, testConfig),
      { hash: unused, imageRender: render, ...legacy } = p;
    void unused;
    assert.equal(render?.width, 1024);
    const old = { ...legacy, hash: hash(canonical(legacy)) };
    assert.equal(verifyProfile(old).hash, old.hash);
    assert.equal(verifyProfile(old).imageRender, undefined);
    assert.equal(activeProfile(s, testConfig).hash, p.hash);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
const catalogue = {
  outcome: "Ok",
  product: {
    sku: "SYNTHETIC-SQUARE",
    description: "Hardcover photobook, matte cover and uncoated paper",
    productDimensions: { width: 210, height: 210, units: "mm" },
    printAreas: { default: { required: true }, spine: { required: true } },
    variants: [{ shipsTo: ["US"], attributes: { finish: "matte" } }],
  },
};
const product = () =>
  verifyPrintProduct(catalogue, "SYNTHETIC-SQUARE", {
    spine: { success: true, spineInfo: { widthMm: 7.8 } },
  });
test("product verification rejects guessed material, dimensions, SKU and missing spine geometry", () => {
  assert.throws(() => verifyPrintProduct(catalogue, "OTHER"));
  assert.throws(() => verifyPrintProduct(catalogue, "SYNTHETIC-SQUARE"));
  assert.throws(() =>
    verifyPrintProduct(
      {
        ...catalogue,
        product: { ...catalogue.product, description: "canvas" },
      },
      "SYNTHETIC-SQUARE",
    ),
  );
  const p = product();
  assert.equal(p.requiredAssets[1].widthMm, 7.8);
  assert.equal(p.paper, "uncoated");
});
test("print v2 preserves v1, assembles 32 purposeful interior pages, and uses one saved layout for PDF and preview", async () => {
  const dir = mkdtempSync(join(tmpdir(), "everlore-print-v2-")),
    s = new Store(dir);
  try {
    migrateCommerce(s);
    s.run(
      "INSERT INTO users VALUES('owner','Synthetic','unused','private',?)",
      now(),
    );
    const pid = id(),
      eid = id(),
      legacyId = id();
    s.run(
      "INSERT INTO projects VALUES(?,'owner','Synthetic','sample','complete',1,NULL,?,?)",
      pid,
      now(),
      now(),
    );
    const book = sampleBook(),
      art = s.putAsset(pid, await png(2560), "art");
    for (const spread of book.spreads) spread.artHash = art;
    const original = JSON.stringify(book);
    s.run(
      "INSERT INTO editions VALUES(?,?,?,?,?,?,?)",
      eid,
      pid,
      1,
      book.contentHash,
      "0".repeat(64),
      original,
      now(),
    );
    const oldBundle = {
      version: 1,
      id: legacyId,
      editionId: eid,
      projectId: pid,
      pdfHash: "0".repeat(64),
      pageCount: 34,
      widthMm: 210,
      heightMm: 210,
      minimumPpi: 140,
      ready: false,
      issues: ["Historic proof"],
    };
    s.run(
      "INSERT INTO print_bundles VALUES(?,?,?,?,?)",
      legacyId,
      eid,
      pid,
      JSON.stringify(oldBundle),
      now(),
    );
    const proof = await preparePrint(s, pid, eid);
    assert.equal(proof.ready, false);
    assert.match(proof.issues.join(), /catalogue/);
    const b = await preparePrint(s, pid, eid, { product: product() });
    assert.equal(b.version, 2);
    if (b.version !== 2) throw new Error("Expected version 2");
    assert.equal(b.ready, true);
    assert.ok(b.minimumPpi >= 300);
    assert.equal(b.layout.pages.length, 34);
    assert.equal(b.layout.pages[0].role, "cover");
    assert.equal(b.layout.pages[33].role, "back_cover");
    assert.ok(b.layout.pages.every((p) => p.text.length || p.images.length));
    assert.equal(
      b.layout.pages.filter((p) => p.role === "story_art").length,
      12,
    );
    const story = b.layout.pages
      .filter((p) => p.role === "story_text")
      .map((p) => p.text[0].lines.join(" "));
    assert.deepEqual(
      story,
      book.spreads.map((p) => p.text),
    );
    assert.equal(b.assets.length, 2);
    const pdf = await PDFDocument.load(s.readAsset(pid, b.pdfHash));
    assert.equal(pdf.getPageCount(), 34);
    const spine = await PDFDocument.load(s.readAsset(pid, b.assets[1].pdfHash));
    assert.ok(
      Math.abs(spine.getPage(0).getWidth() - (7.8 * 72) / 25.4) < 0.001,
    );
    const preview = await renderPrintPreview(s, b, 4);
    assert.equal((await sharp(preview).metadata()).width, 595);
    assert.equal(
      (await preparePrint(s, pid, eid, { product: product() })).id,
      b.id,
    );
    assert.equal(latestPrintBundle(s, eid)?.id, b.id);
    assert.deepEqual(loadPrintBundle(s, legacyId), oldBundle);
    assert.equal(
      s.one<{ book: string }>("SELECT book FROM editions WHERE id=?", eid)!
        .book,
      original,
    );
    await assert.rejects(
      renderPrintPreview(s, { ...b, layoutHash: "0".repeat(64) }, 4),
    );
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("print-art revision requires verified capability, keeps source/profile/story/editions intact, and replaces all twelve images", async () => {
  const { queueStudio, runStudio, queueRepair } =
    await import("../src/server/engine/studio.js");
  const { queuePrintArtwork } =
    await import("../src/server/engine/print-edition.js");
  const { StudioFake } = await import("./support/studio-fixtures.js");
  const { Book } = await import("../src/shared/contracts.js");
  const dir = mkdtempSync(join(tmpdir(), "everlore-print-revision-")),
    s = new Store(dir);
  try {
    s.run(
      "INSERT INTO users VALUES('owner','Synthetic','unused','private',?)",
      now(),
    );
    s.run(
      "INSERT INTO projects VALUES('memory','owner','Synthetic','unavailable','awaiting_transcription',0,NULL,?,?)",
      now(),
      now(),
    );
    const audio = s.putAsset("memory", "synthetic audio only", "audio");
    s.run(
      "INSERT INTO recordings VALUES('rec','memory',?,'audio/wav',20,'upload',?)",
      audio,
      now(),
    );
    const getProject = () =>
      s.one<import("../src/server/store.js").ProjectRow>(
        "SELECT * FROM projects WHERE id='memory'",
      )!;
    const config = { ...testConfig, imageModel: "gpt-image-2" };
    queueStudio(
      s,
      getProject(),
      {
        processWithOpenAI: true,
        imaginativeAdaptation: true,
        autonomous: true,
        legacyWish: "",
      },
      config,
    );
    await runStudio(s, new StudioFake(), config);
    const oldText = s.one<{ book: string }>(
        "SELECT book FROM revisions WHERE projectId='memory' AND revision=1",
      )!.book,
      old = Book.parse(JSON.parse(oldText));
    const originalEdition = s.one<{ id: string; book: string }>(
      "SELECT * FROM editions WHERE projectId='memory'",
    )!;
    const request = { key: id(), baseRevision: 1 };
    assert.throws(
      () =>
        queuePrintArtwork(
          s,
          getProject(),
          request,
          config,
          PRINT_RENDER_CANDIDATE,
        ),
      /capability evidence/,
    );
    assert.throws(
      () =>
        queueRepair(
          s,
          getProject(),
          {
            ...request,
            kind: "resolution",
            spreads: Array.from({ length: 12 }, (_, i) => i + 1),
            characterId: null,
            defect: "pixels",
            intendedChange: "native detail",
            preserve: "everything",
          },
          config,
        ),
      /verified/,
    );
    const verified = {
      ...PRINT_RENDER_CANDIDATE,
      capability: "verified" as const,
      capabilityEvidenceHash: hash("synthetic test evidence only"),
    };
    const job = queuePrintArtwork(s, getProject(), request, config, verified);
    assert.equal(
      queuePrintArtwork(s, getProject(), request, config, verified),
      job,
    );
    class PrintFake extends StudioFake {
      imageReferenceHashes: string[][] = [];
      async image(_prompt: string, references?: Buffer | Buffer[]) {
        this.calls.push("image_native_fixture");
        this.imageReferenceHashes.push(
          (Array.isArray(references)
            ? references
            : references
              ? [references]
              : []
          ).map(hash),
        );
        return sharp({
          create: {
            width: 2560,
            height: 2560,
            channels: 3,
            background: { r: this.calls.length % 255, g: 70, b: 120 },
          },
        })
          .png()
          .toBuffer();
      }
    }
    const provider = new PrintFake();
    await runStudio(s, provider, config);
    const next = Book.parse(
      JSON.parse(
        s.one<{ book: string }>(
          "SELECT book FROM revisions WHERE projectId='memory' AND revision=2",
        )!.book,
      ),
    );
    assert.deepEqual(
      next.spreads.map((p) => p.text),
      old.spreads.map((p) => p.text),
    );
    assert.deepEqual(next.production?.heart, old.production?.heart);
    assert.deepEqual(next.production?.plan, old.production?.plan);
    assert.deepEqual(next.production?.scenes, old.production?.scenes);
    assert.equal(next.production?.engineProfile?.imageRender?.width, 2560);
    assert.equal(
      activeProfile(s, config).hash,
      old.production?.engineProfile?.hash,
    );
    assert.equal(provider.imageReferenceHashes.length, 12);
    for (const previous of old.spreads)
      assert.ok(
        provider.imageReferenceHashes.some((refs) =>
          refs.includes(previous.artHash),
        ),
      );
    for (const spread of next.spreads)
      assert.equal(
        (await sharp(s.readAsset("memory", spread.artHash)).metadata()).width,
        2560,
      );
    assert.equal(
      s.one<{ book: string }>(
        "SELECT book FROM revisions WHERE projectId='memory' AND revision=1",
      )!.book,
      oldText,
    );
    assert.equal(
      s.one<{ book: string }>(
        "SELECT book FROM editions WHERE id=?",
        originalEdition.id,
      )!.book,
      originalEdition.book,
    );
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
