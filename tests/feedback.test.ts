import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { hash, now, Store } from "../src/server/store.js";
import { AccessError, setOperator } from "../src/server/access.js";
import { createBackup, restoreBackup } from "../src/server/backup.js";
import {
  installFeedbackRoutes,
  migrateFeedback,
  readBookFeedback,
  saveBookFeedback,
  bookFeedbackReport,
} from "../src/server/feedback.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "everlore-feedback-"));
  const store = new Store(directory);
  migrateFeedback(store.db);
  migrateFeedback(store.db);
  for (const owner of ["owner", "other", "operator"]) {
    store.run(
      "INSERT INTO users VALUES(?,?,?,?,?)",
      owner,
      owner,
      "unused",
      "private",
      now(),
    );
    store.run(
      "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
      `${owner}-book`,
      owner,
      "A synthetic book",
      "synthetic_fixture",
      "complete",
      1,
      "PRIVATE SOURCE RECORDING TRANSCRIPT",
      now(),
      now(),
    );
    store.run(
      "INSERT INTO revisions VALUES(?,?,?,?)",
      `${owner}-book`,
      1,
      JSON.stringify({ title: "A synthetic book", source: "PRIVATE SOURCE" }),
      hash(`${owner}-book`),
    );
    store.run(
      "INSERT INTO editions VALUES(?,?,?,?,?,?,?)",
      `${owner}-edition`,
      `${owner}-book`,
      1,
      hash(`${owner}-book`),
      hash(`${owner}-pdf`),
      "IMMUTABLE EDITION BYTES",
      now(),
    );
  }
  setOperator(store, "operator");
  const context = {
    revision: 1,
    contentHash: hash("owner-book"),
    editionId: "owner-edition",
  };
  const answer = {
    ...context,
    key: "first-response",
    version: 0,
    overall: "good_start",
    text: "The pictures feel like us.",
  };
  return {
    store,
    context,
    answer,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("optional feedback is owner-scoped, versioned, and never mutates a book, edition, source or generation job", () => {
  const t = fixture();
  try {
    const before = t.store.all("SELECT * FROM editions");
    const books = t.store.all("SELECT * FROM revisions");
    const sources = t.store.all("SELECT transcript FROM projects");
    assert.deepEqual(
      readBookFeedback(t.store, "owner", "owner-book", t.context),
      { feedback: null },
    );
    const result = saveBookFeedback(
      t.store,
      "owner",
      "owner-book",
      t.answer,
    ).feedback;
    assert.equal(result.evidenceKind, "adult_feedback");
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.editionId, "owner-edition");
    assert.equal(result.pdfHash, hash("owner-pdf"));
    assert.equal(result.version, 1);
    assert.equal("ownerId" in result, false);
    assert.deepEqual(t.store.all("SELECT * FROM editions"), before);
    assert.deepEqual(t.store.all("SELECT * FROM revisions"), books);
    assert.deepEqual(t.store.all("SELECT transcript FROM projects"), sources);
    assert.equal(t.store.all("SELECT id FROM studio_jobs").length, 0);
    assert.equal(t.store.all("SELECT id FROM jobs").length, 0);
    assert.equal(t.store.all("SELECT id FROM studio_calls").length, 0);
    assert.throws(
      () => readBookFeedback(t.store, "other", "owner-book", t.context),
      { status: 404 },
    );
    assert.throws(
      () => saveBookFeedback(t.store, "other", "owner-book", t.answer),
      { status: 404 },
    );
  } finally {
    t.close();
  }
});

