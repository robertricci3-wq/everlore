import { z } from "zod";
import { DEFAULT_MEMORY_GUIDE } from "../../shared/memoryGuide.js";
import {
  MEMORY_INVITATIONS,
  type MemoryInvitationRecord,
} from "../../shared/invitations.js";
import {
  FAMILY_CONSENT_TEXT,
  FAMILY_CONSENT_VERSION,
  JourneyStart,
  JourneyCreate,
  type JourneySetup,
  type JourneyView,
} from "../../shared/journey.js";
import type { InterviewTurnRecord } from "../../shared/almanac.js";
import { AccessError, requireOperator } from "../access.js";
import { ProductionImageReview, imageAccepted } from "../engine/art-review.js";
import {
  canonical,
  hash,
  id,
  now,
  type Store,
  type ProjectRow,
} from "../store.js";
import type { EngineConfig } from "../engine/provider.js";
import { activeProfile, verifyProfile } from "../lab/profiles.js";
import {
  latestStudio,
  pinStudioContinuity,
  queueStudio,
} from "../engine/studio.js";
import { familySetupView } from "../engine/setup.js";
import { isRecoveryLocked } from "../recovery-lock.js";
import {
  ensureAlmanac,
  freezeSource,
  ownedSession,
  readSession,
  sessionView,
  startTurn,
  type SessionRow,
} from "./service.js";
import { queueInterviewTranscription } from "./transcription.js";
import { bindPilotCreation, pilotAccess, pilotCreationFunding } from "../pilot/service.js";
import { pilotConnectionReady } from "../pilot/integration.js";

