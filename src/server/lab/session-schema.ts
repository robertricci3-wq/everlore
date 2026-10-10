import { Store, id } from "../store.js";
import { EngineError } from "../engine/pipeline.js";

export const SESSION_LEASE_MS = 60_000;

export function ensureSessionSchema(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS lab_session_leases(
      slot INTEGER PRIMARY KEY CHECK(slot=1), sessionId TEXT NOT NULL REFERENCES lab_sessions(id),
      token TEXT NOT NULL, expiresAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lab_session_requests(
      ownerId TEXT NOT NULL REFERENCES users(id), requestKey TEXT NOT NULL,
      inputHash TEXT NOT NULL, sessionId TEXT NOT NULL REFERENCES lab_sessions(id),
      PRIMARY KEY(ownerId,requestKey)
    );
    CREATE TABLE IF NOT EXISTS lab_session_experiments(
      sessionId TEXT NOT NULL REFERENCES lab_sessions(id), iteration INTEGER NOT NULL,
      phase TEXT NOT NULL, experimentId TEXT NOT NULL UNIQUE, request TEXT,
      createdAt TEXT NOT NULL, PRIMARY KEY(sessionId,iteration,phase)
    );
  `);
}

export function acquireSessionLease(
  store: Store,
  sessionId: string,
  at = Date.now(),
) {
  ensureSessionSchema(store);
  return store.transaction(() => {
    const current = store.one<{ expiresAt: number }>(
      "SELECT expiresAt FROM lab_session_leases WHERE slot=1",
    );
    if (current && current.expiresAt > at)
      throw new EngineError(
        "A quality session is already running in this store. Resume after it pauses or its lease expires.",
      );
    const token = id();
    store.run(
      "INSERT INTO lab_session_leases VALUES(1,?,?,?) ON CONFLICT(slot) DO UPDATE SET sessionId=excluded.sessionId,token=excluded.token,expiresAt=excluded.expiresAt",
      sessionId,
      token,
      at + SESSION_LEASE_MS,
    );
    return token;
  });
}

export function ownsSessionLease(
  store: Store,
  sessionId: string,
  token: string,
  at = Date.now(),
) {
  return !!store.one(
    "SELECT slot FROM lab_session_leases WHERE slot=1 AND sessionId=? AND token=? AND expiresAt>?",
    sessionId,
    token,
    at,
  );
}

export function renewSessionLease(
  store: Store,
  sessionId: string,
  token: string,
) {
  const at = Date.now();
  return (
    store.run(
      "UPDATE lab_session_leases SET expiresAt=? WHERE slot=1 AND sessionId=? AND token=? AND expiresAt>?",
      at + SESSION_LEASE_MS,
      sessionId,
      token,
      at,
    ).changes === 1
  );
}

export function releaseSessionLease(
  store: Store,
  sessionId: string,
  token: string,
) {
  store.run(
    "DELETE FROM lab_session_leases WHERE slot=1 AND sessionId=? AND token=?",
    sessionId,
    token,
  );
}
