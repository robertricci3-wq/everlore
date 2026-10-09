import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { saveDraft, loadDraft, deleteDraft } from "../src/client/api.js";

test("concurrent memories keep separate recovery audio; saving or deleting one preserves the other", async () => {
  const first = {
    ownerId: "owner",
    projectId: "memory-a",
    blob: new Blob(["audio-a"]),
    mode: "microphone" as const,
    savedAt: 1,
  };
  const second = {
    ...first,
    projectId: "memory-b",
    blob: new Blob(["audio-b"]),
    savedAt: 2,
  };
  await saveDraft(first);
  await saveDraft(second);
  await deleteDraft("memory-a");
  assert.equal((await loadDraft("owner"))?.projectId, "memory-b");
  assert.equal(await (await loadDraft("owner"))?.blob.text(), "audio-b");
  await deleteDraft("unrelated-old-book");
  assert.equal(await (await loadDraft("owner"))?.blob.text(), "audio-b");
  assert.equal(await loadDraft("other-owner"), undefined);
  await deleteDraft("memory-b");
  assert.equal(await loadDraft("owner"), undefined);
});