test("feedback retries recover their receipt without rolling a later edit backward", () => {
  const t = fixture();
  try {
    const first = saveBookFeedback(t.store, "owner", "owner-book", t.answer);
    assert.deepEqual(
      saveBookFeedback(t.store, "owner", "owner-book", t.answer),
      first,
    );
    const second = saveBookFeedback(t.store, "owner", "owner-book", {
      ...t.answer,
      key: "new-thought",
      version: 1,
      overall: "loved_it",
      text: "After another read, I loved the ending.",
    });
    assert.equal(second.feedback.id, first.feedback.id);
    assert.equal(second.feedback.version, 2);
    assert.deepEqual(
      saveBookFeedback(t.store, "owner", "owner-book", t.answer),
      first,
    );
    assert.equal(
      readBookFeedback(t.store, "owner", "owner-book", t.context).feedback
        ?.version,
      2,
    );
    assert.equal(t.store.all("SELECT id FROM book_feedback").length, 1);
    assert.throws(
      () =>
        saveBookFeedback(t.store, "owner", "owner-book", {
          ...t.answer,
          text: "Altered retry",
          version: 2,
        }),
      { status: 409 },
    );
    assert.throws(
      () =>
        saveBookFeedback(t.store, "owner", "owner-book", {
          ...t.answer,
          key: "stale-window",
          version: 1,
        }),
      { status: 409 },
    );
  } finally {
    t.close();
  }
});

test("a saved edition must belong to the same owner, book, revision and hash", () => {
  const t = fixture();
  try {
    for (const overrides of [
      { editionId: "other-edition" },
      { contentHash: hash("wrong") },
      { revision: 2 },
    ]) {
      assert.throws(
        () =>
          saveBookFeedback(t.store, "owner", "owner-book", {
            ...t.answer,
            ...overrides,
          }),
        AccessError,
      );
    }
    // An older displayed edition remains a valid feedback context after editing.
    t.store.run("UPDATE projects SET revision=2 WHERE id='owner-book'");
    t.store.run(
      "INSERT INTO revisions VALUES('owner-book',2,'new book',?)",
      hash("second-book"),
    );
    const saved = saveBookFeedback(t.store, "owner", "owner-book", t.answer);
    assert.equal(saved.feedback.revision, 1);
    const second = saveBookFeedback(t.store, "owner", "owner-book", {
      revision: 2,
      contentHash: hash("second-book"),
      key: "second-revision",
      version: 0,
      overall: "needs_work",
    });
    assert.equal(second.feedback.editionId, null);
    assert.equal(t.store.all("SELECT id FROM book_feedback").length, 2);
  } finally {
    t.close();
  }
});

test("operator reports retain adult feedback without exposing source material or presenting it as child response", () => {
  const t = fixture();
  try {
    saveBookFeedback(t.store, "owner", "owner-book", t.answer);
    assert.throws(() => bookFeedbackReport(t.store, "owner"), { status: 403 });
    const report = bookFeedbackReport(t.store, "operator", { limit: 1 });
    assert.equal(report.total, 1);
    assert.equal(report.responses[0].ownerId, "owner");
    assert.equal(report.evidenceKind, "adult_feedback");
    assert.match(report.note, /not evidence of observed child engagement/);
    assert.equal(JSON.stringify(report).includes("PRIVATE SOURCE"), false);
    assert.equal(
      JSON.stringify(report).includes("IMMUTABLE EDITION BYTES"),
      false,
    );
    assert.equal(
      bookFeedbackReport(t.store, "operator", { limit: 1, offset: 1 }).responses
        .length,
      0,
    );
    assert.throws(() =>
      saveBookFeedback(t.store, "owner", "owner-book", {
        ...t.answer,
        key: "long",
        text: "a".repeat(2001),
      }),
    );
    assert.throws(() =>
      saveBookFeedback(t.store, "owner", "owner-book", {
        ...t.answer,
        overall: "children_love_it",
      }),
    );
    t.store.deleteProject("owner-book");
    assert.equal(t.store.all("SELECT * FROM book_feedback").length, 0);
    assert.equal(t.store.all("SELECT * FROM book_feedback_receipts").length, 0);
    assert.equal(t.store.all("SELECT * FROM editions").length, 2);
  } finally {
    t.close();
  }
});