const FREEFORM_PAGE = "freeform-memory";
const FREEFORM_INVITATION: MemoryInvitationRecord = {
  ...MEMORY_INVITATIONS[0],
  id: "freeform-memory-v1",
  title: "Your memory",
  opening: "Tell me a memory you would like to keep. Start wherever you like.",
  alternativeEntries: [
    "A person, a place or a small moment is enough.",
    "You can leave details uncertain.",
  ],
  followUps: [],
};
interface Selection {
  id: string;
  audioHash: string | null;
  transcriptHash: string | null;
}
interface CreationRow {
  id: string;
  ownerId: string;
  sessionId: string;
  requestKey: string;
  requestHash: string;
  consentVersion: string;
  selection: string;
  profile: string;
  continuity: string;
  status: string;
  sourceId: string | null;
  projectId: string | null;
  historicalProjectId: string | null;
  studioJobId: string | null;
  pauseReason: string | null;
  error: string | null;
  leaseToken: string | null;
  leaseUntil: number;
}
function requirePrivate(s: Store, ownerId: string) {
  if (!s.one("SELECT id FROM users WHERE id=? AND kind='private'", ownerId))
    throw new AccessError(403, "Open your private shelf first.");
}
function hasConsent(
  s: Store,
  ownerId: string,
  scope: keyof typeof FAMILY_CONSENT_TEXT,
) {
  return !!s.one(
    "SELECT id FROM almanac_consents WHERE ownerId=? AND version=? AND scope=?",
    ownerId,
    FAMILY_CONSENT_VERSION,
    scope,
  );
}
function recordConsent(
  s: Store,
  ownerId: string,
  scope: keyof typeof FAMILY_CONSENT_TEXT,
) {
  s.run(
    "INSERT OR IGNORE INTO almanac_consents VALUES(?,?,?,?,?,?)",
    id(),
    ownerId,
    FAMILY_CONSENT_VERSION,
    scope,
    FAMILY_CONSENT_TEXT[scope],
    now(),
  );
}
function available(s: Store, ownerId: string, config: EngineConfig) {
  if (config.pilotCreationId) {
    const funding = pilotCreationFunding(s, config.pilotCreationId);
    const access = pilotAccess(s, ownerId);
    return !!funding && funding.ownerId === ownerId && funding.campaign.state === "active" && !!access && access.remainingCents > 0 && pilotConnectionReady(s, config);
  }
  return familySetupView(s, ownerId, config).canStart;
}
export function journeySetup(
  s: Store,
  ownerId: string,
  config: EngineConfig,
): JourneySetup {
  requirePrivate(s, ownerId);
  return {
    consentVersion: FAMILY_CONSENT_VERSION,
    consented: hasConsent(s, ownerId, "collection"),
    aiProcessingConsented: hasConsent(s, ownerId, "processing"),
    adaptationConsented: hasConsent(s, ownerId, "adaptation"),
    canCreate: available(s, ownerId, config),
  };
}
export function recordJourneyStarted(
  s: Store,
  ownerId: string,
  sessionId: string,
) {
  const session = ownedSession(s, ownerId, sessionId);
  if (session.purpose !== "memory" || session.status !== "open")
    throw new AccessError(409, "Reopen this memory before recording.");
  s.run(
    "INSERT OR IGNORE INTO almanac_journey_events VALUES(?,'recording_started',?)",
    sessionId,
    now(),
  );
  return { saved: true as const };
}
/** Operational timing evidence only; never returns source text or family identities. */
export function journeyMetrics(s: Store, actorId: string) {
  requireOperator(s, actorId);
  const summarize = (values: number[]) => {
    const valid = values
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((a, b) => a - b);
    return {
      samples: valid.length,
      medianMs: valid.length
        ? (valid[Math.floor((valid.length - 1) / 2)] +
            valid[Math.ceil((valid.length - 1) / 2)]) /
          2
        : null,
    };
  };
  const recording = s.all<{ started: string; eventAt: string }>(
    "SELECT s.createdAt AS started,e.createdAt AS eventAt FROM almanac_sessions s JOIN almanac_journey_events e ON e.sessionId=s.id WHERE e.event='recording_started'",
  );
  const creations = s.all<{
    id: string;
    createdAt: string;
    updatedAt: string;
    status: string;
    studioJobId: string | null;
  }>(
    "SELECT id,createdAt,updatedAt,status,studioJobId FROM almanac_creation_requests",
  );
  const imageTimes: number[] = [];
  for (const request of creations) {
    if (!request.studioJobId) continue;
    const accepted = s
      .all<{ result: string; createdAt: string; latencyMs: number }>(
        "SELECT st.result,c.createdAt,c.latencyMs FROM studio_steps st JOIN studio_calls c ON c.jobId=st.jobId AND c.stage=st.stage WHERE st.jobId=? AND st.state='completed' AND c.status='completed' ORDER BY c.createdAt",
        request.studioJobId,
      )
      .find((step) => {
        const parsed = ProductionImageReview.safeParse(JSON.parse(step.result));
        return parsed.success && imageAccepted(parsed.data);
      });
    if (accepted)
      imageTimes.push(
        Date.parse(accepted.createdAt) +
          (accepted.latencyMs ?? 0) -
          Date.parse(request.createdAt),
      );
  }
  return {
    version: 1,
    scope:
      "Recorded local service events; missing timings are unobserved. Image acceptance is a saved machine review, not family feedback.",
    timeToFirstRecording: summarize(
      recording.map(
        (event) => Date.parse(event.eventAt) - Date.parse(event.started),
      ),
    ),
    requestToFirstAcceptedImage: summarize(imageTimes),
    requestToBook: summarize(
      creations
        .filter((request) => request.status === "ready")
        .map(
          (request) =>
            Date.parse(request.updatedAt) - Date.parse(request.createdAt),
        ),
    ),
    requests: creations.length,
    completed: creations.filter((request) => request.status === "ready").length,
    paused: creations.filter((request) => request.status === "paused").length,
    cancelled: creations.filter((request) => request.status === "cancelled")
      .length,
    repeatedCreateActions: Math.max(
      0,
      s.one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM almanac_creation_keys",
      )!.count - creations.length,
    ),
    resumedCheckpoints: s.one(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='studio_checkpoints'",
    )
      ? s.one<{ count: number }>(
          "SELECT COUNT(*) AS count FROM studio_checkpoints c JOIN almanac_creation_requests r ON r.studioJobId=c.jobId WHERE c.resumedAt IS NOT NULL",
        )!.count
      : 0,
  };
}

