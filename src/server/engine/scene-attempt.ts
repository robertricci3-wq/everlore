import { z } from "zod";
import { requireOperator } from "../access.js";
import { canonical, hash, now, type Store } from "../store.js";
import { EngineError } from "./pipeline.js";

export const SceneAttemptAuthorization = z.object({
  version: z.literal(1), spread: z.number().int().min(1).max(12),
  baseRevision: z.number().int(), actorId: z.string().min(1),
  instruction: z.string().min(20), priorHash: z.string().length(64),
  authorizedAt: z.string(), maxAttempts: z.literal(1),
});
export function authorizeSceneAttempt(store: Store, jobId: string, actorId: string, spread: number, instruction: string) {
  requireOperator(store, actorId);
  return store.transaction(() => {
    const job = store.one<{ projectId: string; baseRevision: number; status: string }>("SELECT projectId,baseRevision,status FROM studio_jobs WHERE id=?", jobId);
    if (!job || job.status !== "needs_editor") throw new EngineError("A paused illustration is required.");
    const project = store.one<{ revision: number }>("SELECT revision FROM projects WHERE id=?", job.projectId);
    if (project?.revision !== job.baseRevision || store.one("SELECT id FROM studio_jobs WHERE projectId=? AND rowid>(SELECT rowid FROM studio_jobs WHERE id=?)", job.projectId, jobId)) throw new EngineError("A newer book exists.");
    const read = (stage: string) => store.one<{ result: string }>("SELECT result FROM studio_steps WHERE jobId=? AND stage=? AND state='completed'", jobId, stage);
    if (read(`accepted_picture_meaning_v2_${spread}`)?.result !== "null") throw new EngineError("Only an exhausted illustration can receive this exception.");
    const prior = read(`picture_${spread}_attempt_3`);
    if (!prior) throw new EngineError("Three retained attempts are required.");
    const stage = `scene_attempt_authorization_v1_${spread}`;
    const existing = read(stage);
    if (existing) {
      const saved = SceneAttemptAuthorization.parse(JSON.parse(existing.result));
      if (saved.actorId !== actorId || saved.instruction !== instruction) throw new EngineError("This one-attempt authorization is immutable.");
      return saved;
    }
    const record = SceneAttemptAuthorization.parse({version:1, spread, baseRevision:job.baseRevision, actorId, instruction, priorHash:JSON.parse(prior.result), authorizedAt:now(), maxAttempts:1});
    store.run("INSERT INTO studio_steps VALUES(?,?,?,'completed',?)", jobId, stage, hash(canonical(record)), canonical(record));
    return record;
  });
}
