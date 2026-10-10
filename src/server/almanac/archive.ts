import { z } from "zod";
import {
  InterviewSession,
  InterviewTurn,
  ALMANAC_PAGES,
} from "../../shared/almanac.js";
import { MemoryInvitation } from "../../shared/invitations.js";
import { Transcript } from "../../shared/contracts.js";
import { canonical, hash, id, now, type Store } from "../store.js";
import {
  ensureAlmanac,
  ownedPage,
  readSession,
  type SessionRow,
} from "./service.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const SourceBody = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  invitation: MemoryInvitation,
  turns: z
    .array(
      InterviewTurn.pick({
        id: true,
        sequence: true,
        promptId: true,
        promptText: true,
        promptVersion: true,
        audio: true,
        transcript: true,
      }),
    )
    .min(1)
    .max(100),
});
const ArchivedSource = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  sourceHash: digest,
  body: SourceBody,
  createdAt: z.string(),
});
const Provenance = z.object({
  originalSessionId: z.string(),
  sources: z.array(ArchivedSource).max(200),
  importedAt: z.string(),
});
const ArchiveSession = z
  .object({
    ...InterviewSession.shape,
    purpose: z.enum(["memory", "page_title"]).optional(),
  })
  .superRefine((value, ctx) => {
    const result = InterviewSession.safeParse(value);
    if (!result.success)
      for (const issue of result.error.issues)
        ctx.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
  });
export const InterviewArchive = z.object({
  version: z.literal(1),
  kind: z.enum(["session", "frozen_source"]),
  // Do not insert defaults while parsing an older checksum-bearing archive.
  session: ArchiveSession,
  invitation: MemoryInvitation,
  page: z.object({
    title: z.string().min(1).max(100),
    description: z.string().max(500),
    chapterId: z.string().nullable(),
  }),
  transcriptHistory: z
    .array(
      z.object({
        turnId: z.string(),
        revision: z.number().int().positive(),
        contentHash: digest,
        body: Transcript.extend({ mode: z.enum(["manual", "live"]) }),
        createdAt: z.string(),
      }),
    )
    .max(1000),
  sources: z.array(ArchivedSource).max(200),
  provenance: z.array(Provenance).max(100),
});
type Archive = z.infer<typeof InterviewArchive>;

/** A book exports exactly its frozen source, never later or unselected answers. */
export function exportInterviewArchive(
  s: Store,
  projectId: string,
): Archive | undefined {
  const frozen = s.one<{
    id: string;
    sessionId: string;
    revision: number;
    sourceHash: string;
    body: string;
    createdAt: string;
  }>("SELECT * FROM almanac_sources WHERE generationProjectId=?", projectId);
  const row = frozen
    ? s.one<SessionRow>(
        "SELECT * FROM almanac_sessions WHERE id=?",
        frozen.sessionId,
      )
    : s.one<SessionRow>(
        "SELECT * FROM almanac_sessions WHERE projectId=?",
        projectId,
      );
  if (!row) return undefined;
  const session = readSession(s, row),
    page = ownedPage(s, row.ownerId, row.pageId);
  const sourceRows = frozen
    ? [frozen]
    : s.all<typeof frozen & object>(
        "SELECT * FROM almanac_sources WHERE sessionId=? ORDER BY revision",
        row.id,
      );
  const sources = sourceRows.map((source) => ({
    id: source.id,
    revision: source.revision,
    sourceHash: source.sourceHash,
    body: SourceBody.parse(JSON.parse(source.body)),
    createdAt: source.createdAt,
  }));
  if (frozen) {
    session.status = "finished";
    session.turns = sources[0].body.turns.map((turn) => ({
      ...turn,
      version: 1,
      sessionId: row.id,
      status: "complete",
      createdAt: frozen.createdAt,
    }));
  }
  const selected = new Map(
    session.turns.map((turn) => [
      turn.id,
      turn.transcript ? hash(canonical(turn.transcript)) : null,
    ]),
  );
  const transcriptHistory = s
    .all<{
      turnId: string;
      revision: number;
      contentHash: string;
      body: string;
      createdAt: string;
    }>(
      "SELECT v.* FROM almanac_transcript_versions v JOIN almanac_turns t ON t.id=v.turnId WHERE t.sessionId=? ORDER BY t.sequence,v.revision",
      row.id,
    )
    .filter((v) => !frozen || selected.get(v.turnId) === v.contentHash)
    .map((v) => ({
      turnId: v.turnId,
      revision: v.revision,
      contentHash: v.contentHash,
      body: JSON.parse(v.body),
      createdAt: v.createdAt,
    }));
  const storedProvenance = s.one<{ body: string }>(
    "SELECT body FROM almanac_archive_provenance WHERE sessionId=?",
    row.id,
  );
  let provenance = storedProvenance
    ? z.array(Provenance).parse(JSON.parse(storedProvenance.body))
    : [];
  if (frozen)
    provenance = provenance
      .map((previous) => ({
        ...previous,
        sources: previous.sources.filter((source) =>
          source.body.turns.every((old) =>
            session.turns.some(
              (current) =>
                canonical(current.audio) === canonical(old.audio) &&
                canonical(current.transcript) === canonical(old.transcript),
            ),
          ),
        ),
      }))
      .filter((previous) => previous.sources.length > 0);
  return InterviewArchive.parse({
    version: 1,
    kind: frozen ? "frozen_source" : "session",
    session,
    invitation: JSON.parse(row.invitation),
    page: {
      title: page.title,
      description: page.description,
      chapterId: page.chapterId,
    },
    transcriptHistory,
    sources,
    provenance,
  });
}

