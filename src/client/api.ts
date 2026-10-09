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
export type SessionUser = { id: string; name: string; kind: string; labOwner?:boolean; operator?:boolean };
export interface AudioDraft {
  ownerId: string;
  projectId: string;
  blob: Blob;
  mode: "microphone" | "upload";
  savedAt: number;
}
async function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("evermore-local-drafts", 2);
    req.onupgradeneeded = () => {
      if (req.result.objectStoreNames.contains("drafts")) {
        const old = req.transaction!.objectStore("drafts").getAll();
        old.onsuccess = () => {
          req.result.deleteObjectStore("drafts");
          const fresh = req.result.createObjectStore("drafts", {
            keyPath: "projectId",
          });
          for (const value of old.result) fresh.put(value);
        };
      } else req.result.createObjectStore("drafts", { keyPath: "projectId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function loadDraft(
  ownerId: string,
): Promise<AudioDraft | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("drafts", "readonly"),
      request = transaction.objectStore("drafts").getAll();
    request.onsuccess = () =>
      resolve(
        (request.result as AudioDraft[])
          .filter((d) => d.ownerId === ownerId)
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