/** The client owns the retry key; neither starting nor saving dispatches work. */
export function startJourney(
  s: Store,
  ownerId: string,
  input: unknown,
  config: EngineConfig,
) {
  requirePrivate(s, ownerId);
  const body = JourneyStart.parse(input);
  const invitation = body.invitationId
    ? MEMORY_INVITATIONS.find((item) => item.id === body.invitationId)
    : FREEFORM_INVITATION;
  if (!invitation)
    throw new AccessError(400, "That memory invitation is unavailable.");
  if (
    (body.consent || body.processWithOpenAI || body.imaginativeAdaptation) &&
    body.consentVersion !== FAMILY_CONSENT_VERSION
  )
    throw new AccessError(
      400,
      "Review the current privacy choices before continuing.",
    );
  const sessionId = s.transaction(() => {
    if (body.consent) recordConsent(s, ownerId, "collection");
    if (!hasConsent(s, ownerId, "collection"))
      throw new AccessError(
        409,
        "Agree to save your memory privately before beginning.",
      );
    if (body.processWithOpenAI) recordConsent(s, ownerId, "processing");
    if (body.imaginativeAdaptation) recordConsent(s, ownerId, "adaptation");
    const prior = s.one<SessionRow>(
      "SELECT * FROM almanac_sessions WHERE ownerId=? AND requestKey=?",
      ownerId,
      body.key,
    );
    if (prior) {
      if (prior.invitationId !== invitation.id || prior.purpose !== "memory")
        throw new AccessError(409, "That save key belongs to another memory.");
      if (hasConsent(s, ownerId, "processing"))
        s.run(
          "UPDATE almanac_sessions SET aiConsentAt=COALESCE(aiConsentAt,?) WHERE id=?",
          now(),
          prior.id,
        );
      return prior.id;
    }
    ensureAlmanac(s, ownerId);
    const pageId = body.invitationId ?? FREEFORM_PAGE,
      at = now();
    if (!body.invitationId)
      s.run(
        "INSERT OR IGNORE INTO almanac_pages VALUES(?,?,?,?,NULL,10000,1,1,?,?,?)",
        ownerId,
        FREEFORM_PAGE,
        "Your memories",
        "Memories you started in your own way.",
        "[]",
        at,
        at,
      );
    const sid = id(),
      projectId = id();
    s.run(
      "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
      projectId,
      ownerId,
      invitation.title,
      "unavailable",
      "interview",
      0,
      null,
      at,
      at,
    );
    s.run(
      "INSERT INTO almanac_sessions(id,ownerId,projectId,pageId,invitationId,invitationVersion,invitation,status,requestKey,consentAt,aiConsentAt,createdAt,updatedAt,purpose,guideProfile) VALUES(?,?,?,?,?,?,?,'open',?,?,?,?,?,'memory',?)",
      sid,
      ownerId,
      projectId,
      pageId,
      invitation.id,
      invitation.revision,
      canonical(invitation),
      body.key,
      at,
      hasConsent(s, ownerId, "processing") ? at : null,
      at,
      at,
      canonical(DEFAULT_MEMORY_GUIDE),
    );
    return sid;
  });
  let view = sessionView(s, ownerId, sessionId);
  if (!view.session.turns.length && view.nextPrompt.action === "ask") {
    startTurn(s, ownerId, sessionId, {
      key: "journey-opening-v1",
      promptId: view.nextPrompt.promptId,
    });
    view = sessionView(s, ownerId, sessionId);
  }
  return { session: view, journey: journeyView(s, ownerId, sessionId, config) };
}

const selectedTurns = (turns: InterviewTurnRecord[]) =>
  turns.filter(
    (turn) => turn.status !== "skipped" && (turn.audio || turn.transcript),
  );
const selectionFor = (turns: InterviewTurnRecord[]): Selection[] =>
  selectedTurns(turns).map((turn) => ({
    id: turn.id,
    audioHash: turn.audio?.sha256 ?? null,
    transcriptHash: turn.transcript ? hash(canonical(turn.transcript)) : null,
  }));
function latestCreation(s: Store, sessionId: string) {
  return s.one<CreationRow>(
    "SELECT * FROM almanac_creation_requests WHERE sessionId=? ORDER BY rowid DESC LIMIT 1",
    sessionId,
  );
}
const cancelledCreation = (request: CreationRow | undefined) =>
  !!request &&
  (request.status === "cancelled" ||
    (!!request.historicalProjectId && !request.projectId));
