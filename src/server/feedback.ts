import type { DatabaseSync } from "node:sqlite";
import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import { AccessError, requireOperator } from "./access.js";
import { canonical, hash, id, now, type Store } from "./store.js";

const contextSchema = z.object({
  revision: z.coerce.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  editionId: z.string().min(1).max(100).optional(),
});
const answerSchema = contextSchema.extend({
  key: z.string().min(1).max(100),
  version: z.number().int().nonnegative(),
  overall: z.enum(["loved_it", "good_start", "needs_work"]),
  text: z.string().trim().max(2000).default(""),
});
type Context = z.infer<typeof contextSchema>;
export interface BookFeedbackRecord {
  id: string;
  schemaVersion: 1;
  evidenceKind: "adult_feedback";
  projectId: string;
  revision: number;
  contentHash: string;
  editionId: string | null;
  pdfHash: string | null;
  overall: "loved_it" | "good_start" | "needs_work";
  text: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
type FeedbackRow = BookFeedbackRecord & { ownerId: string };

export function migrateFeedback(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_feedback(
      id TEXT PRIMARY KEY,
      schemaVersion INTEGER NOT NULL,
      evidenceKind TEXT NOT NULL,
      ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      contentHash TEXT NOT NULL,
      editionId TEXT REFERENCES editions(id) ON DELETE SET NULL,
      pdfHash TEXT,
      overall TEXT NOT NULL CHECK(overall IN ('loved_it','good_start','needs_work')),
      text TEXT NOT NULL,
      version INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(ownerId,projectId,revision)
    );
    CREATE TABLE IF NOT EXISTS book_feedback_receipts(
      ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      requestHash TEXT NOT NULL,
      result TEXT NOT NULL,
      PRIMARY KEY(ownerId,key)
    );
    CREATE INDEX IF NOT EXISTS book_feedback_recent ON book_feedback(updatedAt DESC,id);
  `);
}

function ownedContext(
  s: Store,
  ownerId: string,
  projectId: string,
  input: Context,
) {
  if (
    !s.one(
      "SELECT id FROM projects WHERE id=? AND ownerId=?",
      projectId,
      ownerId,
    )
  )
    throw new AccessError(404, "That book could not be found.");
  // Research evidence has its own frozen review records. This endpoint cannot
  // expose held-out books through an alternative feedback/report surface.
  if (s.one("SELECT id FROM lab_runs WHERE projectId=?", projectId))
    throw new AccessError(404, "That book could not be found.");
  const revision = s.one<{ contentHash: string }>(
    "SELECT contentHash FROM revisions WHERE projectId=? AND revision=?",
    projectId,
    input.revision,
  );
  if (!revision || revision.contentHash !== input.contentHash)
    throw new AccessError(409, "Reopen this book before saving your feedback.");
  if (!input.editionId) return null;
  const edition = s.one<{ pdfHash: string }>(
    "SELECT pdfHash FROM editions WHERE id=? AND projectId=? AND revision=? AND contentHash=?",
    input.editionId,
    projectId,
    input.revision,
    input.contentHash,
  );
  if (!edition)
    throw new AccessError(404, "That saved edition could not be found.");
  return edition;
}
function view(row: FeedbackRow | undefined): BookFeedbackRecord | null {
  if (!row) return null;
  // Owner IDs are needed in the operator report, never in the family response.
  const { ownerId: _ownerId, ...record } = row;
  void _ownerId;
  return record;
}
export function readBookFeedback(
  s: Store,
  ownerId: string,
  projectId: string,
  input: unknown,
) {
  const context = contextSchema.parse(input);
  ownedContext(s, ownerId, projectId, context);
  return {
    feedback: view(
      s.one<FeedbackRow>(
        "SELECT * FROM book_feedback WHERE ownerId=? AND projectId=? AND revision=?",
        ownerId,
        projectId,
        context.revision,
      ),
    ),
  };
}
export function saveBookFeedback(
  s: Store,
  ownerId: string,
  projectId: string,
  input: unknown,
) {
  const answer = answerSchema.parse(input);
  return s.transaction(() => {
    const edition = ownedContext(s, ownerId, projectId, answer);
    const requestHash = hash(canonical({ projectId, ...answer }));
    const receipt = s.one<{ requestHash: string; result: string }>(
      "SELECT requestHash,result FROM book_feedback_receipts WHERE ownerId=? AND key=?",
      ownerId,
      answer.key,
    );
    if (receipt) {
      if (receipt.requestHash !== requestHash)
        throw new AccessError(
          409,
          "This feedback request has already been used. Reopen the feedback form.",
        );
      return JSON.parse(receipt.result) as { feedback: BookFeedbackRecord };
    }
    const existing = s.one<FeedbackRow>(
      "SELECT * FROM book_feedback WHERE ownerId=? AND projectId=? AND revision=?",
      ownerId,
      projectId,
      answer.revision,
    );
    if ((existing?.version ?? 0) !== answer.version)
      throw new AccessError(
        409,
        "Your feedback changed in another window. Reopen the form to see the saved response.",
      );
    const date = now();
    const record: FeedbackRow = {
      id: existing?.id ?? id(),
      schemaVersion: 1,
      evidenceKind: "adult_feedback",
      ownerId,
      projectId,
      revision: answer.revision,
      contentHash: answer.contentHash,
      editionId: answer.editionId ?? existing?.editionId ?? null,
      pdfHash: edition?.pdfHash ?? existing?.pdfHash ?? null,
      overall: answer.overall,
      text: answer.text,
      version: answer.version + 1,
      createdAt: existing?.createdAt ?? date,
      updatedAt: date,
    };
    s.run(
      `INSERT INTO book_feedback VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(ownerId,projectId,revision) DO UPDATE SET
      editionId=excluded.editionId,pdfHash=excluded.pdfHash,overall=excluded.overall,
      text=excluded.text,version=excluded.version,updatedAt=excluded.updatedAt`,
      record.id,
      record.schemaVersion,
      record.evidenceKind,
      record.ownerId,
      record.projectId,
      record.revision,
      record.contentHash,
      record.editionId,
      record.pdfHash,
      record.overall,
      record.text,
      record.version,
      record.createdAt,
      record.updatedAt,
    );
    const result = { feedback: view(record)! };
    s.run(
      "INSERT INTO book_feedback_receipts VALUES(?,?,?,?,?)",
      ownerId,
      answer.key,
      projectId,
      requestHash,
      JSON.stringify(result),
    );
    return result;
  });
}
export function bookFeedbackReport(
  s: Store,
  ownerId: string,
  input: unknown = {},
) {
  requireOperator(s, ownerId);
  const { limit, offset } = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    })
    .parse(input);
  return {
    schemaVersion: 1,
    evidenceKind: "adult_feedback",
    note: "Optional adult feedback. Responses are not evidence of observed child engagement or a representative survey.",
    counts: s.all<{ overall: string; count: number }>(
      "SELECT overall,COUNT(*) AS count FROM book_feedback f WHERE NOT EXISTS(SELECT 1 FROM lab_runs r WHERE r.projectId=f.projectId) GROUP BY overall ORDER BY overall",
    ),
    total: s.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM book_feedback f WHERE NOT EXISTS(SELECT 1 FROM lab_runs r WHERE r.projectId=f.projectId)",
    )!.count,
    limit,
    offset,
    responses: s.all<FeedbackRow>(
      "SELECT f.* FROM book_feedback f WHERE NOT EXISTS(SELECT 1 FROM lab_runs r WHERE r.projectId=f.projectId) ORDER BY updatedAt DESC,id LIMIT ? OFFSET ?",
      limit,
      offset,
    ),
  };
}

export function installFeedbackRoutes(
  app: Express,
  s: Store,
  options: {
    auth: RequestHandler;
    owner: (req: Request) => { id: string };
    operatorGuard: RequestHandler;
  },
) {
  migrateFeedback(s.db);
  const send = (res: import("express").Response, action: () => unknown) => {
    try {
      res.json(action());
    } catch (error) {
      res
        .status(
          error instanceof AccessError
            ? error.status
            : error instanceof z.ZodError
              ? 400
              : 500,
        )
        .json({
          error:
            error instanceof AccessError
              ? error.message
              : error instanceof z.ZodError
                ? "Choose a response and keep any note to 2,000 characters."
                : "Your feedback could not be saved. Please try again.",
        });
    }
  };
  app.get("/api/projects/:id/feedback", options.auth, (req, res) =>
    send(res, () =>
      readBookFeedback(
        s,
        options.owner(req).id,
        String(req.params.id),
        req.query,
      ),
    ),
  );
  app.post("/api/projects/:id/feedback", options.auth, (req, res) =>
    send(res, () =>
      saveBookFeedback(
        s,
        options.owner(req).id,
        String(req.params.id),
        req.body,
      ),
    ),
  );
  app.get("/api/operator/feedback", options.operatorGuard, (req, res) =>
    send(res, () => bookFeedbackReport(s, options.owner(req).id, req.query)),
  );
}
