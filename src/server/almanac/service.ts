import { z } from "zod";
import { Book, Transcript } from "../../shared/contracts.js";
import {
  InterviewTurn,
  InterviewSession,
  type InterviewTurnRecord,
  type InterviewSessionRecord,
  ALMANAC_PAGES,
  buildMemoryBrief,
  nextMemoryPrompt,
  type GuideDecisionRecord,
  MEMORY_GUIDE_VERSION,
} from "../../shared/almanac.js";
import {
  MEMORY_INVITATIONS,
  type MemoryInvitationRecord,
} from "../../shared/invitations.js";
import { AccessError } from "../access.js";
import { canonical, hash, id, now, type Store } from "../store.js";

export interface PageRow {
  ownerId: string;
  id: string;
  title: string;
  description: string;
  chapterId: string | null;
  position: number;
  hidden: number;
  custom: number;
  invitationIds: string;
  createdAt: string;
  updatedAt: string;
}
export interface SessionRow {
  id: string;
  ownerId: string;
  projectId: string;
  pageId: string;
  invitationId: string;
  invitationVersion: string;
  invitation: string;
  status: "open" | "finished";
  consentAt: string;
  aiConsentAt: string | null;
  requestKey: string;
  createdAt: string;
  updatedAt: string;
  purpose: "memory" | "page_title";
}
const keySchema = z.string().trim().min(1).max(100);
function privateOwner(s: Store, ownerId: string) {
  if (!s.one("SELECT id FROM users WHERE id=? AND kind='private'", ownerId))
    throw new AccessError(403, "Open your private shelf first.");
}
export function ensureAlmanac(s: Store, ownerId: string) {
  privateOwner(s, ownerId);
  ALMANAC_PAGES.forEach((page, position) => {
    s.run(
      "INSERT OR IGNORE INTO almanac_pages VALUES(?,?,?,?,?,?,0,0,?,?,?)",
      ownerId,
      page.id,
      page.title,
      page.description,
      page.chapterId,
      position,
      JSON.stringify(page.invitationIds),
      now(),
      now(),
    );
  });
}
export function ownedPage(s: Store, ownerId: string, pageId: string) {
  ensureAlmanac(s, ownerId);
  const page = s.one<PageRow>(
    "SELECT * FROM almanac_pages WHERE ownerId=? AND id=?",
    ownerId,
    pageId,
  );
  if (!page)
    throw new AccessError(404, "That Almanac page is not on your shelf.");
  return page;
}
export function ownedSession(s: Store, ownerId: string, sessionId: string) {
  const row = s.one<SessionRow>(
    "SELECT * FROM almanac_sessions WHERE id=? AND ownerId=?",
    sessionId,
    ownerId,
  );
  if (!row) throw new AccessError(404, "That memory is not on your shelf.");
  return row;
}
export function readTurn(s: Store, sessionId: string, turnId: string) {
  const row = s.one<{ body: string }>(
    "SELECT body FROM almanac_turns WHERE id=? AND sessionId=?",
    turnId,
    sessionId,
  );
  if (!row) throw new AccessError(404, "That recording is not in this memory.");
  return InterviewTurn.parse(JSON.parse(row.body));
}
export function writeTurn(s: Store, turn: InterviewTurnRecord) {
  s.run(
    "UPDATE almanac_turns SET body=? WHERE id=? AND sessionId=?",
    canonical(InterviewTurn.parse(turn)),
    turn.id,
    turn.sessionId,
  );
  s.run(
    "UPDATE almanac_sessions SET updatedAt=? WHERE id=?",
    now(),
    turn.sessionId,
  );
}
export function readSession(s: Store, row: SessionRow): InterviewSessionRecord {
  return InterviewSession.parse({
    version: 1,
    purpose: row.purpose ?? "memory",
    id: row.id,
    projectId: row.projectId,
    pageId: row.pageId,
    invitationId: row.invitationId,
    invitationVersion: row.invitationVersion,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    turns: s
      .all<{ body: string }>(
        "SELECT body FROM almanac_turns WHERE sessionId=? ORDER BY sequence",
        row.id,
      )
      .map((t) => InterviewTurn.parse(JSON.parse(t.body))),
  });
}
function openSession(row: SessionRow) {
  if (row.status !== "open")
    throw new AccessError(409, "Reopen this memory before adding more.");
}
function bookSummaries(s: Store, ownerId: string) {
  return s
    .all<{
      projectId: string;
      title: string;
      status: string;
      revision: number;
      book: string | null;
    }>(
      `SELECT p.id AS projectId,p.title,p.status,p.revision,r.book FROM projects p
     LEFT JOIN revisions r ON r.projectId=p.id AND r.revision=p.revision
     WHERE p.ownerId=? AND NOT EXISTS(SELECT 1 FROM almanac_sessions a WHERE a.projectId=p.id)
     AND NOT EXISTS(SELECT 1 FROM lab_runs l WHERE l.projectId=p.id) ORDER BY p.createdAt DESC`,
      ownerId,
    )
    .map(({ book: raw, ...p }) => {
      const parsed = raw ? Book.safeParse(JSON.parse(raw)) : null;
      const art = parsed?.success ? parsed.data.spreads[0]?.artHash : undefined;
      return {
        ...p,
        coverUrl: art ? `/api/projects/${p.projectId}/art/${art}` : null,
        pageIds: s
          .all<{ pageId: string }>(
            "SELECT pageId FROM almanac_memories WHERE ownerId=? AND projectId=?",
            ownerId,
            p.projectId,
          )
          .map((x) => x.pageId),
        sourceSessionId:
          s.one<{ sessionId: string }>(
            "SELECT sessionId FROM almanac_sources WHERE generationProjectId=?",
            p.projectId,
          )?.sessionId ?? null,
      };
    });
}
export function almanacView(s: Store, ownerId: string) {
  ensureAlmanac(s, ownerId);
  const books = bookSummaries(s, ownerId);
  const summary = (row: SessionRow) => ({
    id: row.id,
    projectId: row.projectId,
    pageId: row.pageId,
    invitationId: row.invitationId,
    purpose: row.purpose,
    status: row.status,
    updatedAt: row.updatedAt,
    turnCount: s.one<{ total: number }>(
      "SELECT COUNT(*) AS total FROM almanac_turns WHERE sessionId=?",
      row.id,
    )!.total,
  });
  const drafts = s
    .all<SessionRow>(
      "SELECT * FROM almanac_sessions WHERE ownerId=? AND purpose='memory' ORDER BY updatedAt DESC",
      ownerId,
    )
    .map(summary);
  const titleDrafts = s
    .all<SessionRow>(
      "SELECT * FROM almanac_sessions WHERE ownerId=? AND purpose='page_title' AND status='open' ORDER BY updatedAt DESC",
      ownerId,
    )
    .map(summary);
  const pages = s
    .all<PageRow>(
      "SELECT * FROM almanac_pages WHERE ownerId=? ORDER BY position,id",
      ownerId,
    )
    .map((p) => {
      const pageBooks = books.filter((b) => b.pageIds.includes(p.id));
      const cover = pageBooks.find((b) => b.coverUrl);
      return {
        id: p.id,
        title: p.title,
        description: p.description,
        chapterId: p.chapterId,
        position: p.position,
        hidden: !!p.hidden,
        custom: !!p.custom,
        invitationIds: JSON.parse(p.invitationIds) as string[],
        memoryCount: drafts.filter((d) => d.pageId === p.id).length,
        bookCount: pageBooks.filter((b) => b.revision > 0).length,
        coverProjectId: cover?.projectId ?? null,
        coverUrl: cover?.coverUrl ?? null,
      };
    });
  return { version: 1 as const, pages, books, drafts, titleDrafts };
}
export function pageView(s: Store, ownerId: string, pageId: string) {
  const view = almanacView(s, ownerId),
    page = view.pages.find((p) => p.id === pageId);
  if (!page)
    throw new AccessError(404, "That Almanac page is not on your shelf.");
  return {
    page,
    sessions: view.drafts.filter((d) => d.pageId === pageId),
    titleSessions: view.titleDrafts.filter((d) => d.pageId === pageId),
    books: view.books.filter((b) => b.pageIds.includes(pageId)),
    invitations: page.custom
      ? [customInvitation(ownedPage(s, ownerId, pageId))]
      : MEMORY_INVITATIONS.filter((i) => page.invitationIds.includes(i.id)),
  };
}
export function addPage(s: Store, ownerId: string, input: unknown) {
  ensureAlmanac(s, ownerId);
  const b = z
    .object({
      title: z.string().trim().min(1).max(100),
      description: z.string().trim().max(500).default(""),
    })
    .parse(input);
  const pageId = id();
  s.run(
    "INSERT INTO almanac_pages VALUES(?,?,?,?,NULL,?,0,1,?,?,?)",
    ownerId,
    pageId,
    b.title,
    b.description,
    s.one<{ n: number }>(
      "SELECT COALESCE(MAX(position),-1)+1 AS n FROM almanac_pages WHERE ownerId=?",
      ownerId,
    )!.n,
    "[]",
    now(),
    now(),
  );
  return pageView(s, ownerId, pageId);
}
export function editPage(
  s: Store,
  ownerId: string,
  pageId: string,
  input: unknown,
) {
  const p = ownedPage(s, ownerId, pageId);
  const b = z
    .object({
      title: z.string().trim().min(1).max(100).optional(),
      description: z.string().trim().max(500).optional(),
      hidden: z.boolean().optional(),
      position: z.number().int().min(0).max(10000).optional(),
    })
    .parse(input);
  s.transaction(() => {
    if (b.position !== undefined) {
      const ids = s
        .all<{ id: string }>(
          "SELECT id FROM almanac_pages WHERE ownerId=? AND id!=? ORDER BY position,id",
          ownerId,
          pageId,
        )
        .map((x) => x.id);
      ids.splice(Math.min(ids.length, b.position), 0, pageId);
      ids.forEach((item, n) =>
        s.run(
          "UPDATE almanac_pages SET position=? WHERE ownerId=? AND id=?",
          n,
          ownerId,
          item,
        ),
      );
    }
    s.run(
      "UPDATE almanac_pages SET title=?,description=?,hidden=?,updatedAt=? WHERE ownerId=? AND id=?",
      b.title ?? p.title,
      b.description ?? p.description,
      b.hidden === undefined ? p.hidden : Number(b.hidden),
      now(),
      ownerId,
      pageId,
    );
  });
  return pageView(s, ownerId, pageId);
}
export function associateMemory(
  s: Store,
  ownerId: string,
  pageId: string,
  projectId: string,
  remove = false,
) {
  ownedPage(s, ownerId, pageId);
  if (
    !s.one(
      "SELECT id FROM projects WHERE id=? AND ownerId=?",
      projectId,
      ownerId,
    )
  )
    throw new AccessError(404, "That book is not on your shelf.");
  if (remove)
    s.run(
      "DELETE FROM almanac_memories WHERE ownerId=? AND pageId=? AND projectId=?",
      ownerId,
      pageId,
      projectId,
    );
  else
    s.run(
      "INSERT OR IGNORE INTO almanac_memories VALUES(?,?,?,?)",
      ownerId,
      pageId,
      projectId,
      now(),
    );
}
function customInvitation(page: PageRow): MemoryInvitationRecord {
  // Reuse a versioned, gentle invitation for user-created topics, retaining its provenance.
  const customId = `custom-${page.id}`;
  return {
    ...MEMORY_INVITATIONS[0],
    id: customId,
    title: page.title,
    opening: `What comes to mind when you think about ${page.title}? Start wherever you like.`,
    followUps: [
      {
        id: `${customId}:relationship`,
        text: "You mentioned being unsure about a relationship. Would you like to clarify it, or leave it uncertain?",
        when: "explicit_relationship_ambiguity",
      },
      {
        id: `${customId}:occasion`,
        text: "Does one occasion come to mind? It is also fine to keep this as a usual routine.",
        when: "ritual_without_event",
      },
      {
        id: `${customId}:detail`,
        text: "Is there a small detail about that memory you would like to keep?",
        when: "missing_detail",
      },
      {
        id: `${customId}:meaning`,
        text: "What, if anything, would you like someone to understand about this memory?",
        when: "missing_meaning",
      },
    ],
    alternativeEntries: [
      "You can begin with a person, object, place or ordinary moment.",
      "A fragment is enough. You may leave details uncertain.",
    ],
    creativeOpportunities: [
      "Let the narrator's specific objects, words and actions shape any later imaginative adaptation.",
    ],
  };
}
const TITLE_PROMPT =
  "What would you like to call this page? A few words are enough.";
