import { id, now, type Store } from "../store.js";

export class StudioPreDispatchPause extends Error {
  readonly preDispatch = true;
  checkpointRecorded = false;
  constructor(
    message: string,
    readonly reason: "pause" | "budget" | "request_cost" = "request_cost",
    readonly requiredCents: number | null = null,
  ) {
    super(message);
  }
}

export interface StudioCheckpoint {
  id: string;
  jobId: string;
  stage: string;
  inputHash: string;
  reason: string;
  message: string;
  requiredCents: number | null;
  createdAt: string;
  resumedAt: string | null;
}

export function ensureStudioBudgetRecords(store: Store) {
  store.run("CREATE TABLE IF NOT EXISTS studio_request_estimates(callId TEXT PRIMARY KEY REFERENCES studio_calls(id) ON DELETE CASCADE,body TEXT NOT NULL)");
  store.run(
    "CREATE TABLE IF NOT EXISTS studio_request_bounds(callId TEXT PRIMARY KEY REFERENCES studio_calls(id) ON DELETE CASCADE,body TEXT NOT NULL)",
  );
  store.run(
    "CREATE TABLE IF NOT EXISTS studio_metered_costs(callId TEXT PRIMARY KEY REFERENCES studio_calls(id) ON DELETE CASCADE,body TEXT NOT NULL)",
  );
  store.run(
    "CREATE TABLE IF NOT EXISTS studio_checkpoints(id TEXT PRIMARY KEY,jobId TEXT NOT NULL REFERENCES studio_jobs(id) ON DELETE CASCADE,stage TEXT NOT NULL,inputHash TEXT NOT NULL,reason TEXT NOT NULL,message TEXT NOT NULL,requiredCents INTEGER,createdAt TEXT NOT NULL,resumedAt TEXT)",
  );
  store.run(
    "CREATE TABLE IF NOT EXISTS studio_pause_requests(jobId TEXT PRIMARY KEY REFERENCES studio_jobs(id) ON DELETE CASCADE,requestedAt TEXT NOT NULL)",
  );
}

// Safe for an operator command while the worker is inside a provider request.
// It does not interrupt an uncertain request; the next dispatch is stopped.
export function requestStudioPause(store: Store, jobId: string) {
  ensureStudioBudgetRecords(store);
  const job = store.one<{ status: string }>(
    "SELECT status FROM studio_jobs WHERE id=? AND kind!='lab'",
    jobId,
  );
  if (!job || !["queued", "running"].includes(job.status))
    throw new Error("Only an active family story can be paused.");
  store.run(
    "INSERT OR IGNORE INTO studio_pause_requests VALUES(?,?)",
    jobId,
    now(),
  );
  return { jobId, requested: true };
}

export function studioPauseRequested(store: Store, jobId: string) {
  ensureStudioBudgetRecords(store);
  return !!store.one(
    "SELECT jobId FROM studio_pause_requests WHERE jobId=?",
    jobId,
  );
}

export function recordStudioCheckpoint(
  store: Store,
  jobId: string,
  stage: string,
  inputHash: string,
  error: StudioPreDispatchPause,
) {
  ensureStudioBudgetRecords(store);
  store.run(
    "INSERT INTO studio_checkpoints VALUES(?,?,?,?,?,?,?,?,NULL)",
    id(),
    jobId,
    stage,
    inputHash,
    error.reason,
    error.message,
    error.requiredCents,
    now(),
  );
  store.run("UPDATE studio_jobs SET stage=? WHERE id=?", stage, jobId);
}

export function pendingStudioCheckpoint(
  store: Store,
  jobId: string,
  stage: string,
) {
  ensureStudioBudgetRecords(store);
  return store.one<StudioCheckpoint>(
    "SELECT * FROM studio_checkpoints WHERE jobId=? AND stage=? AND resumedAt IS NULL ORDER BY rowid DESC LIMIT 1",
    jobId,
    stage,
  );
}

// A job's allowance remains its bounded execution ceiling. The budget ledger
// holds future work only while that job is active or at a resumable review gate.
// Stopped/finished jobs retain estimates for every potentially billed attempt.
export function settleStudioReservations(store: Store) {
  store.run(`UPDATE engine_budget SET allowance=(
    SELECT COALESCE(SUM(estimatedCents),0) FROM studio_calls
    WHERE jobId=engine_budget.runId AND status!='rejected'
  ) WHERE runId IN (
    SELECT id FROM studio_jobs WHERE status IN ('needs_attention','needs_editor','complete','superseded')
  )`);
}
export function reservedBudget(store: Store) {
  settleStudioReservations(store);
  return store.one<{ total: number }>(
    "SELECT COALESCE(SUM(allowance),0) AS total FROM engine_budget",
  )!.total;
}
