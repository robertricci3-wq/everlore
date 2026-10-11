import { z } from "zod";
import { requireOperator } from "../access.js";
import { canonical, hash, id, now, type Store } from "../store.js";
import { EngineError } from "./pipeline.js";
export const DigitalReviewCopyAuthorization = z.object({
  id:z.string(),actorId:z.string(),approvedAt:z.string(),baseRevision:z.number().int(),
  manuscriptHash:z.string().length(64),artHashes:z.array(z.string().length(64)).length(12),
  scope:z.literal("digital_feedback_only"),reason:z.string().min(10),
});
export function authorizeDigitalReviewCopy(store:Store,jobId:string,actorId:string,reason:string){
 requireOperator(store,actorId);
 return store.transaction(()=>{
  const job=store.one<{status:string;stage:string;projectId:string;baseRevision:number}>("SELECT status,stage,projectId,baseRevision FROM studio_jobs WHERE id=?",jobId);
  if(!job||job.status!=="needs_editor"||!["whole_book_sequence_review_v2","whole_book_sequence_meaning_v3"].includes(job.stage))throw new EngineError("A completed sequence review is required.");
  if(store.one<{revision:number}>("SELECT revision FROM projects WHERE id=?",job.projectId)?.revision!==job.baseRevision||store.one("SELECT id FROM studio_jobs WHERE projectId=? AND rowid>(SELECT rowid FROM studio_jobs WHERE id=?)",job.projectId,jobId))throw new EngineError("A newer book exists.");
  const read=(stage:string)=>{const r=store.one<{result:string}>("SELECT result FROM studio_steps WHERE jobId=? AND stage=? AND state='completed'",jobId,stage);return r?JSON.parse(r.result):null;};
  const accepted=read("accepted_story");
  if(!accepted?.verdict||accepted.verdict.heartFailures.length||accepted.verdict.mechanical.length)throw new EngineError("Protected story and structure must pass.");
  const artHashes=Array.from({length:12},(_,i)=>read(`accepted_picture_meaning_v2_${i+1}`)??read(`authorized_picture_v1_${i+1}`)??read(`authorized_picture_scope_v1_${i+1}`));
  if(artHashes.some(h=>typeof h!=="string")||new Set(artHashes).size!==12)throw new EngineError("Twelve distinct accepted illustrations are required.");
  for(const digest of artHashes)store.readAsset(job.projectId,digest);
  const stage="digital_review_copy_authorization_v1",existing=read(stage);
  if(existing)return DigitalReviewCopyAuthorization.parse(existing);
  const record=DigitalReviewCopyAuthorization.parse({id:id(),actorId,approvedAt:now(),baseRevision:job.baseRevision,manuscriptHash:hash(canonical(accepted.manuscript)),artHashes,scope:"digital_feedback_only",reason});
  store.run("INSERT INTO studio_steps VALUES(?,?,?,'completed',?)",jobId,stage,hash(canonical(record)),canonical(record));
  return record;
 });
}
