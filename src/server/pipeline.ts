import { isRecoveryLocked } from "./recovery-lock.js";
import { Book, type BookDocument } from "../shared/contracts.js";
import { sampleBook } from "../shared/fixture.js";
import { artSvg } from "../shared/art.js";
import {
  canonical,
  hash,
  id,
  type Store,
  type JobRow,
  type ProjectRow,
} from "./store.js";
import { finalizeBook } from "./layout.js";

export function queueSample(store: Store, project: ProjectRow) {
  if (project.mode !== "synthetic_fixture")
    throw new Error(
      "Live providers are unavailable. A recording cannot use the sample pipeline.",
    );
  const inputHash = hash(
    canonical({
      source: sampleBook().transcript,
      pipeline: "sample-v1",
      baseRevision: project.revision,
    }),
  );
  const existing = store.one<{ id: string }>(
    "SELECT id FROM jobs WHERE projectId=? AND inputHash=?",
    project.id,
    inputHash,
  );
  if (existing) return existing.id;
  const jobId = id();
  store.transaction(() => {
    store.run(
      "INSERT INTO jobs(id,projectId,inputHash,baseRevision,status,stage) VALUES(?,?,?,?,?,?)",
      jobId,
      project.id,
      inputHash,
      project.revision,
      "queued",
      "ledger",
    );
    store.run("UPDATE projects SET status='composing' WHERE id=?", project.id);
  });
  return jobId;
}
export async function runOneJob(
  store: Store,
  options: {
    failAfterScene?: number;
    onStage?: (stage: string) => void;
    clock?: () => number;
  } = {},
) {
  if (isRecoveryLocked(store)) return false;
  const clock = options.clock ?? Date.now;
  // A crash on the last allowed attempt must become actionable, never spin forever.
  store.transaction(() => {
    const exhausted = store.all<JobRow>(
      "SELECT * FROM jobs WHERE status='running' AND leaseUntil<? AND attempt>=3",
      clock(),
    );
    for (const row of exhausted) {
      store.run(
        "UPDATE jobs SET status='retryable_failure',error=?,leaseUntil=0 WHERE id=?",
        "Three attempts stopped before completion. Your completed pages are safe; developer review is needed.",
        row.id,
      );
      store.run(
        "UPDATE projects SET status='needs_attention' WHERE id=? AND revision=?",
        row.projectId,
        row.baseRevision,
      );
    }
  });
  const job = store.transaction(() => {
    const row = store.one<JobRow>(
      "SELECT * FROM jobs WHERE (status='queued' OR (status='running' AND leaseUntil<?)) AND attempt<3 ORDER BY rowid LIMIT 1",
      clock(),
    );
    if (!row) return null;
    const leaseToken = id();
    store.run(
      "UPDATE jobs SET status='running',attempt=attempt+1,leaseUntil=?,leaseToken=?,error=NULL WHERE id=?",
      clock() + 60000,
      leaseToken,
      row.id,
    );
    return { ...row, leaseToken };
  });
  if (!job) return false;
  const ownsLease = () =>
    !!store.one(
      "SELECT id FROM jobs WHERE id=? AND leaseToken=? AND status='running'",
      job.id,
      job.leaseToken,
    );
  async function stage<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    if (!ownsLease()) throw new Error("Lease lost");
    const prior = store.one<{ result: string }>(
      "SELECT result FROM stage_results WHERE jobId=? AND stage=?",
      job!.id,
      name,
    );
    if (prior) return JSON.parse(prior.result) as T;
    store.run(
      "UPDATE jobs SET stage=?,leaseUntil=? WHERE id=? AND leaseToken=?",
      name,
      clock() + 60000,
      job!.id,
      job!.leaseToken,
    );
    options.onStage?.(name);
    const result = await fn();
    if (!ownsLease()) throw new Error("Lease lost");
    store.run(
      "INSERT OR IGNORE INTO stage_results VALUES(?,?,?)",
      job!.id,
      name,
      JSON.stringify(result),
    );
    return result;
  }
  try {
    const project = store.one<ProjectRow>(
      "SELECT * FROM projects WHERE id=?",
      job.projectId,
    );
    if (
      !project ||
      project.mode !== "synthetic_fixture" ||
      project.revision !== job.baseRevision
    )
      throw new Error("Stale or unavailable project");
    const book = sampleBook();
    book.revision = job.baseRevision + 1;
    book.ledger = await stage("ledger", () => book.ledger);
    book.spreads = await stage("manuscript", () => book.spreads);
    for (let i = 0; i < 12; i++) {
      book.spreads[i].artHash = await stage(`illustration-${i + 1}`, () => {
        if (options.failAfterScene === i)
          throw new Error("Injected illustration failure");
        return store.putAsset(project.id, artSvg(i), "art");
      });
    }
    const final = await stage("layout", () => finalizeBook(book));
    store.transaction(() => {
      const current = store.one<ProjectRow>(
        "SELECT * FROM projects WHERE id=?",
        job.projectId,
      );
      if (!ownsLease() || !current || current.revision !== job.baseRevision)
        throw new Error("Stale or unavailable project");
      store.run(
        "INSERT INTO revisions VALUES(?,?,?,?)",
        project.id,
        final.revision,
        JSON.stringify(final),
        final.contentHash,
      );
      store.run(
        "UPDATE projects SET title=?,revision=?,status='ready_for_review',transcript=? WHERE id=?",
        final.title,
        final.revision,
        JSON.stringify(final.transcript),
        project.id,
      );
      store.run(
        "UPDATE jobs SET status='succeeded',stage='complete',leaseUntil=0 WHERE id=? AND leaseToken=?",
        job.id,
        job.leaseToken,
      );
    });
  } catch (error) {
    if (ownsLease()) {
      const message =
        error instanceof Error &&
        error.message === "Stale or unavailable project"
          ? "This work belongs to an older revision."
          : "Book making stopped. Completed pages are safe; retry to continue.";
      store.run(
        "UPDATE jobs SET status='retryable_failure',error=?,leaseUntil=0 WHERE id=? AND leaseToken=?",
        message,
        job.id,
        job.leaseToken,
      );
      store.run(
        "UPDATE projects SET status='needs_attention' WHERE id=? AND revision=?",
        job.projectId,
        job.baseRevision,
      );
    }
  }
  return true;
}
export async function renamePerson(
  book: BookDocument,
  personId: string,
  newName: string,
) {
  const next = structuredClone(book),
    person = next.people.find((p) => p.id === personId);
  if (!person) throw new Error("Person not found");
  const oldName = person.name;
  // Token boundaries avoid changing Ann inside Annie; raw source remains immutable.
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, "gu");
  const replace = (s: string) => s.replace(pattern, () => newName);
  person.name = newName;
  next.title = replace(next.title);
  next.byline = replace(next.byline);
  if (next.adaptation) {
    next.adaptation.emotionalInheritance = replace(
      next.adaptation.emotionalInheritance,
    );
    next.adaptation.premise = replace(next.adaptation.premise);
    next.adaptation.inventions = next.adaptation.inventions.map(replace);
  }
  for (const claim of next.ledger)
    if (pattern.test(claim.text)) {
      pattern.lastIndex = 0;
      claim.text = replace(claim.text);
      claim.certainty = "clarified";
      claim.clarification = `Owner corrected ${oldName} to ${newName}. Original source retained.`;
    }
  for (const spread of next.spreads) {
    spread.text = replace(spread.text);
    spread.artDescription = replace(spread.artDescription);
  }
  next.revision++;
  return finalizeBook(Book.parse(next));
}
