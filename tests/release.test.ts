import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import {
  inspectReleaseText,
  packageRelease,
} from "../scripts/package-release.js";
import { PUBLIC_ART_SHOWCASE } from "../src/shared/publicArt.js";

test("release scanner refuses credential-like plaintext without repeating it", () => {
  for (const value of [
    "sk" + "-proj-" + "A".repeat(60),
    "sk" + "_live_" + "B".repeat(40),
    "whsec" + "_" + "C".repeat(30),
    "/" + "Users/owner/private/file",
  ]) {
    assert.throws(
      () => inspectReleaseText("src/example.ts", value),
      (error) =>
        error instanceof Error &&
        !error.message.includes(value) &&
        /scan failed/.test(error.message),
    );
  }
  inspectReleaseText(
    "tests/example.test.ts",
    'const key="sk_test_syntheticfixturekey";',
  );
  assert.throws(() =>
    inspectReleaseText(
      "src/example.ts",
      'const key="sk_test_syntheticfixturekey";',
    ),
  );
  assert.throws(() =>
    inspectReleaseText(".env.example", "OPENAI_API_KEY=" + "private-value"),
  );
});
test("release contains only deployable source and synthetic fixtures, with complete relative imports", () => {
  const temporary = mkdtempSync(join(tmpdir(), "everlore-release-"));
  try {
    const target = join(temporary, "release");
    const result = packageRelease(process.cwd(), target);
    assert(existsSync(result.archive));
    const source = join(target, "everlore-source");
    const manifest = JSON.parse(
      readFileSync(join(target, "manifest.json"), "utf8"),
    ) as { files: { path: string }[] };
    for (const forbidden of [
      ".git",
      ".data",
      "work",
      "docs",
      "node_modules",
      "AGENTS.md",
      "DEVELOPMENT_LOOP.md",
    ]) {
      assert(!existsSync(join(source, forbidden)));
    }
    const paths = new Set(manifest.files.map((f) => f.path));
    for (const required of [
      "src/server/index.ts",
      "src/server/app.ts",
      "public/fonts/literata-latin-400-normal.woff",
      ...PUBLIC_ART_SHOWCASE.artworks.map((artwork) => `public${artwork.src}`),
      "Dockerfile",
      "scripts/docker-entrypoint.sh",
      ".github/workflows/ci.yml",
      "pnpm-lock.yaml",
      "fixtures/stories/walt-river.md",
    ]) {
      assert(paths.has(required), required);
    }
    assert.deepEqual(
      [...paths].filter((path) => path.startsWith("public/images/")).sort(),
      PUBLIC_ART_SHOWCASE.artworks
        .map((artwork) => `public${artwork.src}`)
        .sort(),
      "Only the three specifically approved derivative images may be published",
    );
    assert.equal(
      existsSync(join(source, "public/images/legacy-garden.png")),
      false,
    );
    for (const file of manifest.files.filter((f) =>
      /\.(ts|tsx)$/.test(f.path),
    )) {
      const text = readFileSync(join(source, file.path), "utf8");
      for (const match of text.matchAll(
        /(?:from\s*|import\s*\()["'](\.[^"']+)["']/g,
      )) {
        const dependency = normalize(join(dirname(file.path), match[1]));
        assert(
          [
            dependency,
            dependency.replace(/\.js$/, ".ts"),
            dependency.replace(/\.js$/, ".tsx"),
          ].some((p) => paths.has(p)),
          `Missing local import in ${file.path}`,
        );
      }
    }
    assert.throws(
      () => packageRelease(process.cwd(), target),
      /already exists/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
