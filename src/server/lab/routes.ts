import { heldOutCases } from "./release-cases.js";
import {
  newSession,
  runSession,
  pauseSession,
  SessionPlan,
} from "./session.js";
import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import type { Store } from "../store.js";
import { type EngineConfig, OpenAIProvider } from "../engine/provider.js";
import { EngineError } from "../engine/pipeline.js";
import { agenda, artCases, cases } from "./library.js";
import {
  addObservation,
  candidateProfile,
  createExperiment,
  experiment,
  labOwner,
  labView,
  rollback,
  parsePlan,
} from "./service.js";
import { pauseExperiment, runExperiment, recoverExpiredLab } from "./runner.js";
import {
  experimentReport,
  publicSessionCheckpoint,
  sessionReport,
} from "./report.js";
import {
  createMemoryExperiment,
  listMemoryExperiments,
  memoryExperimentView,
  runMemoryExperiment,
} from "./memory.js";
export function installLabRoutes(
  app: Express,
  store: Store,
  config: EngineConfig,
  auth: RequestHandler,
  owner: (req: Request) => { id: string },
) {
  recoverExpiredLab(store);
  const operator: RequestHandler = (req, res, next) => {
    if (labOwner(store) !== owner(req).id)
      return void res.status(403).json({
        error:
          "Creative Lab is available only to its configured private operator.",
      });
    next();
  };
  const launch = (sid: string, maxCents: number) => {
    void runSession(
      store,
      sid,
      new OpenAIProvider({ ...config, budgetCents: maxCents }),
      config,
    ).catch(() => {
      store.run(
        "UPDATE lab_sessions SET status='paused',checkpoint='Session could not acquire its execution slot. Resume after the active session stops; no completed work is repeated.' WHERE id=? AND status='planned'",
        sid,
      );
    });
  };
  app.get("/api/lab/memory", auth, operator, (req, res) => {
    res.json({ experiments: listMemoryExperiments(store, owner(req).id) });
  });
  app.post("/api/lab/memory", auth, operator, (req, res) => {
    res.status(201).json({ id: createMemoryExperiment(store, owner(req).id) });
  });
  app.get("/api/lab/memory/:id", auth, operator, (req, res) => {
    res.json(memoryExperimentView(store, owner(req).id, String(req.params.id)));
  });
  app.post("/api/lab/memory/:id/run", auth, operator, (req, res) => {
    const { maxPairs } = z
      .object({ maxPairs: z.number().int().positive().max(1000).optional() })
      .parse(req.body);
    res.json(
      runMemoryExperiment(store, owner(req).id, String(req.params.id), {
        maxPairs,
      }),
    );
  });
  app.get("/api/lab", auth, (req, res) =>
    res.json({
      ...labView(store, config, owner(req).id),
      agenda: labOwner(store) === owner(req).id ? agenda : [],
      sessions:
        labOwner(store) === owner(req).id
          ? store
              .all<{
                id: string;
                status: string;
                iteration: number;
                noProgress: number;
                checkpoint: string;
              }>(
                "SELECT id,status,iteration,noProgress,checkpoint FROM lab_sessions WHERE ownerId=? ORDER BY rowid DESC",
                owner(req).id,
              )
              .map((s) => ({
                ...s,
                checkpoint: publicSessionCheckpoint(store, s.id, s.checkpoint),
              }))
          : [],
    }),
  );
  app.post("/api/lab/sessions", auth, operator, (req, res) => {
    const b = SessionPlan.parse(req.body);
    if (b.mode === "live" && (!config.enabled || !config.apiKey))
      throw new EngineError("Connect the provider before a live session.");
    const sid = newSession(store, owner(req).id, b);
    res.status(202).json({ id: sid });
    launch(sid, b.maxCents);
  });
  app.post("/api/lab/sessions/:id/:action", auth, operator, (req, res) => {
    const sid = String(req.params.id);
    const s = store.one<{ plan: string }>(
      "SELECT plan FROM lab_sessions WHERE id=? AND ownerId=?",
      sid,
      owner(req).id,
    );
    if (!s) throw new EngineError("Session unavailable.");
    if (req.params.action === "pause") pauseSession(store, sid);
    else if (req.params.action === "resume") {
      const p = SessionPlan.parse(JSON.parse(s.plan));
      launch(sid, p.maxCents);
    } else throw new EngineError("Unknown session action.");
    res.json({ saved: true });
  });
  app.get("/api/lab/sessions/:id/report", auth, operator, (req, res) => {
    const sid = String(req.params.id);
    if (
      !store.one(
        "SELECT id FROM lab_sessions WHERE id=? AND ownerId=?",
        sid,
        owner(req).id,
      )
    )
      throw new EngineError("Session unavailable.");
    res.json(sessionReport(store, sid));
  });
  app.post("/api/lab/experiments", auth, operator, (req, res) => {
    const b = z
      .object({
        evaluationPhase: z
          .enum(["development", "release"])
          .default("development"),
        mechanism: z.string(),
        lane: z.enum(["story", "art", "book"]),
        mode: z.enum(["offline", "live"]),
        replicates: z.number().int().min(1).max(3),
        maxCents: z.number().int().min(0).max(1000000),
        authorizeCosts: z.boolean(),
        prerequisiteIds: z.array(z.string()).max(3).default([]),
      })
      .parse(req.body);
    const a = agenda.find((a) => a.id === b.mechanism);
    if (!a) throw new EngineError("Choose an available craft mechanism.");
    const candidate = candidateProfile(store, config, a.id);
    const eid = createExperiment(
      store,
      owner(req).id,
      {
        plan: {
          evaluationPhase: b.evaluationPhase,
          title: a.title,
          hypothesis: a.amendment,
          risk: a.risk,
          lane: b.lane,
          candidateHash: candidate.hash,
          caseIds: (b.lane === "art"
            ? artCases
            : b.evaluationPhase === "release"
              ? heldOutCases
              : cases
          ).map((c) => c.id),
          replicates: b.replicates,
          mode: b.mode,
          criterion: b.lane === "book" ? "whole_book" : a.criterion,
          principleIds: [a.principle],
          prerequisiteIds: b.prerequisiteIds,
        },
        maxCents: b.maxCents,
        authorizeCosts: b.authorizeCosts,
      },
      config,
    );
    res.status(201).json({ id: eid });
  });
  const owned = (req: Request) => {
    const e = experiment(store, String(req.params.id));
    if (e.ownerId !== owner(req).id)
      throw new EngineError("This experiment belongs to another operator.");
    return e;
  };
  app.post("/api/lab/experiments/:id/start", auth, operator, (req, res) => {
    const e = owned(req),
      plan = parsePlan(e);
    if (plan.mode === "live" && (!config.enabled || !config.apiKey))
      throw new EngineError(
        "Connect the provider before starting a live experiment.",
      );
    if (!["planned", "paused"].includes(e.status))
      throw new EngineError(
        "This experiment is already running or has stopped.",
      );
    res.status(202).json({ started: true });
    void runExperiment(
      store,
      e.id,
      new OpenAIProvider({ ...config, budgetCents: e.maxCents }),
      config,
    ).catch(() => {
      store.run(
        "UPDATE lab_experiments SET error='Could not resume this frozen comparison. Check its code version and provider configuration.' WHERE id=?",
        e.id,
      );
    });
  });
  app.post("/api/lab/experiments/:id/pause", auth, operator, (req, res) => {
    const e = owned(req);
    pauseExperiment(store, e.id);
    res.json({ paused: true });
  });
  app.post(
    "/api/lab/experiments/:id/observations",
    auth,
    operator,
    (req, res) => {
      const e = owned(req);
      addObservation(store, e.id, req.body);
      res.json({ saved: true });
    },
  );
  app.get("/api/lab/experiments/:id/evidence", auth, operator, (req, res) => {
    const e = owned(req);
    if (parsePlan(e).evaluationPhase === "release") {
      res.json(experimentReport(store, e.id));
      return;
    }
    res.json({
      experiment: e,
      comparisons: store.all(
        "SELECT pairKey,body FROM lab_comparisons WHERE experimentId=?",
        e.id,
      ),
      runEvidence: store.all(
        "SELECT studio_steps.* FROM studio_steps JOIN lab_runs ON lab_runs.jobId=studio_steps.jobId WHERE lab_runs.experimentId=?",
        e.id,
      ),
    });
  });
  app.get("/api/lab/experiments/:id/report", auth, operator, (req, res) => {
    res.json(experimentReport(store, owned(req).id));
  });
  app.post("/api/lab/releases/:id/rollback", auth, operator, (req, res) => {
    rollback(store, String(req.params.id));
    res.json({ restored: true });
  });
}
