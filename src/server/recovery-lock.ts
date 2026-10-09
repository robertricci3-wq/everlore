import { now, type Store } from "./store.js";

export function isRecoveryLocked(store: Store) {
  return !!store.one("SELECT id FROM recovery_locks WHERE releasedAt IS NULL");
}

/** Explicit operational acknowledgement, never a creative approval gate. */
export function releaseRecoveryLock(store: Store, evidence: string) {
  if (evidence.trim().length < 20)
    throw new Error("Record the provider reconciliation evidence before releasing recovery.");
  if (!isRecoveryLocked(store)) throw new Error("No restore recovery lock is active.");
  store.run("UPDATE recovery_locks SET releasedAt=?,evidence=? WHERE releasedAt IS NULL", now(), evidence.trim());
}
