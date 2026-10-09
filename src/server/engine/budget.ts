import type { Store } from "../store.js";

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
