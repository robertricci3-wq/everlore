import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import type { Store } from "../src/server/store.js";

// Observation only. This script never authenticates, queues, resumes, or calls
// a provider. Run it against the hosted store or an explicitly obtained backup.
export const HOSTED_BOOK_TEST = {
  name: "synthetic-rosa-hosted-v1",
  operatorName: "robert-ricci",
  maxEstimatedCents: 7500,
  spreads: 12,
} as const;
type Reader = Pick<Store, "one" | "all" | "readAsset">;
const digest = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function json(value: string | null): Record<string, unknown> {
  try {
    return object(JSON.parse(value ?? "null"));
  } catch {
    return {};
  }
}
const usageFields = new Set([
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cached_tokens",
  "text_tokens",
  "image_tokens",
  "audio_tokens",
  "reasoning_tokens",
  "input_tokens_details",
  "output_tokens_details",
  "seconds",
  "duration",
]);
function numericUsage(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).flatMap<[string, unknown]>(([key, item]) => {
      if (!usageFields.has(key)) return [];
      if (typeof item === "number" && Number.isFinite(item))
        return [[key, item]];
      const nested = numericUsage(object(item));
      return Object.keys(nested).length ? [[key, nested]] : [];
    }),
  );
}
function asset(reader: Reader, projectId: string, hash: unknown) {
  if (!isHash(hash)) return { hash: null, integrity: "invalid_hash" as const };
  try {
    const bytes = reader.readAsset(projectId, hash);
    return {
      hash,
      integrity:
        digest(bytes) === hash ? ("verified" as const) : ("mismatch" as const),
      bytes: bytes.length,
    };
  } catch {
    return { hash, integrity: "unavailable_or_corrupt" as const };
  }
}
interface Job {
  id: string;
  kind: string;
  status: string;
  stage: string;
  profile: string;
  baseRevision: number;
  allowance: number;
  errorRecorded: number;
  createdAt: string;
}
interface Call {
  id: string;
  stage: string;
  kind: string;
  model: string;
  status: string;
  latencyMs: number | null;
  requestId: string | null;
  usage: string | null;
  estimatedCents: number;
  actualCents: number | null;
  createdAt: string;
}
export interface ReportExpectation {
  sourceHash?: string;
  profileHash?: string;
  observedAt?: string;
}

