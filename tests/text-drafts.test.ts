import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deleteDraft,
  deleteTextDraft,
  loadDraft,
  loadTextDraft,
  saveDraft,
  saveTextDraft,
  type TextDraft,
} from "../src/client/api.js";

const databaseName = "evermore-local-drafts";
function openVersion(version: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("drafts"))
        request.result.createObjectStore("drafts", { keyPath: "projectId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function seedVersionTwoAudio() {
  const database = await openVersion(2);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("drafts", "readwrite");
      transaction.objectStore("drafts").put({
        ownerId: "upgrade-owner",
        projectId: "upgrade-audio",
        interviewId: "upgrade-interview",
        turnId: "upgrade-turn",
        blob: new Blob(["the original audio"], { type: "audio/webm" }),
        mode: "microphone",
        savedAt: 1,
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
const draft = (
  ownerId: string,
  turnId: string,
  text: string,
  savedAt = 1,
): TextDraft => ({ ownerId, turnId, text, savedAt });

test("v2 to v3 adds text recovery without recreating or altering existing audio", async () => {
  await seedVersionTwoAudio();
  await saveTextDraft(
    draft("upgrade-owner", "upgrade-turn", "The words typed later."),
  );
  const audio = await loadDraft("upgrade-owner", "upgrade-turn");
  assert.equal(audio?.projectId, "upgrade-audio");
  assert.equal(audio?.interviewId, "upgrade-interview");
  assert.equal(audio?.blob.type, "audio/webm");
  assert.equal(await audio?.blob.text(), "the original audio");
  assert.equal(
    (await loadTextDraft("upgrade-owner", "upgrade-turn"))?.text,
    "The words typed later.",
  );
  const database = await openVersion(3);
  assert.equal(database.version, 3);
  assert.deepEqual([...database.objectStoreNames], ["drafts", "textDrafts"]);
  assert.deepEqual(
    database.transaction("textDrafts").objectStore("textDrafts").keyPath,
    ["ownerId", "turnId"],
  );
  database.close();
});

test("text drafts are isolated by both family owner and answer, independent of audio deletion", async () => {
  await Promise.all([
    saveTextDraft(draft("one", "same-turn", "Family one")),
    saveTextDraft(draft("two", "same-turn", "Family two")),
    saveTextDraft(draft("one", "other-turn", "Another answer")),
    saveDraft({
      ownerId: "one",
      projectId: "same-turn",
      turnId: "same-turn",
      interviewId: "one-interview",
      blob: new Blob(["audio"]),
      mode: "upload",
      savedAt: 2,
    }),
  ]);
  assert.equal((await loadTextDraft("one", "same-turn"))?.text, "Family one");
  assert.equal((await loadTextDraft("two", "same-turn"))?.text, "Family two");
  assert.equal(await loadTextDraft("unknown", "same-turn"), undefined);
  await deleteDraft("same-turn");
  assert.equal((await loadTextDraft("one", "same-turn"))?.text, "Family one");
  await deleteTextDraft("one", "same-turn");
  assert.equal(await loadTextDraft("one", "same-turn"), undefined);
  assert.equal((await loadTextDraft("two", "same-turn"))?.text, "Family two");
  assert.equal(
    (await loadTextDraft("one", "other-turn"))?.text,
    "Another answer",
  );
  assert.equal(
    await (await loadDraft("upgrade-owner", "upgrade-turn"))?.blob.text(),
    "the original audio",
  );
});

test("rapid edits retain invocation order and exact whitespace and Unicode, even before awaiting writes", async () => {
  const writes: Promise<void>[] = [];
  for (let i = 0; i < 25; i++)
    writes.push(saveTextDraft(draft("ordered", "answer", `revision ${i}`, i)));
  const finalText = "  Café, “poco a poco.” 🍞\nA second line.\n";
  writes.push(saveTextDraft(draft("ordered", "answer", finalText, 0)));
  // savedAt is informational, not an ordering oracle; the latest call wins.
  assert.equal((await loadTextDraft("ordered", "answer"))?.text, finalText);
  await Promise.all(writes);
  assert.equal((await loadTextDraft("ordered", "answer"))?.text, finalText);
});

test("queued writes copy their input and a delete cannot overtake a prior save", async () => {
  const value = draft("snapshot", "answer", "words at invocation");
  const writing = saveTextDraft(value);
  value.text = "mutated after enqueue";
  await writing;
  assert.equal(
    (await loadTextDraft("snapshot", "answer"))?.text,
    "words at invocation",
  );
  const first = saveTextDraft(draft("snapshot", "answer", "earlier"));
  const removal = deleteTextDraft("snapshot", "answer");
  const last = saveTextDraft(draft("snapshot", "answer", "newer after delete"));
  await Promise.all([first, removal, last]);
  assert.equal(
    (await loadTextDraft("snapshot", "answer"))?.text,
    "newer after delete",
  );
});

test("cleanup after server save never deletes a newer answer from another tab", async () => {
  await saveTextDraft(draft("conditional", "answer", "sent to server"));
  await saveTextDraft(
    draft("conditional", "answer", "new words while awaiting server"),
  );
  await deleteTextDraft("conditional", "answer", "sent to server");
  assert.equal(
    (await loadTextDraft("conditional", "answer"))?.text,
    "new words while awaiting server",
  );
  await deleteTextDraft(
    "conditional",
    "answer",
    "new words while awaiting server",
  );
  assert.equal(await loadTextDraft("conditional", "answer"), undefined);
});

test("a failed device write leaves the preceding draft intact and does not poison later recovery", async () => {
  await saveTextDraft(draft("failure", "answer", "last recoverable words"));
  const invalid = {
    ...draft("failure", "answer", "bad write"),
    unclonable: () => undefined,
  };
  await assert.rejects(saveTextDraft(invalid), /clone|function/i);
  assert.equal(
    (await loadTextDraft("failure", "answer"))?.text,
    "last recoverable words",
  );
  await saveTextDraft(draft("failure", "answer", "recovered"));
  assert.equal((await loadTextDraft("failure", "answer"))?.text, "recovered");
});

test("clearing the textarea remains an ordered empty draft rather than resurrecting earlier words", async () => {
  const first = saveTextDraft(draft("clear", "answer", "something"));
  const cleared = saveTextDraft(draft("clear", "answer", ""));
  await Promise.all([first, cleared]);
  assert.equal((await loadTextDraft("clear", "answer"))?.text, "");
});
