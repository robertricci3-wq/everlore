import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import {
  PUBLIC_ART_SHOWCASE,
  PUBLIC_HERO_ARTWORK,
} from "../src/shared/publicArt.js";

test("public artwork manifest is a deliberately limited gallery without private book or family fields", () => {
  assert.equal(PUBLIC_ART_SHOWCASE.version, 1);
  assert.equal(PUBLIC_ART_SHOWCASE.id, "animal-stories-v1");
  assert.equal(PUBLIC_ART_SHOWCASE.artworks.length, 3);
  assert.deepEqual(Object.keys(PUBLIC_ART_SHOWCASE).sort(), [
    "artworks",
    "attribution",
    "description",
    "heading",
    "heroId",
    "id",
    "version",
  ]);
  assert.deepEqual(
    PUBLIC_ART_SHOWCASE.artworks.map((art) => art.id),
    ["invitation", "connection", "remembering"],
  );
  assert.equal(PUBLIC_HERO_ARTWORK, PUBLIC_ART_SHOWCASE.artworks[1]);
  assert.equal(
    PUBLIC_ART_SHOWCASE.description,
    "Your family, reimagined as storybook animals. Your memories, made extraordinary.",
  );
  assert.equal(
    PUBLIC_ART_SHOWCASE.attribution,
    "Illustrations from an Everlore family story, shared with permission.",
  );
  for (const art of PUBLIC_ART_SHOWCASE.artworks) {
    assert.deepEqual(Object.keys(art).sort(), [
      "alt",
      "caption",
      "height",
      "id",
      "src",
      "title",
      "width",
    ]);
    assert.match(
      art.src,
      /^\/images\/showcase\/(?:invitation|connection|remembering)-v1\.webp$/,
    );
    assert(
      art.alt.length > 40,
      "Useful descriptive alternative text is required",
    );
    assert(art.caption.length > 0 && art.title.length > 0);
  }
  const serialized = JSON.stringify(PUBLIC_ART_SHOWCASE);
  for (const forbidden of [
    /\/api\/projects\//i,
    /\/Users\//i,
    /\.data\//i,
    /\/media\//i,
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i,
    /"(?:transcript|manuscript|recording|sourceHash|projectId|editionId|ownerId|people|ledger)"/i,
  ])
    assert.doesNotMatch(serialized, forbidden);
});

test("the only public raster artwork is the three approved optimized derivatives, with no embedded metadata", async () => {
  const actual: string[] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      assert.equal(
        lstatSync(path).isSymbolicLink(),
        false,
        "Public image assets must not be symlinks to private files",
      );
      if (entry.isDirectory()) collect(path);
      else actual.push(path.replaceAll("\\", "/"));
    }
  };
  collect("public/images");
  assert.deepEqual(
    actual.sort(),
    PUBLIC_ART_SHOWCASE.artworks.map((art) => `public${art.src}`).sort(),
  );
  for (const art of PUBLIC_ART_SHOWCASE.artworks) {
    const bytes = readFileSync(`public${art.src}`);
    assert(bytes.length > 0);
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, art.width);
    assert.equal(metadata.height, art.height);
    assert.equal(metadata.width, 1024);
    assert.equal(metadata.height, 1024);
    for (const key of ["exif", "icc", "iptc", "xmp", "comments"] as const)
      assert.equal(
        metadata[key],
        undefined,
        `Embedded ${key} must not disclose private provenance`,
      );
    await sharp(bytes).raw().toBuffer(); // Decode the complete image, not just its header.
  }
});
