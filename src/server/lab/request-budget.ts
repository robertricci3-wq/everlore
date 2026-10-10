import { EngineError } from "../engine/pipeline.js";
import type { RequestCostBound } from "../engine/request-cost.js";
import { now, type Store } from "../store.js";

/** A durable, safe-to-resume stop. No request is sent when this is raised. */
export class LabRequestPause extends EngineError {
  readonly preDispatch = true;
  constructor(
    message: string,
    readonly reason: "pause" | "budget" | "request_cost" = "request_cost",
    readonly requiredCents: number | null = null,
  ) {
    super(message);
  }
}

export function ensureLabRequestRecords(store: Store) {
  store.run(
    "CREATE TABLE IF NOT EXISTS lab_request_bounds(callId TEXT PRIMARY KEY REFERENCES lab_calls(id),body TEXT NOT NULL)",
  );
  store.run(
    "CREATE TABLE IF NOT EXISTS lab_metered_costs(callId TEXT PRIMARY KEY REFERENCES lab_calls(id),body TEXT NOT NULL)",
  );
  store.run(
    "CREATE TABLE IF NOT EXISTS lab_request_checkpoints(runId TEXT NOT NULL REFERENCES lab_runs(id),stage TEXT NOT NULL,inputHash TEXT NOT NULL,reason TEXT NOT NULL,message TEXT NOT NULL,requiredCents INTEGER,createdAt TEXT NOT NULL,resumedAt TEXT,PRIMARY KEY(runId,stage,inputHash))",
  );
}

export function validateLabRequestBound(
  bound: RequestCostBound,
  kind: "text" | "image",
  model: string,
) {
  if (
    bound.version !== 1 ||
    bound.kind !== kind ||
    bound.model !== model ||
    !bound.rateCardVersion ||
    !Number.isSafeInteger(bound.maxCostCents) ||
    bound.maxCostCents <= 0 ||
    !bound.evidence ||
    !Object.keys(bound.evidence).length ||
    Object.values(bound.evidence).some((v) => !Number.isFinite(v) || v < 0)
  )
    throw new LabRequestPause(
      "The next Lab request has no valid conservative cost bound. No request was sent.",
    );
}

export function recordLabRequestCheckpoint(
  store: Store,
  runId: string,
  stage: string,
  inputHash: string,
  error: LabRequestPause,
) {
  store.run(
    "INSERT INTO lab_request_checkpoints VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(runId,stage,inputHash) DO UPDATE SET reason=excluded.reason,message=excluded.message,requiredCents=excluded.requiredCents,resumedAt=NULL",
    runId,
    stage,
    inputHash,
    error.reason,
    error.message,
    error.requiredCents,
    now(),
  );
  store.run("UPDATE lab_runs SET stage=? WHERE id=?", stage, runId);
}