export async function reportHostedBook(
  reader: Reader,
  projectId: string,
  expected: ReportExpectation = {},
) {
  if (
    [expected.sourceHash, expected.profileHash].some(
      (h) => h !== undefined && !isHash(h),
    )
  )
    throw new Error(
      "Expected source and profile values must be SHA-256 hashes.",
    );
  const project = reader.one<{
    id: string;
    ownerId: string;
    revision: number;
    mode: string;
    status: string;
  }>(
    "SELECT id,ownerId,revision,mode,status FROM projects WHERE id=?",
    projectId,
  );
  if (!project)
    throw new Error("The explicitly selected project was not found.");
  const owner = reader.one<{ name: string }>(
    "SELECT name FROM users WHERE id=?",
    project.ownerId,
  );
  const recording = reader.one<{ assetHash: string; bytes: number }>(
    "SELECT assetHash,bytes FROM recordings WHERE projectId=?",
    projectId,
  );
  const jobs = reader
    .all<Job>(
      "SELECT id,kind,status,stage,profile,baseRevision,allowance,error IS NOT NULL AS errorRecorded,createdAt FROM studio_jobs WHERE projectId=? ORDER BY rowid",
      projectId,
    )
    .map((job) => {
      const calls = reader
        .all<Call>(
          "SELECT id,stage,kind,model,status,latencyMs,requestId,usage,estimatedCents,actualCents,createdAt FROM studio_calls WHERE jobId=? ORDER BY rowid",
          job.id,
        )
        .map(({ usage, ...call }) => ({
          ...call,
          usage: numericUsage(json(usage)),
        }));
      return {
        id: job.id,
        kind: job.kind,
        status: job.status,
        stage: job.stage,
        profileHash: job.profile,
        baseRevision: job.baseRevision,
        allowanceCents: job.allowance,
        errorRecorded: !!job.errorRecorded,
        createdAt: job.createdAt,
        stages: reader.all<{ stage: string; state: string; inputHash: string }>(
          "SELECT stage,state,inputHash FROM studio_steps WHERE jobId=? ORDER BY rowid",
          job.id,
        ),
        calls,
      };
    });
  const calls = jobs.flatMap((job) => job.calls);
  const knownActual = calls.filter((call) => call.actualCents !== null);
  const estimatedCents = calls.reduce(
    (sum, call) => sum + call.estimatedCents,
    0,
  );
  const potentialCents = calls
    .filter((call) => call.status !== "rejected")
    .reduce((sum, call) => sum + call.estimatedCents, 0);
  const actualSubtotalCents = knownActual.reduce(
    (sum, call) => sum + call.actualCents!,
    0,
  );
  const revision = reader.one<{ book: string; contentHash: string }>(
    "SELECT book,contentHash FROM revisions WHERE projectId=? AND revision=?",
    projectId,
    project.revision,
  );
  const book = json(revision?.book ?? null);
  const spreadData = Array.isArray(book.spreads)
    ? book.spreads.map(object)
    : [];
  const images = await Promise.all(
    spreadData.map(async (spread, index) => {
      const info = asset(reader, projectId, spread.artHash);
      let dimensions: { width: number; height: number; format: string } | null =
        null;
      if (info.integrity === "verified" && info.hash) {
        try {
          const metadata = await sharp(
            reader.readAsset(projectId, info.hash),
          ).metadata();
          if (metadata.width && metadata.height && metadata.format)
            dimensions = {
              width: metadata.width,
              height: metadata.height,
              format: metadata.format,
            };
        } catch {
          /* Valid hash is not proof of a decodable illustration. */
        }
      }
      return { spread: index + 1, ...info, dimensions };
    }),
  );
  const editions = await Promise.all(
    reader
      .all<{
        id: string;
        revision: number;
        contentHash: string;
        pdfHash: string;
        createdAt: string;
      }>(
        "SELECT id,revision,contentHash,pdfHash,createdAt FROM editions WHERE projectId=? ORDER BY revision",
        projectId,
      )
      .map(async (edition) => {
        const pdf = asset(reader, projectId, edition.pdfHash);
        let pages: number | null = null;
        if (pdf.integrity === "verified") {
          try {
            pages = (
              await PDFDocument.load(
                reader.readAsset(projectId, edition.pdfHash),
              )
            ).getPageCount();
          } catch {
            /* A valid digest alone does not establish a readable PDF. */
          }
        }
        return { ...edition, pdf: { ...pdf, pages } };
      }),
  );
  const source = recording
    ? asset(reader, projectId, recording.assetHash)
    : null;
  const profileHashes = [...new Set(jobs.map((job) => job.profileHash))];
  const completed = jobs.filter(
    (job) => job.kind === "generation" && job.status === "complete",
  );
  const edition = editions.find((item) => item.revision === project.revision);
  return {
    version: 1,
    testPlan: HOSTED_BOOK_TEST,
    observedAt: expected.observedAt ?? new Date().toISOString(),
    project: {
      id: project.id,
      revision: project.revision,
      mode: project.mode,
      status: project.status,
    },
    operatorNameMatches: owner?.name === HOSTED_BOOK_TEST.operatorName,
    source,
    sourceMatchesExpected: expected.sourceHash
      ? source?.hash === expected.sourceHash && source.integrity === "verified"
      : null,
    profileHashes,
    profilesMatchExpected: expected.profileHash
      ? profileHashes.length > 0 &&
        profileHashes.every((h) => h === expected.profileHash)
      : null,
    jobs,
    costs: {
      currency: "USD",
      attempts: calls.length,
      estimatedAllAttemptsCents: estimatedCents,
      estimatedPotentiallyBilledCents: potentialCents,
      knownActualSubtotalCents: actualSubtotalCents,
      actualCents:
        calls.length > 0 && knownActual.length === calls.length
          ? actualSubtotalCents
          : null,
      attemptsWithoutActualBilling: calls.length - knownActual.length,
      withinEstimatedTestCeiling:
        potentialCents <= HOSTED_BOOK_TEST.maxEstimatedCents,
      note: "Reservations and estimates are not actual billing or a verified upper bound on provider cost. This report does not authorize spending.",
    },
    book: {
      revisionContentHash: revision?.contentHash ?? null,
      sourceHash: isHash(book.sourceHash) ? book.sourceHash : null,
      profileHash: isHash(object(object(book.production).engineProfile).hash)
        ? object(object(book.production).engineProfile).hash
        : null,
      spreadCount: spreadData.length,
      readableImages: images.filter(
        (image) => image.dimensions && image.integrity === "verified",
      ).length,
      uniqueImageHashes: new Set(
        images.map((image) => image.hash).filter(Boolean),
      ).size,
      images,
    },
    editions,
    outputChecks: {
      exactlyOneGeneration:
        jobs.filter((job) => job.kind === "generation").length === 1,
      completedGeneration: completed.length === 1,
      twelveReadableIllustrations:
        images.length === 12 &&
        images.every(
          (image) => image.dimensions && image.integrity === "verified",
        ),
      currentEditionReadable:
        !!edition &&
        edition.pdf.integrity === "verified" &&
        edition.pdf.pages !== null,
      editionMatchesRevisionHash:
        !!edition && edition.contentHash === revision?.contentHash,
      browserJourney: "unverified",
      visualQuality: "unverified",
      childEngagement: "unverified",
    },
  };
}

