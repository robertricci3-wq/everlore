import { z } from "zod";
import { Store, canonical, hash, id, now } from "../store.js";
import type { Provider, EngineConfig } from "../engine/provider.js";
import { EngineError } from "../engine/pipeline.js";
import { agenda, artCases, cases } from "./library.js";
import { heldOutCases } from "./release-cases.js";
import {
  candidateProfile,
  createExperiment,
  experiment,
  summary,
  parsePlan,
} from "./service.js";
import { runExperiment, pauseExperiment, recoverExpiredLab } from "./runner.js";
import { createMemoryExperiment, runMemoryExperiment } from "./memory.js";
import {
  acquireSessionLease,
  ensureSessionSchema,
  ownsSessionLease,
  releaseSessionLease,
  renewSessionLease,
} from "./session-schema.js";

export const SessionPlan = z.object({
  agendaIds: z.array(z.string()).optional(),
  mode: z.enum(["offline", "live"]).default("offline"),
  lane: z.enum(["memory", "story", "art"]).default("memory"),
  maxIterations: z.number().int().min(1).max(5).default(1),
  maxCents: z.number().int().min(0).max(1000000).default(0),
  authorizeCosts: z.boolean().default(false),
  requestKey: z.string().min(1).max(160).optional(),
});
export interface SessionRow {
  id: string;
  ownerId: string;
  plan: string;
  status: string;
  iteration: number;
  noProgress: number;
  currentExperiment: string | null;
  checkpoint: string;
  createdAt: string;
}
interface JournalRow {
  experimentId: string;
  request: string | null;
  phase: string;
}

export function newSession(store: Store, ownerId: string, input: unknown) {
  const p = SessionPlan.parse(input);
  if (p.mode === "live" && (!p.authorizeCosts || p.maxCents <= 0))
    throw new EngineError(
      "A live learning session requires a separate explicit allowance.",
    );
  if (p.lane === "memory" && p.mode !== "offline")
    throw new EngineError(
      "Guided-memory comparisons currently use deterministic offline cases only.",
    );
  ensureSessionSchema(store);
  const inputHash = hash(canonical(p));
  if (p.requestKey) {
    const prior = store.one<{ inputHash: string; sessionId: string }>(
      "SELECT inputHash,sessionId FROM lab_session_requests WHERE ownerId=? AND requestKey=?",
      ownerId,
      p.requestKey,
    );
    if (prior) {
      if (prior.inputHash !== inputHash)
        throw new EngineError(
          "This session request key already identifies a different frozen plan.",
        );
      return prior.sessionId;
    }
  }
  const scores = new Map<string, number>();
  for (const row of store.all<{ plan: string; id: string }>(
    "SELECT plan,id FROM lab_experiments WHERE ownerId=?",
    ownerId,
  )) {
    const prior = JSON.parse(row.plan);
    if (prior.evaluationPhase === "release" || prior.lane !== p.lane) continue;
    const failures = store.one<{ n: number }>(
      "SELECT count(*) AS n FROM lab_runs WHERE experimentId=? AND status IN ('failed','needs_attention')",
      row.id,
    )!.n;
    const comparisons = store.all<{ body: string }>(
      "SELECT body FROM lab_comparisons WHERE experimentId=?",
      row.id,
    );
    scores.set(
      prior.criterion,
      (scores.get(prior.criterion) ?? 0) +
        failures +
        comparisons.filter((r) => JSON.parse(r.body).winner !== "candidate")
          .length,
    );
  }
  p.agendaIds =
    p.lane === "memory"
      ? []
      : agenda
          .filter((a) =>
            p.lane === "art" ? a.target === "art" : a.target !== "art",
          )
          .sort(
            (a, b) =>
              (scores.get(b.criterion) ?? 0) - (scores.get(a.criterion) ?? 0),
          )
          .map((a) => a.id);
  const sid = id();
  store.transaction(() => {
    store.run(
      "INSERT INTO lab_sessions VALUES(?,?,?,?,0,0,NULL,?,?)",
      sid,
      ownerId,
      JSON.stringify(p),
      "planned",
      p.lane === "memory"
        ? "Compare source-grounded guided-memory behavior using synthetic cases."
        : "Choose the first craft mechanism from the frozen agenda.",
      now(),
    );
    if (p.requestKey)
      store.run(
        "INSERT INTO lab_session_requests VALUES(?,?,?,?)",
        ownerId,
        p.requestKey,
        inputHash,
        sid,
      );
  });
  return sid;
}

export function pauseSession(store: Store, sid: string) {
  const s = store.one<SessionRow>("SELECT * FROM lab_sessions WHERE id=?", sid);
  if (!s) throw new EngineError("Session unavailable.");
  if (s.status === "complete") return;
  store.run(
    "UPDATE lab_sessions SET status='paused',checkpoint='Paused explicitly. Resume this session to continue its retained experiment.' WHERE id=?",
    sid,
  );
  if (
    s.currentExperiment &&
    SessionPlan.parse(JSON.parse(s.plan)).lane !== "memory"
  ) {
    const e = store.one<{ status: string }>(
      "SELECT status FROM lab_experiments WHERE id=?",
      s.currentExperiment,
    );
    if (e && ["running", "planned", "paused"].includes(e.status))
      pauseExperiment(store, s.currentExperiment);
  }
}

