import { useRef, useState } from "react";
import { go } from "./api.js";
export function ArchiveRestore() {
  const input = useRef<HTMLInputElement>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function restore(file: File) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/archives/restore", {
        method: "POST",
        headers: {
          "X-Evermore-Client": "1",
          "Content-Type": "application/octet-stream",
        },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      go(`/story/${result.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="archive-restore">
      <input
        hidden
        ref={input}
        type="file"
        accept=".everlore,.gz"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void restore(file);
          e.target.value = "";
        }}
      />
      <button
        className="text-button"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? "Checking your archive…" : "Restore a family archive"}
      </button>
      <p className="small muted">
        Opens a verified copy on your shelf. It never replaces an existing
        story.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