function sameSource(
  selection: Selection[],
  turns: InterviewTurnRecord[],
  exact = true,
) {
  const current = selectionFor(turns);
  return (
    (!exact || selection.length === current.length) &&
    selection.every((item) => {
      const next = current.find((turn) => turn.id === item.id);
      return (
        next &&
        next.audioHash === item.audioHash &&
        (item.transcriptHash === null ||
          next.transcriptHash === item.transcriptHash)
      );
    })
  );
}
export function createJourney(
  s: Store,
  ownerId: string,
  sessionId: string,
  input: unknown,
  config: EngineConfig,
): JourneyView {
  const body = JourneyCreate.parse(input),
    row = ownedSession(s, ownerId, sessionId);
  if (row.purpose !== "memory")
    throw new AccessError(
      409,
      "A page name cannot become a book. Start a memory first.",
    );
  const requestHash = hash(
    canonical({
      sessionId,
      consentVersion: body.consentVersion,
      continuityMode: body.continuityMode,
      familyVersionId: body.familyVersionId ?? null,
    }),
  );
  const creationId = s.transaction(() => {
    const previousKey = s.one<{ requestHash: string; creationId: string }>(
      "SELECT requestHash,creationId FROM almanac_creation_keys WHERE ownerId=? AND requestKey=?",
      ownerId,
      body.key,
    );
    if (previousKey) {
      if (previousKey.requestHash !== requestHash)
        throw new AccessError(
          409,
          "That creation key belongs to another request.",
        );
      return previousKey.creationId;
    }
    const session = readSession(s, row),
      selection = selectionFor(session.turns);
    if (!selection.length)
      throw new AccessError(
        409,
        "Save a recording or some words before making your book.",
      );
    const latest = latestCreation(s, sessionId);
    if (
      latest &&
      !cancelledCreation(latest) &&
      (latest.status !== "ready" ||
        sameSource(JSON.parse(latest.selection), session.turns))
    ) {
      if (latest.requestHash !== requestHash)
        throw new AccessError(
          409,
          "This memory already has a saved book request. Continue that book first.",
        );
      s.run(
        "INSERT INTO almanac_creation_keys VALUES(?,?,?,?)",
        ownerId,
        body.key,
        requestHash,
        latest.id,
      );
      return latest.id;
    }
    recordConsent(s, ownerId, "processing");
    recordConsent(s, ownerId, "adaptation");
    const profile = activeProfile(s, config);
    const mode =
      body.familyVersionId && body.continuityMode === "auto"
        ? "specific"
        : body.continuityMode;
    const continuity = pinStudioContinuity(
      s,
      ownerId,
      mode,
      body.familyVersionId,
    );
    const creationId = id(),
      at = now();
    s.run(
      "INSERT INTO almanac_creation_requests(id,ownerId,sessionId,requestKey,requestHash,consentVersion,selection,profile,continuity,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?)",
      creationId,
      ownerId,
      sessionId,
      body.key,
      requestHash,
      body.consentVersion,
      canonical(selection),
      canonical(profile),
      canonical(continuity),
      at,
      at,
    );
    bindPilotCreation(s, ownerId, creationId);
    s.run(
      "INSERT INTO almanac_creation_keys VALUES(?,?,?,?)",
      ownerId,
      body.key,
      requestHash,
      creationId,
    );
    s.run(
      "UPDATE almanac_sessions SET aiConsentAt=COALESCE(aiConsentAt,?),updatedAt=? WHERE id=?",
      at,
      at,
      sessionId,
    );
    return creationId;
  });
  return journeyView(s, ownerId, sessionId, config, creationId);
}

function pausedMessage(reason: string | null) {
  return reason === "source"
    ? "Your memory is saved. Its words changed after this book was requested; we need to check them before continuing."
    : reason === "transcription"
      ? "Your recording is saved. We need to check its transcription before continuing."
      : reason === "studio"
        ? "Your book is saved in progress. We need to check a step before continuing."
        : "Your memory is saved. Book creation is unavailable right now; your request will continue when it is available.";
}
export function journeyView(
  s: Store,
  ownerId: string,
  sessionId: string,
  config: EngineConfig,
  creationId?: string,
): JourneyView {
  const session = ownedSession(s, ownerId, sessionId),
    request = creationId
      ? s.one<CreationRow>(
          "SELECT * FROM almanac_creation_requests WHERE id=? AND sessionId=?",
          creationId,
          sessionId,
        )
      : latestCreation(s, sessionId);
  let status: JourneyView["status"] = "saved",
    message =
      "Your memory is saved. You can make a book whenever you are ready.";
  let bookReady = false;
  const cancelled = cancelledCreation(request);
  if (request && !cancelled) {
    const progressConfig = pilotCreationFunding(s, request.id)
      ? { ...config, pilotCreationId: request.id }
      : config;
    const job = request.studioJobId
      ? s.one<{ status: string }>(
          "SELECT status FROM studio_jobs WHERE id=?",
          request.studioJobId,
        )
      : undefined;
    bookReady = !!(
      request.projectId &&
      s.one(
        "SELECT p.id FROM projects p JOIN revisions r ON r.projectId=p.id AND r.revision=p.revision WHERE p.id=? AND p.revision>0",
        request.projectId,
      ) &&
      job?.status === "complete"
    );
    if (bookReady) {
      status = "ready";
      message = "Your book is ready.";
    } else if (job && !["queued", "running"].includes(job.status)) {
      status = "paused";
      message = pausedMessage("studio");
    } else if (
      request.status === "paused" ||
      !familySetupView(s, ownerId, config).ready ||
      (!available(s, ownerId, progressConfig) && !job)
    ) {
      status = "paused";
      message = pausedMessage(request.pauseReason);
    } else if (
      request.status === "transcribing" ||
      (JSON.parse(request.selection).some(
        (item: Selection) => item.audioHash && !item.transcriptHash,
      ) &&
        !request.sourceId)
    ) {
      status = "transcribing";
      message = "Turning your saved recording into words.";
    } else {
      status = "creating";
      message = "Making your illustrated book. Your memory is saved.";
    }
  }
  return {
    sessionId,
    requestId: cancelled ? null : (request?.id ?? null),
    status,
    message,
    projectId: request?.projectId ?? null,
    bookReady,
    canCreate:
      (!request || cancelled) &&
      session.purpose === "memory" &&
      available(s, ownerId, config),
  };
}