test("Lab books and any earlier feedback remain absent from family and operator feedback surfaces", () => {
  const t = fixture();
  try {
    saveBookFeedback(t.store, "owner", "owner-book", t.answer);
    t.store.run(
      "INSERT INTO lab_experiments(id,ownerId,plan,planHash,status,createdAt) VALUES('experiment','owner','{}',?,'complete',?)",
      hash("plan"),
      now(),
    );
    t.store.run(
      "INSERT INTO lab_runs(id,experimentId,caseId,replicate,arm,side,status,projectId) VALUES('release-run','experiment','held-out-case',1,'candidate','right','complete','owner-book')",
    );
    assert.throws(
      () => readBookFeedback(t.store, "owner", "owner-book", t.context),
      { status: 404 },
    );
    assert.throws(
      () => saveBookFeedback(t.store, "owner", "owner-book", t.answer),
      { status: 404 },
    );
    const report = bookFeedbackReport(t.store, "operator");
    assert.equal(report.total, 0);
    assert.deepEqual(report.counts, []);
    assert.deepEqual(report.responses, []);
    assert.equal(t.store.all("SELECT id FROM book_feedback").length, 1);
  } finally {
    t.close();
  }
});

test("application backup restores feedback and retry receipts without overwriting a later response", async () => {
  const t = fixture();
  const backupRoot = mkdtempSync(join(tmpdir(), "everlore-feedback-backup-"));
  let restored: Store | undefined;
  try {
    const first = saveBookFeedback(t.store, "owner", "owner-book", t.answer);
    const latest = saveBookFeedback(t.store, "owner", "owner-book", {
      ...t.answer,
      key: "updated",
      version: 1,
      overall: "loved_it",
      text: "I loved the family details.",
    });
    const editions = t.store.all("SELECT * FROM editions");
    const snapshot = join(backupRoot, "snapshot");
    await createBackup(t.store, snapshot);
    restoreBackup(snapshot, join(backupRoot, "restored"));
    restored = new Store(join(backupRoot, "restored"));
    assert.deepEqual(
      readBookFeedback(restored, "owner", "owner-book", t.context),
      latest,
    );
    assert.deepEqual(
      saveBookFeedback(restored, "owner", "owner-book", t.answer),
      first,
    );
    assert.deepEqual(
      readBookFeedback(restored, "owner", "owner-book", t.context),
      latest,
    );
    assert.deepEqual(restored.all("SELECT * FROM editions"), editions);
    assert.equal(restored.all("SELECT id FROM studio_jobs").length, 0);
    assert.equal(
      restored.all("SELECT id FROM recovery_locks WHERE releasedAt IS NULL")
        .length,
      1,
    );
  } finally {
    restored?.close();
    rmSync(backupRoot, { recursive: true, force: true });
    t.close();
  }
});

test("feedback routes require sign-in, honor private ownership, and reject invalid input before mutation", async () => {
  const t = fixture();
  const app = express();
  app.use(express.json());
  const auth: express.RequestHandler = (req, res, next) => {
    if (
      !t.store.one(
        "SELECT id FROM users WHERE id=?",
        String(req.headers["test-user"] ?? ""),
      )
    )
      res.status(401).json({ error: "Sign in first." });
    else next();
  };
  installFeedbackRoutes(app, t.store, {
    auth,
    operatorGuard: auth,
    owner: (req) => ({ id: String(req.headers["test-user"]) }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const query = new URLSearchParams({
    revision: "1",
    contentHash: t.context.contentHash,
    editionId: "owner-edition",
  });
  const call = (path: string, user: string, body?: unknown) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "test-user": user, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal(
      (await call(`/projects/owner-book/feedback?${query}`, "")).status,
      401,
    );
    assert.equal(
      (await call(`/projects/owner-book/feedback?${query}`, "other")).status,
      404,
    );
    assert.equal(
      (await call("/projects/owner-book/feedback", "owner", t.answer)).status,
      200,
    );
    assert.equal(
      (await call(`/projects/owner-book/feedback?${query}`, "owner")).status,
      200,
    );
    assert.equal((await call("/operator/feedback", "owner")).status, 403);
    assert.equal((await call("/operator/feedback", "operator")).status, 200);
    assert.equal(
      (
        await call("/projects/owner-book/feedback", "owner", {
          ...t.answer,
          text: "x".repeat(2001),
        })
      ).status,
      400,
    );
    assert.equal(t.store.all("SELECT id FROM book_feedback").length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    t.close();
  }
});
