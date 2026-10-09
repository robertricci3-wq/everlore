import { z } from "zod";
import { Store, id, now } from "../store.js";
import type { Provider, EngineConfig } from "../engine/provider.js";
import { EngineError } from "../engine/pipeline.js";
import { agenda, artCases, cases, heldOutCases } from "./library.js";
import {
  candidateProfile,
  createExperiment,
  experiment,
  summary,
  parsePlan,
} from "./service.js";
import { runExperiment, pauseExperiment } from "./runner.js";
export const SessionPlan = z.object({
  agendaIds: z.array(z.string()).optional(),
  mode: z.enum(["offline", "live"]),
  lane: z.enum(["story", "art"]),
  maxIterations: z.number().int().min(1).max(5),
  maxCents: z.number().int().min(0).max(1000000),
  authorizeCosts: z.boolean(),
});
interface SessionRow {
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
const working = new Set<string>();
export function newSession(store: Store, ownerId: string, input: unknown) {
  const p = SessionPlan.parse(input);
  if (p.mode === "live" && (!p.authorizeCosts || p.maxCents <= 0))
    throw new EngineError(
      "A live learning session requires a separate explicit allowance.",
    );
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
    const weaknesses =
      failures +
      comparisons.filter((r) => JSON.parse(r.body).winner !== "candidate")
        .length;
    scores.set(
      prior.criterion,
      (scores.get(prior.criterion) ?? 0) + weaknesses,
    );
  }
  p.agendaIds = agenda
    .filter((a) => (p.lane === "art" ? a.target === "art" : a.target !== "art"))
    .sort(
      (a, b) => (scores.get(b.criterion) ?? 0) - (scores.get(a.criterion) ?? 0),
    )
    .map((a) => a.id);
  const sid = id();
  store.run(
    "INSERT INTO lab_sessions VALUES(?,?,?,?,0,0,NULL,?,?)",
    sid,
    ownerId,
    JSON.stringify(p),
    "planned",
    "Choose the first craft mechanism from the frozen agenda.",
    now(),
  );
  return sid;
}
export function pauseSession(store: Store, sid: string) {
  const s = store.one<SessionRow>("SELECT * FROM lab_sessions WHERE id=?", sid);
  if (!s) throw new EngineError("Session unavailable.");
  store.run(
    "UPDATE lab_sessions SET status='paused',checkpoint='Paused explicitly. Resume this session to continue its retained experiment.' WHERE id=?",
    sid,
  );
  if (s.currentExperiment) {
    const e = experiment(store, s.currentExperiment);
    if (["running", "planned", "paused"].includes(e.status))
      pauseExperiment(store, e.id);
  }
}
export async function runSession(
  store: Store,
  sid: string,
  provider: Provider,
  c: EngineConfig,
) {
  if (working.has(sid)) return;
  working.add(sid);
  try {
    let s = store.one<SessionRow>("SELECT * FROM lab_sessions WHERE id=?", sid);
    if (!s) throw new EngineError("Session unavailable.");
    if (!["planned", "paused"].includes(s.status))
      throw new EngineError(
        "This learning session has already stopped or is running.",
      );
    const p = SessionPlan.parse(JSON.parse(s.plan)),
      questions = p.agendaIds
        ? p.agendaIds
            .map((id) => agenda.find((a) => a.id === id)!)
            .filter(Boolean)
        : agenda.filter((a) =>
            p.lane === "art" ? a.target === "art" : a.target !== "art",
          );
    store.run("UPDATE lab_sessions SET status='running' WHERE id=?", sid);
    while (s.iteration < p.maxIterations && s.noProgress < 2) {
      if (
        store.one<SessionRow>("SELECT * FROM lab_sessions WHERE id=?", sid)
          ?.status !== "running"
      )
        return;
      let eid = s.currentExperiment;
      if (!eid) {
        const a = questions[s.iteration % questions.length],
          candidate = candidateProfile(store, c, a.id);
        eid = createExperiment(
          store,
          s.ownerId,
          {
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
          },
          c,
        );
        store.run(
          "UPDATE lab_sessions SET currentExperiment=?,checkpoint=? WHERE id=?",
          eid,
          `Iteration ${s.iteration + 1}: ${a.title}.`,
          sid,
        );
      }
      const e = experiment(store, eid);
      if (["planned", "paused"].includes(e.status))
        await runExperiment(store, eid, provider, c);
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
      const evidence = summary(store, result);
      const frozen = parsePlan(result);
      // Release evaluation spends only the reserved second half of this iteration.
      // It receives held-out inputs; the next candidate never receives its individual findings.
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
        const releaseId = createExperiment(
          store,
          s.ownerId,
          {
            plan: {
              ...frozen,
              title: `${frozen.title.slice(0, 70)} · held-out release`,
              evaluationPhase: "release",
              caseIds: heldOutCases.map((c) => c.id),
              prerequisiteIds: [eid],
            },
            maxCents: Math.floor(p.maxCents / p.maxIterations / 2),
            authorizeCosts: true,
          },
          c,
        );
        store.run(
          "UPDATE lab_sessions SET currentExperiment=?,checkpoint=? WHERE id=?",
          releaseId,
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
        "UPDATE lab_sessions SET iteration=iteration+1,noProgress=?,currentExperiment=NULL,checkpoint=? WHERE id=?",
        progress ? 0 : s.noProgress + 1,
        `Retained ${eid}; ${progress ? "model evidence supports further investigation" : "no demonstrated creative gain"}. ${s.iteration === 4 ? "Fifth iteration: inspect recurring retained failures before changing the agenda." : ""}`,
        sid,
      );
      s = store.one<SessionRow>("SELECT * FROM lab_sessions WHERE id=?", sid)!;
    }
    store.run(
      "UPDATE lab_sessions SET status='complete',checkpoint=checkpoint || ? WHERE id=?",
      s.noProgress >= 2
        ? " Stopped after two consecutive iterations without demonstrated improvement."
        : " Reached the authorized iteration limit.",
      sid,
    );
  } catch (error) {
    store.run(
      "UPDATE lab_sessions SET status='needs_attention',checkpoint=? WHERE id=?",
      error instanceof EngineError
        ? error.message
        : "Session stopped at a retained checkpoint; inspect the experiment before resuming.",
      sid,
    );
  } finally {
    working.delete(sid);
  }
}
