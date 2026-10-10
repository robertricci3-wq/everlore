export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Evermore-Client": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error ?? "This step could not finish. Please try again.",
    );
  return data as T;
}
export const go = (path: string) => {
  window.location.hash = path;
};
export type SessionUser = {
  id: string;
  name: string;
  kind: string;
  labOwner?: boolean;
  operator?: boolean;
};
export interface AudioDraft {
  ownerId: string;
  projectId: string;
  blob: Blob;
  mode: "microphone" | "upload";
  savedAt: number;
  interviewId?: string;
  turnId?: string;
}
async function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("evermore-local-drafts", 3);
    req.onupgradeneeded = (event) => {
      // v3 only adds a separate store. Never rebuild a working v2 audio store.
      if (
        event.oldVersion < 2 &&
        req.result.objectStoreNames.contains("drafts")
      ) {
        const old = req.transaction!.objectStore("drafts").getAll();
        old.onsuccess = () => {
          req.result.deleteObjectStore("drafts");
          const fresh = req.result.createObjectStore("drafts", {
            keyPath: "projectId",
          });
          for (const value of old.result) fresh.put(value);
        };
      } else if (!req.result.objectStoreNames.contains("drafts")) {
        req.result.createObjectStore("drafts", { keyPath: "projectId" });
      }
      if (!req.result.objectStoreNames.contains("textDrafts")) {
        req.result.createObjectStore("textDrafts", {
          keyPath: ["ownerId", "turnId"],
        });
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}
export async function loadDraft(
  ownerId: string,
  turnId?: string,
): Promise<AudioDraft | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("drafts", "readonly"),
      request = transaction.objectStore("drafts").getAll();
    request.onsuccess = () =>
      resolve(
        (request.result as AudioDraft[])
          .filter(
            (d) =>
              d.ownerId === ownerId &&
              (turnId ? d.turnId === turnId : !d.interviewId),
          )
          .sort((a, b) => b.savedAt - a.savedAt)[0],
      );
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}
export async function saveDraft(draft: AudioDraft) {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("drafts", "readwrite");
    transaction.objectStore("drafts").put(draft);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}
export async function deleteDraft(projectId: string) {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("drafts", "readwrite");
    transaction.objectStore("drafts").delete(projectId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export interface TextDraft {
  ownerId: string;
  turnId: string;
  text: string;
  savedAt: number;
}

// Preserve invocation order for one answer even when opening IndexedDB resolves
// asynchronously. A failed device write must not poison the next save or delete.
const textDraftWrites = new Map<string, Promise<void>>();
function textDraftKey(ownerId: string, turnId: string) {
  if (!ownerId || !turnId)
    throw new Error("A text draft needs its owner and answer.");
  return JSON.stringify([ownerId, turnId]);
}
function updateTextDraft(
  ownerId: string,
  turnId: string,
  write: (store: IDBObjectStore) => void,
) {
  const key = textDraftKey(ownerId, turnId);
  const next = (textDraftWrites.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const database = await db();
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction("textDrafts", "readwrite");
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () =>
            reject(
              transaction.error ??
                new Error("Text draft save was interrupted."),
            );
          write(transaction.objectStore("textDrafts"));
        });
      } finally {
        database.close();
      }
    });
  textDraftWrites.set(key, next);
  void next
    .finally(() => {
      if (textDraftWrites.get(key) === next) textDraftWrites.delete(key);
    })
    .catch(() => undefined);
  return next;
}
export async function loadTextDraft(
  ownerId: string,
  turnId: string,
): Promise<TextDraft | undefined> {
  await textDraftWrites.get(textDraftKey(ownerId, turnId));
  const database = await db();
  try {
    return await new Promise<TextDraft | undefined>((resolve, reject) => {
      const transaction = database.transaction("textDrafts", "readonly");
      const request = transaction
        .objectStore("textDrafts")
        .get([ownerId, turnId]);
      let value: TextDraft | undefined;
      request.onsuccess = () => {
        value = request.result as TextDraft | undefined;
      };
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Text draft could not be read."));
    });
  } finally {
    database.close();
  }
}
export function saveTextDraft(draft: TextDraft): Promise<void> {
  // Copy now, rather than when a queued transaction eventually starts.
  const snapshot = { ...draft };
  return updateTextDraft(snapshot.ownerId, snapshot.turnId, (store) => {
    store.put(snapshot);
  });
}
export function deleteTextDraft(
  ownerId: string,
  turnId: string,
  expectedText?: string,
): Promise<void> {
  return updateTextDraft(ownerId, turnId, (store) => {
    if (expectedText === undefined) {
      store.delete([ownerId, turnId]);
      return;
    }
    // A successful server save must not erase newer words written in another tab.
    const request = store.get([ownerId, turnId]);
    request.onsuccess = () => {
      if ((request.result as TextDraft | undefined)?.text === expectedText)
        store.delete([ownerId, turnId]);
    };
  });
}