/** Call before restore writes; every referenced recording must be in the archive. */
export function validateInterviewArchive(
  input: unknown,
  requireAudio: (digest: string, bytes: number) => void,
): Archive {
  const archive = InterviewArchive.parse(input);
  if (
    archive.session.purpose === "page_title" &&
    (archive.kind === "frozen_source" || archive.sources.length)
  )
    throw new Error(
      "A page-name recording cannot be restored as a story source",
    );
  const turns = new Map(archive.session.turns.map((turn) => [turn.id, turn]));
  for (const turn of archive.session.turns)
    if (turn.audio) requireAudio(turn.audio.sha256, turn.audio.bytes);
  for (const version of archive.transcriptHistory) {
    if (
      !turns.has(version.turnId) ||
      hash(canonical(version.body)) !== version.contentHash
    )
      throw new Error(
        "Interview transcript history failed its integrity check",
      );
  }
  for (const source of archive.sources) {
    if (
      hash(canonical(source.body)) !== source.sourceHash ||
      source.body.sessionId !== archive.session.id
    )
      throw new Error("Interview source snapshot failed its integrity check");
    for (const turn of source.body.turns) {
      if (!turn.transcript || !turns.has(turn.id))
        throw new Error("Interview snapshot references a missing answer");
      if (canonical(turn.audio) !== canonical(turns.get(turn.id)!.audio))
        throw new Error("Interview snapshot changes a recorded answer");
      const transcriptHash = hash(canonical(turn.transcript));
      if (
        hash(canonical(turns.get(turn.id)!.transcript)) !== transcriptHash &&
        !archive.transcriptHistory.some(
          (v) => v.turnId === turn.id && v.contentHash === transcriptHash,
        )
      )
        throw new Error(
          "Interview snapshot transcript has no retained source version",
        );
      if (turn.audio) requireAudio(turn.audio.sha256, turn.audio.bytes);
    }
  }
  if (archive.kind === "frozen_source" && archive.sources.length !== 1)
    throw new Error("A book archive must identify one frozen source");
  for (const previous of archive.provenance)
    for (const source of previous.sources)
      if (
        hash(canonical(source.body)) !== source.sourceHash ||
        source.body.sessionId !== previous.originalSessionId
      )
        throw new Error(
          "Earlier interview provenance failed its integrity check",
        );
  return archive;
}

/** Called inside the enclosing archive transaction, after media is restored.
 * Never restores jobs, spending, or permission to process recordings with AI.
 */