export function openReadOnlyBookStore(
  directory: string,
): Reader & { close(): void } {
  const dir = resolve(directory);
  const db = new DatabaseSync(join(dir, "evermore.sqlite"), {
    readOnly: true,
    timeout: 5000,
  });
  db.exec("BEGIN"); // A consistent read snapshot, with no migrations or writes.
  const reader = {
    one<T>(sql: string, ...params: SQLInputValue[]) {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, ...params: SQLInputValue[]) {
      return db.prepare(sql).all(...params) as T[];
    },
    readAsset(projectId: string, hash: string) {
      if (
        !isHash(hash) ||
        !reader.one(
          "SELECT hash FROM assets WHERE projectId=? AND hash=?",
          projectId,
          hash,
        )
      )
        throw new Error("Asset unavailable.");
      const bytes = readFileSync(join(dir, "media", hash));
      if (digest(bytes) !== hash) throw new Error("Asset integrity failure.");
      return bytes;
    },
    close() {
      db.close();
    },
  };
  return reader;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  let reader: ReturnType<typeof openReadOnlyBookStore> | undefined;
  try {
    const [command, directory, projectId, sourceHash, profileHash, ...extra] =
      process.argv.slice(2);
    if (command !== "report" || !directory || !projectId || extra.length)
      throw new Error("Usage");
    reader = openReadOnlyBookStore(directory);
    console.log(
      JSON.stringify(
        await reportHostedBook(reader, projectId, { sourceHash, profileHash }),
        null,
        2,
      ),
    );
  } catch {
    // Never echo provider errors, paths, source material, or supplied arguments.
    console.error(
      "Report unavailable. Usage: hosted-book-test.ts report DATA_DIR PROJECT_ID [EXPECTED_SOURCE_SHA256] [EXPECTED_PROFILE_SHA256]. Existing data is unchanged.",
    );
    process.exitCode = 1;
  } finally {
    reader?.close();
  }
}
