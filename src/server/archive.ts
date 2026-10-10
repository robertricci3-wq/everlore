import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import { Book, Transcript } from "../shared/contracts.js";
import { VisualWorld, ReferenceAsset } from "../shared/studio.js";
import { Store, canonical, hash, id, now, type ProjectRow } from "./store.js";
import { fontBytes } from "./layout.js";
import { InterviewArchive, exportInterviewArchive, validateInterviewArchive, importInterviewArchive } from "./almanac/archive.js";
import { ContinuityArchive, exportContinuityArchive, validateContinuityArchive, restoreContinuityArchive, rememberStoryContinuity, rememberContinuityCast } from "./engine/continuity.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const BookRow = z.object({
  revision: z.number().int().positive(),
  book: Book,
  contentHash: digest,
});
const Bundle = z.object({
  format: z.literal("everlore-family-archive"),
  version: z.literal(1),
  project: z.object({
    title: z.string().max(1000),
    mode: z.string(),
    revision: z.number().int().nonnegative(),
    transcript: Transcript.nullable(),
    consentAt: z.string(),
    createdAt: z.string(),
  }),
  recording: z
    .object({
      id: z.string(),
      assetHash: digest,
      mime: z.string(),
      bytes: z.number().int().positive().max(26214400),
      captureMode: z.string(),
      createdAt: z.string(),
    })
    .nullable(),
  revisions: z.array(BookRow).max(200),
  editions: z
    .array(
      BookRow.extend({
        id: z.string(),
        pdfHash: digest,
        createdAt: z.string(),
      }),
    )
    .max(200),
  assets: z
    .array(
      z.object({
        hash: digest,
        kind: z.enum(["audio", "art", "pdf"]),
        base64: z.string().max(70000000),
      }),
    )
    .max(500),
  family: z
    .object({
      world: VisualWorld,
      references: z.array(ReferenceAsset),
      createdAt: z.string(),
    })
    .nullable(),
  checksum: digest,
  interview: InterviewArchive.optional(),
  continuity: ContinuityArchive.optional(),
});
export function exportArchive(store: Store, project: ProjectRow) {
  const revisions = store
    .all<{ revision: number; book: string; contentHash: string }>(
      "SELECT revision,book,contentHash FROM revisions WHERE projectId=? ORDER BY revision",
      project.id,
    )
    .map((r) => ({ ...r, book: Book.parse(JSON.parse(r.book)) }));
  const editions = store
    .all<{
      id: string;
      revision: number;
      book: string;
      contentHash: string;
      pdfHash: string;
      createdAt: string;
    }>(
      "SELECT id,revision,book,contentHash,pdfHash,createdAt FROM editions WHERE projectId=? ORDER BY revision",
      project.id,
    )
    .map((r) => ({ ...r, book: Book.parse(JSON.parse(r.book)) }));
  const recording =
    store.one(
      "SELECT id,assetHash,mime,bytes,captureMode,createdAt FROM recordings WHERE projectId=?",
      project.id,
    ) ?? null;
  const assets = store
    .all<{ hash: string; kind: string }>(
      "SELECT hash,kind FROM assets WHERE projectId=?",
      project.id,
    )
    .filter((a) => ["audio", "art", "pdf"].includes(a.kind))
    .map((a) => ({
      ...a,
      base64: store.readAsset(project.id, a.hash).toString("base64"),
    }));
  const currentBook = revisions.find((r) => r.revision === project.revision)?.book;
  const current = currentBook?.production;
  const family = current
    ? { world: current.world, references: current.references, createdAt: now() }
    : null;
  const payload = {
    format: "everlore-family-archive",
    version: 1,
    project: {
      title: project.title,
      mode: project.mode,
      revision: project.revision,
      transcript: project.transcript ? JSON.parse(project.transcript) : null,
      consentAt: project.consentAt,
      createdAt: project.createdAt,
    },
    recording,
    revisions,
    editions,
    assets,
    family,
    ...(current && currentBook ? { continuity: exportContinuityArchive(store, project.ownerId, project.id, current.familyVersionId, current.world, currentBook.transcript) } : {}),
    ...(exportInterviewArchive(store, project.id) ? { interview: exportInterviewArchive(store, project.id) } : {}),
  };
  const bundle = Bundle.parse({
    ...payload,
    checksum: hash(canonical(payload)),
  });
  const text = JSON.stringify(bundle);
  if (Buffer.byteLength(text) > 256 * 1024 * 1024)
    throw new Error("Archive is too large for this local exporter");
  return gzipSync(text);
}
export function restoreArchive(store: Store, ownerId: string, bytes: Buffer) {
  if (bytes.length > 128 * 1024 * 1024) throw new Error("Archive is too large");
  const bundle = Bundle.parse(
    JSON.parse(
      gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }).toString(
        "utf8",
      ),
    ),
  );
  const { checksum, ...payload } = bundle;
  if (hash(canonical(payload)) !== checksum)
    throw new Error("Archive manifest checksum does not match");
  const assets = new Map<string, { bytes: Buffer; kind: string }>();
  for (const asset of bundle.assets) {
    if (assets.has(asset.hash)) throw new Error("Duplicate archive asset");
    const data = Buffer.from(asset.base64, "base64");
    if (hash(data) !== asset.hash)
      throw new Error("Archive asset checksum does not match");
    assets.set(asset.hash, { bytes: data, kind: asset.kind });
  }
  const requireAsset = (digest: string, kind: string) => {
    if (assets.get(digest)?.kind !== kind)
      throw new Error("Archive has a missing or wrongly typed asset");
  };
  const revisionIds = new Set(bundle.revisions.map((r) => r.revision));
  if (
    revisionIds.size !== bundle.revisions.length ||
    (!revisionIds.has(bundle.project.revision) && bundle.project.revision !== 0)
  )
    throw new Error("Archive revision history is inconsistent");
  for (const row of [...bundle.revisions, ...bundle.editions]) {
    if (
      row.revision !== row.book.revision ||
      row.contentHash !== row.book.contentHash ||
      hash(
        canonical({
          ...row.book,
          contentHash: "",
          fontHash: hash(fontBytes()),
        }),
      ) !== row.contentHash ||
      hash(canonical(row.book.transcript)) !== row.book.sourceHash
    )
      throw new Error("Archive book content checksum does not match");
    row.book.spreads.forEach((s) => requireAsset(s.artHash, "art"));
    row.book.production?.references.forEach((r) => requireAsset(r.hash, "art"));
  }
  if (
    new Set(bundle.editions.map((e) => e.revision)).size !==
    bundle.editions.length
  )
    throw new Error("Duplicate edition");
  for (const e of bundle.editions) {
    requireAsset(e.pdfHash, "pdf");
    if (
      !bundle.revisions.some(
        (r) => r.revision === e.revision && r.contentHash === e.contentHash,
      )
    )
      throw new Error("Edition does not match its revision");
  }
  if (bundle.recording) {
    requireAsset(bundle.recording.assetHash, "audio");
    if (
      assets.get(bundle.recording.assetHash)!.bytes.length !==
      bundle.recording.bytes
    )
      throw new Error("Recording length mismatch");
  }
  bundle.family?.references.forEach((r) => {
    requireAsset(r.hash, "art");
    if (!r.approved) throw new Error("Family references were not approved");
  });
  if (bundle.continuity) validateContinuityArchive(bundle.continuity, bundle.family?.world, bundle.revisions.find((r) => r.revision === bundle.project.revision)?.book.transcript);
  if (bundle.interview) validateInterviewArchive(bundle.interview, (digest, bytes) => {
    requireAsset(digest, "audio");
    if (assets.get(digest)!.bytes.length !== bytes) throw new Error("Interview recording length mismatch");
  });
  const projectId = id();
  store.transaction(() => {
    if (
      !store.one("SELECT id FROM users WHERE id=? AND kind='private'", ownerId)
    )
      throw new Error("A private shelf is required");
    const p = bundle.project;
    store.run(
      "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
      projectId,
      ownerId,
      p.title,
      p.mode,
      p.revision
        ? "ready_for_review"
        : p.transcript
          ? "awaiting_editorial"
          : "awaiting_transcription",
      p.revision,
      p.transcript ? JSON.stringify(p.transcript) : null,
      p.consentAt,
      p.createdAt,
    );
    for (const [, asset] of assets)
      store.putAsset(projectId, asset.bytes, asset.kind);
    if (bundle.interview) importInterviewArchive(store, ownerId, projectId, bundle.interview);
    if (bundle.recording) {
      const r = bundle.recording;
      store.run(
        "INSERT INTO recordings VALUES(?,?,?,?,?,?,?)",
        id(),
        projectId,
        r.assetHash,
        r.mime,
        r.bytes,
        r.captureMode,
        r.createdAt,
      );
    }
    for (const r of bundle.revisions)
      store.run(
        "INSERT INTO revisions VALUES(?,?,?,?)",
        projectId,
        r.revision,
        JSON.stringify(r.book),
        r.contentHash,
      );
    for (const e of bundle.editions)
      store.run(
        "INSERT INTO editions VALUES(?,?,?,?,?,?,?)",
        id(),
        projectId,
        e.revision,
        e.contentHash,
        e.pdfHash,
        JSON.stringify(e.book),
        e.createdAt,
      );
    if (bundle.family) {
      const f = bundle.family,
        familyId = id();
      store.run(
        "INSERT INTO family_versions VALUES(?,?,?,?,?,?)",
        familyId,
        ownerId,
        f.world.name,
        JSON.stringify(f.world),
        JSON.stringify(f.references),
        f.createdAt,
      );
      for (const r of f.references)
        store.run("INSERT INTO family_assets VALUES(?,?)", familyId, r.hash);
      if (bundle.continuity) {
        restoreContinuityArchive(store, ownerId, familyId, bundle.continuity);
        rememberStoryContinuity(store, projectId, bundle.project.revision, familyId, f.world);
      } else {
        const source = bundle.revisions.find((r) => r.revision === bundle.project.revision)?.book.transcript;
        if (source) {
          rememberContinuityCast(store, ownerId, familyId, f.world, source);
          rememberStoryContinuity(store, projectId, bundle.project.revision, familyId, f.world);
        }
      }
    }
  });
  // Restoring never creates jobs or re-enables spending. Original snapshot IDs remain provenance.
  return {
    id: projectId,
    revision: bundle.project.revision,
    editions: bundle.editions.length,
    verifiedAssets: assets.size,
  };
}