export function importInterviewArchive(
  s: Store,
  ownerId: string,
  projectId: string,
  input: unknown,
) {
  const archive = validateInterviewArchive(input, (digest, bytes) => {
    if (
      !s.one(
        "SELECT hash FROM assets WHERE projectId=? AND hash=? AND kind='audio'",
        projectId,
        digest,
      ) ||
      s.readAsset(projectId, digest).length !== bytes
    )
      throw new Error("Interview recording is missing or has changed");
  });
  if (
    !s.one(
      "SELECT id FROM projects WHERE id=? AND ownerId=?",
      projectId,
      ownerId,
    )
  )
    throw new Error("Restored interview requires its private project");
  ensureAlmanac(s, ownerId);
  const sessionId = id(),
    at = now(),
    sourceProjectId = archive.kind === "session" ? projectId : id();
  let pageId = archive.session.pageId;
  if (!ALMANAC_PAGES.some((page) => page.id === pageId)) {
    pageId = id();
    s.run(
      "INSERT INTO almanac_pages VALUES(?,?,?,?,?,?,0,1,'[]',?,?)",
      ownerId,
      pageId,
      archive.page.title,
      archive.page.description,
      archive.page.chapterId,
      s.one<{ n: number }>(
        "SELECT COALESCE(MAX(position),-1)+1 AS n FROM almanac_pages WHERE ownerId=?",
        ownerId,
      )!.n,
      at,
      at,
    );
  }
  if (archive.kind === "frozen_source") {
    s.run(
      "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
      sourceProjectId,
      ownerId,
      archive.page.title,
      "unavailable",
      "interview",
      0,
      null,
      at,
      at,
    );
    const audioHashes = new Set(
      archive.session.turns.flatMap((turn) =>
        turn.audio ? [turn.audio.sha256] : [],
      ),
    );
    for (const audioHash of audioHashes)
      s.putAsset(sourceProjectId, s.readAsset(projectId, audioHash), "audio");
  } else s.run("UPDATE projects SET status='interview' WHERE id=?", projectId);
  s.run(
    "INSERT INTO almanac_sessions VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)",
    sessionId,
    ownerId,
    sourceProjectId,
    pageId,
    archive.invitation.id,
    archive.invitation.revision,
    canonical(archive.invitation),
    archive.session.status,
    `restore-${sessionId}`,
    at,
    archive.session.createdAt,
    at,
    archive.session.purpose ?? "memory",
  );
  const turnIds = new Map(archive.session.turns.map((turn) => [turn.id, id()]));
  for (const old of archive.session.turns) {
    const turn = {
      ...old,
      id: turnIds.get(old.id)!,
      sessionId,
      status: old.transcript
        ? ("complete" as const)
        : old.status === "skipped"
          ? ("skipped" as const)
          : old.audio
            ? ("audio_saved" as const)
            : ("awaiting_audio" as const),
    };
    s.run(
      "INSERT INTO almanac_turns VALUES(?,?,?,?,?,?)",
      turn.id,
      sessionId,
      turn.sequence,
      `restore-${turn.id}`,
      hash(canonical({ restoredFrom: old.id })),
      canonical(turn),
    );
  }
  for (const old of archive.transcriptHistory)
    s.run(
      "INSERT OR IGNORE INTO almanac_transcript_versions VALUES(?,?,?,?,?,?)",
      id(),
      turnIds.get(old.turnId)!,
      old.revision,
      old.contentHash,
      canonical(old.body),
      old.createdAt,
    );
  s.run(
    "INSERT INTO almanac_archive_provenance VALUES(?,?)",
    sessionId,
    canonical([
      ...archive.provenance,
      {
        originalSessionId: archive.session.id,
        sources: archive.sources,
        importedAt: at,
      },
    ]),
  );
  if (archive.kind === "frozen_source") {
    const original = archive.sources[0];
    const body = {
      ...original.body,
      sessionId,
      turns: original.body.turns.map((turn) => ({
        ...turn,
        id: turnIds.get(turn.id)!,
      })),
    };
    s.run(
      "INSERT INTO almanac_sources VALUES(?,?,?,?,?,?,?)",
      id(),
      sessionId,
      1,
      hash(canonical(body)),
      projectId,
      canonical(body),
      original.createdAt,
    );
    s.run(
      "INSERT INTO almanac_memories VALUES(?,?,?,?)",
      ownerId,
      pageId,
      projectId,
      at,
    );
  }
  return { sessionId, sourceProjectId };
}
