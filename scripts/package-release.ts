import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const rootFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vite.config.ts",
  "eslint.config.js",
  "playwright.config.ts",
  "index.html",
  "Dockerfile",
  ".dockerignore",
  ".gitignore",
  ".env.example",
  "render.yaml",
  ".github/workflows/ci.yml",
];
const scripts = [
  "run.sh",
  "operator.ts",
  "openai.ts",
  "backup.ts",
  "commerce.ts",
  "prodigi.ts",
  "stripe.ts",
  "lab.ts",
  "docker-entrypoint.sh",
  "package-release.ts",
];
const assets = [
  "public/fonts/Literata-LICENSE",
  "public/fonts/literata-latin-400-normal.woff",
  "public/images/legacy-garden.png",
];
const fixtures = [
  "fixtures/stories/june-lilac.md",
  "fixtures/stories/rosa-grocer.md",
  "fixtures/stories/walt-river.md",
];
const syntheticTokens = new Set([
  "sk_test_syntheticfixturekey",
  "sk_test_synthetickeyfortestonly",
  "sk_test_rejectedsynthetickey",
  "sk_test_stalesynthetickey",
  "sk_test_newersynthetickey",
  "sk_live_synthetickeyfortestonly",
]);
const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
function safePath(root: string, path: string) {
  if (isAbsolute(path) || path.split(/[\\/]/).some((p) => p === ".."))
    throw new Error("Unsafe release path.");
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error(`Release refuses symbolic links: ${path}`);
  }
  if (!lstatSync(current).isFile())
    throw new Error(`Release source is not a file: ${path}`);
  return current;
}
export function inspectReleaseText(path: string, text: string) {
  const suspicious = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bsk-proj-[A-Za-z0-9_-]{20,}/,
    /\bsk-[A-Za-z0-9]{32,}/,
    /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/,
    /\bAKIA[A-Z0-9]{16}\b/,
    /\bwhsec_[A-Za-z0-9]{24,}/,
    /(?:apiKey|prodigiKey|stripeKey|assetSecret|webhookSecret)\s*[:=]\s*["'][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}["']/i,
    /\/(?:Users|home)\/[^\s/]+\//,
  ];
  if (suspicious.some((rule) => rule.test(text)))
    throw new Error(
      `Release privacy scan failed in ${path}; inspect locally. No matching content was logged.`,
    );
  for (const match of text.matchAll(
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  )) {
    if (
      (!path.startsWith("tests/") && path !== "scripts/package-release.ts") ||
      !syntheticTokens.has(match[0])
    )
      throw new Error(
        `Release credential scan failed in ${path}; inspect locally. No matching content was logged.`,
      );
  }
  if (path === ".env.example")
    for (const line of text.split(/\r?\n/)) {
      if (
        /^(?:OPENAI_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|PRODIGI_API_KEY|PRINT_ASSET_SECRET|EVERLORE_OPERATOR_PASSWORD)=.+/.test(
          line.trim(),
        )
      )
        throw new Error(
          "Release environment template contains a non-empty secret setting.",
        );
    }
}
function sourceFiles(root: string) {
  const result = [
    ...rootFiles,
    ...scripts.map((p) => `scripts/${p}`),
    ...assets,
    ...fixtures,
  ];
  function walk(path: string) {
    const full = join(root, path);
    if (lstatSync(full).isSymbolicLink())
      throw new Error(`Release refuses symbolic links: ${path}`);
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const next = `${path}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw new Error(`Release refuses symbolic links: ${next}`);
      if (entry.isDirectory()) walk(next);
      else if ([".ts", ".tsx", ".css"].includes(extname(next)))
        result.push(next);
      else throw new Error(`Unexpected file in source/test allowlist: ${next}`);
    }
  }
  walk("src");
  walk("tests");
  return [...new Set(result)].sort();
}
// A small, portable ustar writer keeps local usernames, timestamps, extended
// attributes, and absolute source paths out of the published archive.
function archiveFiles(files: { path: string; bytes: Buffer }[]) {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const name = `everlore-source/${file.path}`;
    if (Buffer.byteLength(name) > 100)
      throw new Error("Release archive path is too long.");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    const octal = (value: number, at: number, size: number) =>
      header.write(value.toString(8).padStart(size - 1, "0") + "\0", at, size);
    octal(file.path.endsWith(".sh") ? 0o755 : 0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(file.bytes.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write("root", 265);
    header.write("root", 297);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(
      header,
      file.bytes,
      Buffer.alloc((512 - (file.bytes.length % 512)) % 512),
    );
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
const readme = `# Everlore

Private family stories, original illustrated books, and a guarded purchase-to-print pilot. This source package contains application code, original public demo artwork, and synthetic development fixtures. It contains no family recordings, saved editions, database, provider keys, local logs, or previous Git history.

## Run and verify

Use Node.js 24 and pnpm 11.19.0. Run \`pnpm install --frozen-lockfile\`, then \`pnpm typecheck\`, \`pnpm lint\`, \`pnpm test\`, and \`pnpm build\`. Install Chromium with \`pnpm exec playwright install --with-deps chromium\` before \`pnpm test:e2e\`. Run \`pnpm start\` and open http://127.0.0.1:4317. Local offline development starts with generation and checkout disabled. Environment files are templates; the app does not automatically load them.

## Hosted private pilot

Deploy the provided Render blueprint as one Docker web service with its 10 GB persistent disk. The assigned HTTPS origin is read from RENDER_EXTERNAL_URL; set PUBLIC_ORIGIN only to override it. Keep CHECKOUT_ENABLED=false and DISABLE_WORKER=1 until private configuration and recovery verification are complete. No local family data should be copied to the public repository.

Provision the operator in the Render service shell: temporarily configure EVERLORE_OPERATOR_PASSWORD as a private environment secret, then run \`node --import tsx scripts/operator.ts create Operator\`. Remove the temporary password environment variable after provisioning. For an existing private shelf use \`node --import tsx scripts/operator.ts set SHELF_NAME\`. Do not let public registration select the operator. Sign in at /#/login, then use /#/operator/access to issue single-use invitations using the existing authorized generation budget.

Private runtime settings include OPENAI_API_KEY and explicitly authorized EVERMORE_BUDGET_USD / request reserves; Stripe Secret key and webhook signing secret; Prodigi key; PRINT_ASSET_SECRET; and a verified print product SKU. Use provider test/sandbox credentials for the hosted integration test. Keys belong in private hosting environment settings, never source control. Stripe webhooks use /api/payments/stripe/webhook. The pilot merchandise price is USD 149, including standard US shipping; tax is calculated separately by Stripe. Do not enable live checkout until the selected product, tax configuration, provider billing, generated print assets and physical proof have passed review.

The mounted data directory is /var/data/everlore. The container entrypoint prepares that directory and drops to the node user. /healthz is liveness; /readyz requires storage, a configured operator and a non-draining server. Keep a single instance: its SQLite and worker share one disk.

## Recovery and evidence

Run \`node --import tsx scripts/backup.ts create DATA_DIR NEW_BACKUP_DIR\` to create a full private backup; verify it and test restoration into a new empty directory with the same command's verify/restore actions. Backups include secrets and family records: store them privately with encryption and restricted access. Restored services have a persistent recovery lock. Keep DISABLE_WORKER=1 while reconciling paid outcomes, then record evidence with the operator release-recovery command before enabling workers. Never run two services against copied active order state.

Operator commerce recovery is at /#/operator/orders. Unknown paid outcomes must be reconciled before retrying; no automatic duplicate print order or refund should be issued. Existing edition and order hashes remain immutable. Model evaluations are provisional and never stand in for observed child engagement.

## Source provenance

The three stories in fixtures/stories are synthetic development inputs, not customer memories. Public demo art is an original Everlore asset. The font's license accompanies it. This package does not grant an additional open-source license to the application; repository publication and licensing are owner decisions.

GitHub Actions runs engineering, browser, sanitized-package and Docker-mounted-storage checks with no provider secrets. Passing those checks is not a live payment, printing, physical-proof or audience-quality result.
`;
const fixtureNote =
  "These three story inputs are synthetic development fixtures supplied for Everlore testing. They are not recordings or transcripts from a customer family.\n";
export function packageRelease(rootPath: string, destination: string) {
  const root = resolve(rootPath),
    target = resolve(destination),
    fromRoot = relative(root, target);
  if (!fromRoot || (!fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)))
    throw new Error("Release destination must be outside the source checkout.");
  if (existsSync(target))
    throw new Error(
      "Release destination already exists; choose a new directory.",
    );
  const files = sourceFiles(root).map((path) => {
    const full = safePath(root, path),
      bytes = readFileSync(full);
    if (!assets.includes(path) || path.endsWith("-LICENSE"))
      inspectReleaseText(path, bytes.toString("utf8"));
    return { path, bytes, sha256: digest(bytes) };
  });
  const stage = `${target}.tmp-${process.pid}`;
  if (existsSync(stage))
    throw new Error("Release staging directory already exists.");
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    const source = join(stage, "everlore-source");
    mkdirSync(source, { mode: 0o755 });
    for (const file of files) {
      const out = join(source, file.path);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, file.bytes, {
        mode: file.path.endsWith(".sh") ? 0o755 : 0o644,
      });
    }
    writeFileSync(join(source, "README.md"), readme);
    writeFileSync(join(source, "fixtures", "README.md"), fixtureNote);
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      privacy:
        "Code-only allowlist; source text credential scan passed; no Git history or private data copied.",
      files: [
        ...files.map((f) => ({
          path: f.path,
          bytes: f.bytes.length,
          sha256: f.sha256,
        })),
        {
          path: "README.md",
          bytes: Buffer.byteLength(readme),
          sha256: digest(readme),
        },
        {
          path: "fixtures/README.md",
          bytes: Buffer.byteLength(fixtureNote),
          sha256: digest(fixtureNote),
        },
      ],
    };
    writeFileSync(
      join(stage, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    const archive = join(stage, "everlore-source.tar.gz");
    writeFileSync(
      archive,
      archiveFiles([
        ...files,
        { path: "README.md", bytes: Buffer.from(readme) },
        { path: "fixtures/README.md", bytes: Buffer.from(fixtureNote) },
      ]),
    );
    writeFileSync(
      join(stage, "SHA256SUMS"),
      `${digest(readFileSync(archive))}  everlore-source.tar.gz\n`,
    );
    renameSync(stage, target);
    return {
      directory: target,
      archive: join(target, "everlore-source.tar.gz"),
      files: manifest.files.length,
    };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(
        packageRelease(process.cwd(), process.argv[2] ?? "../Everlore-release"),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Release packaging failed.",
    );
    process.exitCode = 1;
  }
}