const TITLE_VERSION = "page-title-v1";
function titleInvitation(page: PageRow): MemoryInvitationRecord {
  return {
    ...customInvitation(page),
    id: `page-title-${page.id}`,
    title: "Name this page",
    opening: TITLE_PROMPT,
    followUps: [
      {
        id: `page-title-${page.id}:edit`,
        text: "You can edit the name before saving it.",
        when: "missing_detail",
      },
    ],
    creativeOpportunities: [
      "Keep the spoken name literal; any changes come from the user's explicit edit.",
    ],
  };
}
function sessionPrompt(
  row: SessionRow,
  session: InterviewSessionRecord,
): GuideDecisionRecord {
  if (row.purpose !== "page_title")
    return nextMemoryPrompt(
      JSON.parse(row.invitation),
      buildMemoryBrief(session),
      session.turns,
    );
  const pending = session.turns.some(
    (turn) => !["complete", "skipped"].includes(turn.status),
  );
  const action =
    session.status === "finished" || (session.turns.length > 0 && !pending)
      ? "finish"
      : pending
        ? "wait"
        : "ask";
  return {
    version: 1,
    guideVersion: MEMORY_GUIDE_VERSION,
    method: "rule_based",
    modelValidated: false,
    action,
    evidence: [],
    reason:
      action === "ask"
        ? "Record a page name; this recording will not be used as a story."
        : action === "wait"
          ? "Your page-name recording is saved; finish its transcript before applying the name."
          : "Review and edit the name before applying it.",
    ...(action === "ask"
      ? {
          promptId: `${row.invitationId}:opening`,
          promptText: TITLE_PROMPT,
          promptVersion: TITLE_VERSION,
        }
      : {}),
  };
}
export function startTitleSession(
  s: Store,
  ownerId: string,
  pageId: string,
  input: unknown,
) {
  const body = z
    .object({
      consent: z.literal(true),
      processWithOpenAI: z.literal(true),
      key: keySchema,
    })
    .parse(input);
  return startSession(s, ownerId, pageId, body, "page_title");
}
export function applyPageTitle(
  s: Store,
  ownerId: string,
  sessionId: string,
  input: unknown,
) {
  const body = z
    .object({ title: z.string().trim().min(1).max(100) })
    .parse(input);
  return s.transaction(() => {
    const row = ownedSession(s, ownerId, sessionId);
    if (row.purpose !== "page_title")
      throw new AccessError(
        409,
        "Choose the spoken page-name action before applying a title. Memory recordings are not reused as page names.",
      );
    const previous = s.one<{ title: string }>(
      "SELECT title FROM almanac_title_applications WHERE sessionId=?",
      sessionId,
    );
    if (previous && previous.title !== body.title)
      throw new AccessError(
        409,
        "This recorded name has already been applied. Start a new naming recording or edit the page directly.",
      );
    if (!previous) {
      const session = readSession(s, row);
      if (
        !session.turns.some(
          (turn) =>
            turn.status === "complete" && !!turn.transcript?.rawText.trim(),
        )
      )
        throw new AccessError(
          409,
          "Finish the page-name answer before applying the name.",
        );
      const page = ownedPage(s, ownerId, row.pageId),
        at = now();
      s.run(
        "INSERT INTO almanac_title_applications VALUES(?,?,?,?)",
        sessionId,
        body.title,
        page.title,
        at,
      );
      s.run(
        "UPDATE almanac_pages SET title=?,updatedAt=? WHERE ownerId=? AND id=?",
        body.title,
        at,
        ownerId,
        row.pageId,
      );
      s.run(
        "UPDATE almanac_sessions SET status='finished',updatedAt=? WHERE id=?",
        at,
        sessionId,
      );
    }
    return {
      sessionId,
      pageId: row.pageId,
      title: body.title,
      applied: true as const,
      page: pageView(s, ownerId, row.pageId),
    };
  });
}
export function startSession(
  s: Store,
  ownerId: string,
  pageId: string,
  input: unknown,
  purpose: "memory" | "page_title" = "memory",
) {
  const page = ownedPage(s, ownerId, pageId);
  const b = z
    .object({
      consent: z.literal(true),
      processWithOpenAI: z.boolean().default(false),
      key: keySchema.optional(),
      invitationId: z.string().optional(),
    })
    .parse(input);
  const invitationIds = JSON.parse(page.invitationIds) as string[];
  const invitation =
    purpose === "page_title"
      ? titleInvitation(page)
      : page.custom
        ? customInvitation(page)
        : MEMORY_INVITATIONS.find(
            (i) => i.id === (b.invitationId ?? invitationIds[0]),
          );
  if (
    !invitation ||
    (purpose === "memory" &&
      !page.custom &&
      !invitationIds.includes(invitation.id))
  )
    throw new AccessError(400, "Choose an invitation from this page.");
  const sessionId = s.transaction(() => {
    let prior = b.key
      ? (s.one<SessionRow>(
          "SELECT * FROM almanac_sessions WHERE ownerId=? AND requestKey=?",
          ownerId,
          b.key,
        ) ??
        s.one<SessionRow>(
          "SELECT s.* FROM almanac_sessions s JOIN almanac_session_keys k ON k.sessionId=s.id WHERE k.ownerId=? AND k.requestKey=?",
          ownerId,
          b.key,
        ))
      : undefined;
    if (!prior && (!b.key || purpose === "page_title"))
      prior = s.one<SessionRow>(
        "SELECT * FROM almanac_sessions WHERE ownerId=? AND pageId=? AND invitationId=? AND purpose=? AND status='open' ORDER BY createdAt DESC LIMIT 1",
        ownerId,
        pageId,
        invitation.id,
        purpose,
      );
    if (prior) {
      if (
        prior.pageId !== pageId ||
        prior.invitationId !== invitation.id ||
        prior.purpose !== purpose
      )
        throw new AccessError(409, "That save key belongs to another memory.");
      if (b.processWithOpenAI && !prior.aiConsentAt)
        s.run(
          "UPDATE almanac_sessions SET aiConsentAt=? WHERE id=?",
          now(),
          prior.id,
        );
      if (b.key && b.key !== prior.requestKey)
        s.run(
          "INSERT OR IGNORE INTO almanac_session_keys VALUES(?,?,?)",
          ownerId,
          b.key,
          prior.id,
        );
      return prior.id;
    }
    const sid = id(),
      pid = id(),
      at = now();
    s.run(
      "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
      pid,
      ownerId,
      page.title,
      "unavailable",
      "interview",
      0,
      null,
      at,
      at,
    );
    s.run(
      "INSERT INTO almanac_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      sid,
      ownerId,
      pid,
      pageId,
      invitation.id,
      invitation.revision,
      canonical(invitation),
      "open",
      b.key ?? sid,
      at,
      b.processWithOpenAI ? at : null,
      at,
      at,
      purpose,
    );
    return sid;
  });
  return sessionView(s, ownerId, sessionId);
}
export function sessionView(s: Store, ownerId: string, sessionId: string) {
  const row = ownedSession(s, ownerId, sessionId),
    session = readSession(s, row),
    brief = buildMemoryBrief(session);
  return {
    session,
    brief,
    aiProcessingConsented: !!row.aiConsentAt,
    nextPrompt: sessionPrompt(row, session),
    titleApplication:
      s.one<{ title: string; appliedAt: string }>(
        "SELECT title,appliedAt FROM almanac_title_applications WHERE sessionId=?",
        sessionId,
      ) ?? null,
    sourceRevisions: s.all<{
      id: string;
      revision: number;
      sourceHash: string;
      projectId: string;
      createdAt: string;
    }>(
      "SELECT id,revision,sourceHash,generationProjectId AS projectId,createdAt FROM almanac_sources WHERE sessionId=? ORDER BY revision",
      sessionId,
    ),
    transcriptionJobs: s
      .all<{
        jobId: string;
        turnId: string;
        status: string;
      }>(
        "SELECT t.jobId,t.turnId,j.status FROM almanac_transcriptions t JOIN studio_jobs j ON j.id=t.jobId WHERE t.sessionId=?",
        sessionId,
      )
      .map((job) => ({
        ...job,
        error:
          job.status === "needs_attention"
            ? "Your recording is saved. Transcription needs attention. You can add the words yourself or return later."
            : null,
      })),
    transcriptHistory: s.all<{
      id: string;
      turnId: string;
      revision: number;
      contentHash: string;
      createdAt: string;
    }>(
      "SELECT v.id,v.turnId,v.revision,v.contentHash,v.createdAt FROM almanac_transcript_versions v JOIN almanac_turns t ON t.id=v.turnId WHERE t.sessionId=? ORDER BY t.sequence,v.revision",
      sessionId,
    ),
  };
}
export function setSessionStatus(
  s: Store,
  ownerId: string,
  sessionId: string,
  status: "open" | "finished",
) {
  ownedSession(s, ownerId, sessionId);
  s.run(
    "UPDATE almanac_sessions SET status=?,updatedAt=? WHERE id=?",
    status,
    now(),
    sessionId,
  );
  return sessionView(s, ownerId, sessionId);
}
export function startTurn(
  s: Store,
  ownerId: string,
  sessionId: string,
  input: unknown,
) {
  const b = z
    .object({ key: keySchema, promptId: z.string().min(1).max(200) })
    .parse(input);
  return s.transaction(() => {
    const row = ownedSession(s, ownerId, sessionId),
      requestHash = hash(canonical(b));
    const prior = s.one<{ requestHash: string; body: string }>(
      "SELECT requestHash,body FROM almanac_turns WHERE sessionId=? AND requestKey=?",
      sessionId,
      b.key,
    );
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new AccessError(
          409,
          "That save key was used for another answer.",
        );
      return InterviewTurn.parse(JSON.parse(prior.body));
    }
    openSession(row);
    const session = readSession(s, row),
      next = sessionPrompt(row, session);
    const additional =
      row.purpose === "memory" &&
      b.promptId === "additional-memory" &&
      next.action !== "wait";
    if (!additional && (next.action !== "ask" || next.promptId !== b.promptId))
      throw new AccessError(
        409,
        "This question has changed. Reopen your saved memory.",
      );
    const turn = InterviewTurn.parse({
      version: 1,
      id: id(),
      sessionId,
      sequence: session.turns.length + 1,
      promptId: b.promptId,
      promptText: additional
        ? "Is there anything else you would like to add?"
        : next.promptText,
      promptVersion: additional ? row.invitationVersion : next.promptVersion,
      status: "awaiting_audio",
      audio: null,
      transcript: null,
      createdAt: now(),
    });
    s.run(
      "INSERT INTO almanac_turns VALUES(?,?,?,?,?,?)",
      turn.id,
      sessionId,
      turn.sequence,
      b.key,
      requestHash,
      canonical(turn),
    );
    s.run(
      "UPDATE almanac_sessions SET updatedAt=? WHERE id=?",
      now(),
      sessionId,
    );
    return turn;
  });
}
export function validateAudio(bytes: Buffer, mime: string) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || bytes.length > 25000000)
    throw new AccessError(
      400,
      "Choose a complete recording smaller than 25 MB.",
    );
  const matches =
    (["audio/wav", "audio/x-wav"].includes(mime) &&
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WAVE") ||
    (mime === "audio/webm" &&
      bytes.subarray(0, 4).toString("hex") === "1a45dfa3") ||
    (mime === "audio/ogg" && bytes.subarray(0, 4).toString() === "OggS") ||
    (mime === "audio/mpeg" &&
      (bytes.subarray(0, 3).toString() === "ID3" ||
        (bytes[0] === 255 && (bytes[1] & 224) === 224))) ||
    (["audio/mp4", "audio/x-m4a", "video/mp4"].includes(mime) &&
      bytes.subarray(4, 8).toString() === "ftyp");
  if (!matches)
    throw new AccessError(
      415,
      "Choose a WAV, MP3, M4A, OGG or WebM recording.",
    );
  if (mime.includes("wav")) {
    let hasData = false;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const size = bytes.readUInt32LE(offset + 4),
        end = offset + 8 + size;
      if (end > bytes.length)
        throw new AccessError(400, "The WAV recording is incomplete.");
      if (bytes.subarray(offset, offset + 4).toString() === "data" && size > 0)
        hasData = true;
      offset = end + (size % 2);
    }
    if (!hasData)
      throw new AccessError(
        400,
        "The recording has no audio. Please record again.",
      );
  }
}
export function saveTurnAudio(
  s: Store,
  ownerId: string,
  sessionId: string,
  turnId: string,
  bytes: Buffer,
  mime: string,
  mode: unknown,
) {
  const row = ownedSession(s, ownerId, sessionId),
    turn = readTurn(s, sessionId, turnId);
  const captureMode = z.enum(["microphone", "upload"]).parse(mode ?? "upload");
  validateAudio(bytes, mime);
  if (turn.audio) {
    if (turn.audio.sha256 !== hash(bytes) || turn.audio.mime !== mime)
      throw new AccessError(
        409,
        "This answer already has a saved recording. Add another answer to keep both.",
      );
    return turn;
  }
  openSession(row);
  if (turn.status !== "awaiting_audio")
    throw new AccessError(409, "This answer is already saved.");
  return s.transaction(() => {
    const digest = s.putAsset(row.projectId, bytes, "audio"),
      recordingId = id();
    turn.audio = {
      recordingId,
      sha256: digest,
      mime,
      bytes: bytes.length,
      captureMode,
    };
    turn.status = "audio_saved";
    writeTurn(s, turn);
    return turn;
  });
}
export function persistTranscript(
  s: Store,
  turn: InterviewTurnRecord,
  transcript: NonNullable<InterviewTurnRecord["transcript"]>,
) {
  const contentHash = hash(canonical(transcript));
  if (turn.transcript && hash(canonical(turn.transcript)) === contentHash)
    return turn;
  const existing = s.one<{ id: string }>(
    "SELECT id FROM almanac_transcript_versions WHERE turnId=? AND contentHash=?",
    turn.id,
    contentHash,
  );
  if (!existing) {
    const revision = s.one<{ n: number }>(
      "SELECT COALESCE(MAX(revision),0)+1 AS n FROM almanac_transcript_versions WHERE turnId=?",
      turn.id,
    )!.n;
    s.run(
      "INSERT INTO almanac_transcript_versions VALUES(?,?,?,?,?,?)",
      id(),
      turn.id,
      revision,
      contentHash,
      canonical(transcript),
      now(),
    );
  }
  turn.transcript = transcript;
  turn.status = "complete";
  writeTurn(s, turn);
  return turn;
}
export function makeTranscript(
  rawText: string,
  mode: "manual" | "live",
  recordingId: string | null,
) {
  return Transcript.extend({ mode: z.enum(["manual", "live"]) }).parse({
    version: 1,
    mode,
    recordingId,
    rawText,
    segments: rawText
      .split(/\n+|(?<=[.!?])\s+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((text, i) => ({
        id: `s${i + 1}`,
        text,
        startMs: null,
        endMs: null,
      })),
  });
}
export function saveTurnText(
  s: Store,
  ownerId: string,
  sessionId: string,
  turnId: string,
  input: unknown,
) {
  const row = ownedSession(s, ownerId, sessionId),
    turn = readTurn(s, sessionId, turnId);
  const b = z
    .object({ rawText: z.string().trim().min(1).max(50000) })
    .parse(input);
  const transcript = makeTranscript(
    b.rawText,
    "manual",
    turn.audio?.recordingId ?? null,
  );
  if (turn.transcript && canonical(turn.transcript) === canonical(transcript))
    return turn;
  openSession(row);
  if (turn.status === "transcribing" || turn.status === "skipped")
    throw new AccessError(
      409,
      "Finish this answer before changing its transcript.",
    );
  return s.transaction(() => {
    const saved = persistTranscript(s, turn, transcript);
    // A manual answer can move past a failed request without replaying it.
    // Its call receipts and ambiguous reservation remain retained.
    s.run(
      "UPDATE studio_jobs SET status='superseded',leaseToken=NULL,leaseUntil=0 WHERE status='needs_attention' AND id IN (SELECT jobId FROM almanac_transcriptions WHERE turnId=?)",
      turnId,
    );
    return saved;
  });
}
export function skipTurn(
  s: Store,
  ownerId: string,
  sessionId: string,
  turnId: string,
) {
  const row = ownedSession(s, ownerId, sessionId),
    turn = readTurn(s, sessionId, turnId);
  if (turn.status === "skipped") return turn;
  openSession(row);
  if (turn.audio || turn.transcript)
    throw new AccessError(
      409,
      "This answer is saved. You can leave it out when making a story.",
    );
  turn.status = "skipped";
  writeTurn(s, turn);
  return turn;
}
export function freezeSource(
  s: Store,
  ownerId: string,
  sessionId: string,
  input: unknown,
) {
  const b = z
    .object({
      consent: z.literal(true),
      turnIds: z.array(z.string()).min(1).max(100).optional(),
    })
    .parse(input);
  return s.transaction(() => {
    const row = ownedSession(s, ownerId, sessionId),
      session = readSession(s, row);
    if (row.purpose === "page_title")
      throw new AccessError(
        409,
        "A spoken page name cannot be used as a story. Open a memory invitation to make a book.",
      );
    if (
      !b.turnIds &&
      session.turns.some(
        (t) => t.audio && !t.transcript && t.status !== "skipped",
      )
    )
      throw new AccessError(
        409,
        "An answer still needs its transcript. Finish it first, or explicitly choose which saved answers to include.",
      );
    if (b.turnIds && new Set(b.turnIds).size !== b.turnIds.length)
      throw new AccessError(400, "Choose each answer only once.");
    const selected = b.turnIds
      ? session.turns.filter((t) => b.turnIds!.includes(t.id))
      : session.turns.filter((t) => t.status === "complete");
    if (
      !selected.length ||
      (b.turnIds && selected.length !== b.turnIds.length) ||
      selected.some((t) => !t.transcript || t.status !== "complete")
    )
      throw new AccessError(
        409,
        "Choose saved answers with transcripts before making a story.",
      );
    const body = {
      version: 1,
      sessionId,
      invitation: JSON.parse(row.invitation) as MemoryInvitationRecord,
      turns: selected.map((t) => ({
        id: t.id,
        sequence: t.sequence,
        promptId: t.promptId,
        promptText: t.promptText,
        promptVersion: t.promptVersion,
        audio: t.audio,
        transcript: t.transcript,
      })),
    };
    const sourceHash = hash(canonical(body));
    const prior = s.one<{
      id: string;
      revision: number;
      sourceHash: string;
      projectId: string;
    }>(
      "SELECT id,revision,sourceHash,generationProjectId AS projectId FROM almanac_sources WHERE sessionId=? AND sourceHash=?",
      sessionId,
      sourceHash,
    );
    if (prior) return { ...prior, sessionId };
    const revision = s.one<{ n: number }>(
      "SELECT COALESCE(MAX(revision),0)+1 AS n FROM almanac_sources WHERE sessionId=?",
      sessionId,
    )!.n;
    const sid = id(),
      projectId = id(),
      at = now(),
      firstAudio = selected.find((t) => t.audio)?.audio;
    const recordingId = firstAudio ? id() : null;
    const transcript = Transcript.parse({
      version: 1,
      mode: selected.every((t) => t.transcript!.mode === "live")
        ? "live"
        : "manual",
      recordingId,
      rawText: selected.map((t) => t.transcript!.rawText).join("\n\n"),
      segments: selected.flatMap((t) =>
        t.transcript!.segments.map((segment) => ({
          ...segment,
          id: `t${t.sequence}-${segment.id}`,
        })),
      ),
    });
    const page = ownedPage(s, ownerId, row.pageId);
    s.run(
      "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
      projectId,
      ownerId,
      page.title,
      transcript.mode,
      "awaiting_editorial",
      0,
      canonical(transcript),
      at,
      at,
    );
    for (const t of selected)
      if (t.audio)
        s.putAsset(
          projectId,
          s.readAsset(row.projectId, t.audio.sha256),
          "audio",
        );
    if (firstAudio)
      s.run(
        "INSERT INTO recordings VALUES(?,?,?,?,?,?,?)",
        recordingId,
        projectId,
        firstAudio.sha256,
        firstAudio.mime,
        firstAudio.bytes,
        firstAudio.captureMode,
        at,
      );
    // Text-only memories have a real transcript but no fabricated audio file.
    s.run(
      "INSERT INTO almanac_sources VALUES(?,?,?,?,?,?,?)",
      sid,
      sessionId,
      revision,
      sourceHash,
      projectId,
      canonical(body),
      at,
    );
    s.run(
      "INSERT OR IGNORE INTO almanac_memories VALUES(?,?,?,?)",
      ownerId,
      row.pageId,
      projectId,
      at,
    );
    return { id: sid, revision, sourceHash, projectId, sessionId };
  });
}