/** Advances durable bookkeeping only. Existing bounded workers make every paid call. */
export function advanceCreationRequest(
  s: Store,
  config: EngineConfig,
  options: { creationId?: string } = {},
): boolean {
  if (isRecoveryLocked(s)) return false;
  // A deleted book is a cancelled request, never permission to rebuild it.
  // The historical ID deliberately has no foreign key and survives deletion.
  s.run(
    "UPDATE almanac_creation_requests SET status='cancelled',pauseReason=NULL,error=NULL,leaseToken=NULL,leaseUntil=0,updatedAt=? WHERE historicalProjectId IS NOT NULL AND projectId IS NULL AND status!='cancelled'",
    now(),
  );
  const token = id(),
    request = s.transaction(() => {
      const found = s.one<CreationRow>(
        `SELECT * FROM almanac_creation_requests WHERE status NOT IN ('ready','cancelled') AND leaseUntil<? AND ${options.creationId ? "id=?" : "NOT EXISTS(SELECT 1 FROM pilot_creations WHERE creationId=almanac_creation_requests.id)"} ORDER BY lastAttemptAt,rowid LIMIT 1`,
        Date.now(),
        ...(options.creationId ? [options.creationId] : []),
      );
      if (found)
        s.run(
          "UPDATE almanac_creation_requests SET leaseToken=?,leaseUntil=?,lastAttemptAt=? WHERE id=?",
          token,
          Date.now() + 60000,
          Date.now(),
          found.id,
        );
      return found;
    });
  if (!request) return false;
  const update = (status: string, reason: string | null = null) =>
    s.run(
      "UPDATE almanac_creation_requests SET status=?,pauseReason=?,error=NULL,updatedAt=? WHERE id=? AND leaseToken=?",
      status,
      reason,
      now(),
      request.id,
      token,
    );
  try {
    if (request.studioJobId) {
      const job = s.one<{ status: string }>(
        "SELECT status FROM studio_jobs WHERE id=?",
        request.studioJobId,
      );
      if (job?.status === "complete") {
        update("ready");
        s.run(
          "UPDATE almanac_sessions SET status='finished',updatedAt=? WHERE id=?",
          now(),
          request.sessionId,
        );
      } else
        update(
          job && ["queued", "running"].includes(job.status)
            ? "creating"
            : "paused",
          job && ["queued", "running"].includes(job.status) ? null : "studio",
        );
      return true;
    }
    const profile = verifyProfile(JSON.parse(request.profile));
    const row = ownedSession(s, request.ownerId, request.sessionId),
      session = readSession(s, row);
    const selection: Selection[] = JSON.parse(request.selection);
    if (!request.sourceId && !sameSource(selection, session.turns, false)) {
      update("paused", "source");
      return true;
    }
    if (!request.sourceId) {
      for (const item of selection) {
        const turn = session.turns.find((turn) => turn.id === item.id)!;
        if (turn.transcript) continue;
        const job = s.one<{ status: string }>(
          "SELECT j.status FROM studio_jobs j JOIN almanac_transcriptions t ON t.jobId=j.id WHERE t.turnId=?",
          turn.id,
        );
        if (job) {
          update(
            ["queued", "running"].includes(job.status)
              ? "transcribing"
              : "paused",
            ["queued", "running"].includes(job.status) ? null : "transcription",
          );
          return true;
        }
        if (!available(s, request.ownerId, config)) {
          update("paused", "unavailable");
          return true;
        }
        queueInterviewTranscription(
          s,
          request.ownerId,
          request.sessionId,
          turn.id,
          { processWithOpenAI: true },
          config,
          profile,
        );
        update("transcribing");
        return true;
      }
      const source = freezeSource(
        s,
        request.ownerId,
        request.sessionId,
        {
          consent: true,
          turnIds: selection.map((item) => item.id),
        },
        (frozen) => {
          // Commit the derived source and request pointer together. No crash or
          // deletion can leave a paid handoff without its historical identity.
          s.run(
            "UPDATE almanac_creation_requests SET sourceId=?,projectId=?,historicalProjectId=?,updatedAt=? WHERE id=? AND leaseToken=?",
            frozen.id,
            frozen.projectId,
            frozen.projectId,
            now(),
            request.id,
            token,
          );
        },
      );
      const frozen = JSON.parse(
        s.one<{ body: string }>(
          "SELECT body FROM almanac_sources WHERE id=?",
          source.id,
        )!.body,
      ) as { turns: InterviewTurnRecord[] };
      if (!sameSource(selection, frozen.turns)) {
        update("paused", "source");
        return true;
      }
      request.sourceId = source.id;
      request.projectId = source.projectId;
      s.run(
        "UPDATE almanac_creation_requests SET sourceId=?,projectId=?,selection=?,updatedAt=? WHERE id=? AND leaseToken=?",
        source.id,
        source.projectId,
        canonical(
          selectionFor(
            session.turns.filter((turn) =>
              selection.some((item) => item.id === turn.id),
            ),
          ),
        ),
        now(),
        request.id,
        token,
      );
    }
    const project = s.one<ProjectRow>(
      "SELECT * FROM projects WHERE id=? AND ownerId=?",
      request.projectId!,
      request.ownerId,
    );
    if (!project) {
      update("paused", "source");
      return true;
    }
    const source = s.one<{ body: string; sourceHash: string }>(
      "SELECT body,sourceHash FROM almanac_sources WHERE id=? AND generationProjectId=?",
      request.sourceId,
      project.id,
    );
    const sourceTurns = source
      ? (JSON.parse(source.body) as { turns: InterviewTurnRecord[] }).turns
      : [];
    const transcript = project.transcript
      ? JSON.parse(project.transcript)
      : null;
    if (
      !source ||
      hash(canonical(JSON.parse(source.body))) !== source.sourceHash ||
      !transcript ||
      transcript.rawText !==
        sourceTurns.map((turn) => turn.transcript!.rawText).join("\n\n") ||
      canonical(transcript.segments) !==
        canonical(
          sourceTurns.flatMap((turn) =>
            turn.transcript!.segments.map((segment) => ({
              ...segment,
              id: `t${turn.sequence}-${segment.id}`,
            })),
          ),
        )
    ) {
      update("paused", "source");
      return true;
    }
    const continuity = JSON.parse(request.continuity);
    if (
      !latestStudio(s, project.id) &&
      !familySetupView(s, request.ownerId, config).ready
    ) {
      update("paused", "unavailable");
      return true;
    }
    const jobId = queueStudio(
      s,
      project,
      {
        processWithOpenAI: true,
        imaginativeAdaptation: true,
        autonomous: true,
        continuityMode: continuity.mode,
        familyVersionId:
          continuity.mode === "specific"
            ? continuity.familyVersionIds[0]
            : null,
      },
      config,
      profile,
      continuity,
    );
    s.run(
      "UPDATE almanac_creation_requests SET studioJobId=?,status='creating',pauseReason=NULL,error=NULL,updatedAt=? WHERE id=? AND leaseToken=?",
      jobId,
      now(),
      request.id,
      token,
    );
  } catch (error) {
    // Never expose provider/private payloads, and never replay an existing paid job here.
    update("paused", error instanceof z.ZodError ? "source" : "unavailable");
  } finally {
    s.run(
      "UPDATE almanac_creation_requests SET leaseToken=NULL,leaseUntil=0 WHERE id=? AND leaseToken=?",
      request.id,
      token,
    );
  }
  return true;
}