// Store the identity and request before creation/dispatch. A crash at either
// boundary resumes that same experiment instead of purchasing another attempt.
function retainExperiment(
  store: Store,
  s: SessionRow,
  phase: string,
  request: unknown = null,
): JournalRow {
  return store.transaction(() => {
    const prior = store.one<JournalRow>(
      "SELECT experimentId,request,phase FROM lab_session_experiments WHERE sessionId=? AND iteration=? AND phase=?",
      s.id,
      s.iteration,
      phase,
    );
    const row = prior ?? {
      experimentId: id(),
      request: request === null ? null : JSON.stringify(request),
      phase,
    };
    if (!prior)
      store.run(
        "INSERT INTO lab_session_experiments VALUES(?,?,?,?,?,?)",
        s.id,
        s.iteration,
        phase,
        row.experimentId,
        row.request,
        now(),
      );
    store.run(
      "UPDATE lab_sessions SET currentExperiment=? WHERE id=?",
      row.experimentId,
      s.id,
    );
    return row;
  });
}

export async function runSession(
  store: Store,
  sid: string,
  provider: Provider,
  c: EngineConfig,
) {
  ensureSessionSchema(store);
  let s = store.one<SessionRow>("SELECT * FROM lab_sessions WHERE id=?", sid);
  if (!s) throw new EngineError("Session unavailable.");
  // A duplicate resume of a finished session is a read, not a new run.
  if (s.status === "complete") return;
  const token = acquireSessionLease(store, sid);
  const owns = () => ownsSessionLease(store, sid, token);
  const heartbeat = setInterval(
    () => renewSessionLease(store, sid, token),
    10_000,
  );
  heartbeat.unref();
  try {
    const p = SessionPlan.parse(JSON.parse(s.plan));
    if (s.status === "running") {
      recoverExpiredLab(store);
      if (
        p.lane !== "memory" &&
        s.currentExperiment &&
        store.one(
          "SELECT id FROM lab_runs WHERE experimentId=? AND status='running' AND leaseUntil>?",
          s.currentExperiment,
          Date.now(),
        )
      )
        throw new EngineError(
          "The retained experiment still has an active worker lease. Resume after it expires.",
        );
    }
    if (!["planned", "paused", "running"].includes(s.status))
      throw new EngineError(
        "This session needs its recorded failure resolved before it can resume.",
      );
    const questions = p.agendaIds
      ? p.agendaIds
          .map((aid) => agenda.find((a) => a.id === aid)!)
          .filter(Boolean)
      : agenda.filter((a) =>
          p.lane === "art" ? a.target === "art" : a.target !== "art",
        );
    if (p.lane !== "memory" && !questions.length)
      throw new EngineError(
        "No available mechanism remains in this frozen agenda.",
      );
    store.run("UPDATE lab_sessions SET status='running' WHERE id=?", sid);
    while (s.iteration < p.maxIterations && s.noProgress < 2) {
      if (
        !owns() ||
        store.one<SessionRow>("SELECT * FROM lab_sessions WHERE id=?", sid)
          ?.status !== "running"
      )
        return;
      let eid = s.currentExperiment;
      if (p.lane === "memory") {
        const row = retainExperiment(store, s, "memory");
        eid = row.experimentId;
        createMemoryExperiment(store, s.ownerId, eid);
        const result = runMemoryExperiment(store, s.ownerId, eid);
        if (!owns()) return;
        if (result.status !== "complete") {
          store.run(
            "UPDATE lab_sessions SET status=?,checkpoint=? WHERE id=?",
            result.status === "paused" ? "paused" : "needs_attention",
            `Retained ${eid}; guided-memory comparison stopped at its saved checkpoint.`,
            sid,
          );
          return;
        }
        const alreadyKnown = !!store.one(
          "SELECT id FROM lab_memory_experiments WHERE ownerId=? AND planHash=? AND status='complete' AND id!=?",
          s.ownerId,
          result.planHash,
          result.id,
        );
        const usefulFinding =
          result.summary.verdict === "policy_supported" && !alreadyKnown;
        store.run(
          "UPDATE lab_sessions SET iteration=iteration+1,noProgress=?,currentExperiment=NULL,checkpoint=? WHERE id=? AND status='running'",
          usefulFinding ? 0 : s.noProgress + 1,
          `Retained ${result.id}; ${usefulFinding ? "new supported guided-memory policy finding" : "no new supported guided-memory policy finding"}. Deterministic engineering evidence only. No live creative gain or audience validation is claimed.`,
          sid,
        );
        s = store.one<SessionRow>(
          "SELECT * FROM lab_sessions WHERE id=?",
          sid,
        )!;
        continue;
      }
      if (!eid) {
        const a = questions[s.iteration % questions.length],
          candidate = candidateProfile(store, c, a.id);
        const row = retainExperiment(store, s, "development", {
          plan: {
            title: a.title,
            hypothesis: a.amendment,
            risk: a.risk,
            lane: p.lane,
            candidateHash: candidate.hash,
            caseIds: (p.lane === "art" ? artCases : cases).map((x) => x.id),
            replicates: 3,
            mode: p.mode,
            criterion: a.criterion,
            principleIds: [a.principle],
            prerequisiteIds: [],
          },
          maxCents:
            p.mode === "live"
              ? Math.floor(
                  p.maxCents / p.maxIterations / (p.lane === "story" ? 2 : 1),
                )
              : 0,
          authorizeCosts: p.authorizeCosts,
        });
        eid = row.experimentId;
      }
      // Legacy sessions may predate the journal; preserve their existing id.
      if (!store.one("SELECT id FROM lab_experiments WHERE id=?", eid)) {
        const row = store.one<JournalRow>(
          "SELECT experimentId,request,phase FROM lab_session_experiments WHERE experimentId=?",
          eid,
        );
        if (!row?.request)
          throw new EngineError(
            "The saved experiment request is unavailable; no request was dispatched.",
          );
        createExperiment(store, s.ownerId, JSON.parse(row.request), c, eid);
      }
      const e = experiment(store, eid);
      if (["planned", "paused"].includes(e.status))
        await runExperiment(store, eid, provider, c);
      if (!owns()) return;
      const result = experiment(store, eid);
      if (result.status === "paused") {
        pauseSession(store, sid);
        return;
      }
      if (!["complete", "inconclusive", "promoted"].includes(result.status)) {
        store.run(
          "UPDATE lab_sessions SET status='needs_attention',checkpoint=? WHERE id=?",
          `Stopped at ${eid}: ${result.error ?? result.status}. No ambiguous paid call is retried.`,
          sid,
        );
        return;
      }
      const evidence = summary(store, result),
        frozen = parsePlan(result);
      if (
        p.mode === "live" &&
        p.lane === "story" &&
        frozen.evaluationPhase !== "release" &&
        evidence.complete === evidence.total &&
        evidence.wins >= frozen.caseIds.length * frozen.replicates * 0.6 &&
        evidence.losses === 0 &&
        evidence.inconclusive === 0 &&
        evidence.failures === 0
      ) {
        retainExperiment(store, s, "release", {
          plan: {
            ...frozen,
            title: `${frozen.title.slice(0, 70)} · held-out release`,
            evaluationPhase: "release",
            caseIds: heldOutCases.map((item) => item.id),
            prerequisiteIds: [eid],
          },
          maxCents: Math.floor(p.maxCents / p.maxIterations / 2),
          authorizeCosts: true,
        });
        store.run(
          "UPDATE lab_sessions SET checkpoint=? WHERE id=?",
          "Development criterion met; evaluating the frozen candidate on separate held-out memories.",
          sid,
        );
        s = store.one<SessionRow>(
          "SELECT * FROM lab_sessions WHERE id=?",
          sid,
        )!;
        continue;
      }
      const progress =
        p.mode === "live" &&
        evidence.wins > evidence.losses &&
        evidence.failures === 0;
      store.run(
        "UPDATE lab_sessions SET iteration=iteration+1,noProgress=?,currentExperiment=NULL,checkpoint=? WHERE id=? AND status='running'",
        progress ? 0 : s.noProgress + 1,
        `Retained ${eid}; ${progress ? "model evidence supports further investigation" : "no demonstrated creative gain"}. ${s.iteration === 4 ? "Fifth iteration: inspect recurring retained failures before changing the agenda." : ""}`,
        sid,
      );
      s = store.one<SessionRow>("SELECT * FROM lab_sessions WHERE id=?", sid)!;
    }
    if (owns())
      store.run(
        "UPDATE lab_sessions SET status='complete',checkpoint=checkpoint || ? WHERE id=? AND status='running'",
        s.noProgress >= 2
          ? p.lane === "memory"
            ? " Stopped after two consecutive iterations without a new supported finding."
            : " Stopped after two consecutive iterations without demonstrated improvement."
          : " Reached the authorized iteration limit.",
        sid,
      );
  } catch (error) {
    if (owns())
      store.run(
        "UPDATE lab_sessions SET status='needs_attention',checkpoint=? WHERE id=? AND status IN('planned','running')",
        error instanceof EngineError
          ? error.message
          : "Session stopped at a retained checkpoint; inspect the experiment before resuming.",
        sid,
      );
  } finally {
    clearInterval(heartbeat);
    releaseSessionLease(store, sid, token);
  }
}
