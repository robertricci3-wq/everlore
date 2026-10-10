import { useEffect, useRef, useState } from "react";
import { deleteTextDraft, loadTextDraft, saveTextDraft } from "./api.js";

export function MemoryTextAnswer({
  ownerId,
  turnId,
  disabled,
  onSave,
  onDraftState,
}: {
  ownerId: string;
  turnId: string;
  disabled: boolean;
  onSave: (text: string) => Promise<void>;
  onDraftState: (unsaved: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const currentText = useRef("");
  useEffect(() => {
    const epoch = ++generation.current;
    let live = true;
    setLoading(true);
    setExpanded(false);
    setText("");
    currentText.current = "";
    setError("");
    setNotice("");
    void loadTextDraft(ownerId, turnId)
      .then((draft) => {
        if (!live || generation.current !== epoch) return;
        if (draft) {
          setText(draft.text);
          setExpanded(draft.text.length > 0);
          currentText.current = draft.text;
          setNotice("Your unsaved words are still here on this device.");
        }
      })
      .catch(() => {
        if (live)
          setNotice(
            "This browser cannot recover typed drafts. Save your words before leaving this page.",
          );
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      ++generation.current;
    };
  }, [ownerId, turnId]);
  useEffect(() => {
    onDraftState(loading || saving || text.length > 0);
  }, [loading, saving, text, onDraftState]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (text.length || saving) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [text, saving]);

  function edit(value: string) {
    const epoch = generation.current;
    setText(value);
    currentText.current = value;
    setError("");
    void saveTextDraft({
      ownerId,
      turnId,
      text: value,
      savedAt: Date.now(),
    }).catch(() => {
      if (generation.current === epoch)
        setNotice(
          "These words could not be kept on this device. Please save them before leaving.",
        );
    });
  }
  async function save() {
    if (disabled || loading || saving || !text.trim()) return;
    const value = text,
      epoch = generation.current;
    setSaving(true);
    setError("");
    // Ensure the latest visible answer is queued before the server request. A
    // device-storage failure must not prevent the user from saving to the server.
    await saveTextDraft({
      ownerId,
      turnId,
      text: value,
      savedAt: Date.now(),
    }).catch(() => undefined);
    try {
      await onSave(value);
    } catch (cause) {
      if (generation.current === epoch) {
        setError(
          `${cause instanceof Error ? cause.message : "Your words could not be saved."} Your answer is still here; you can try again.`,
        );
        setSaving(false);
      }
      return;
    }
    let removed = true;
    await deleteTextDraft(ownerId, turnId, value).catch(() => {
      removed = false;
    });
    if (generation.current === epoch) {
      setText("");
      currentText.current = "";
      setSaving(false);
      setNotice(
        removed
          ? "Your words are saved with this memory."
          : "Your words are saved. This browser could not remove its recovery copy.",
      );
      onDraftState(false);
    }
  }
  async function discard() {
    if (disabled || loading || saving || !text.length) return;
    const value = currentText.current,
      epoch = generation.current;
    setSaving(true);
    setError("");
    try {
      await deleteTextDraft(ownerId, turnId, value);
      if (generation.current === epoch) {
        setText("");
        currentText.current = "";
        setNotice(
          "The unsaved words were discarded. Saved answers are unchanged.",
        );
        onDraftState(false);
      }
    } catch {
      if (generation.current === epoch)
        setError("The draft could not be removed. Your words are still here.");
    } finally {
      if (generation.current === epoch) setSaving(false);
    }
  }
  return (
    <details
      className="memory-manual"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>Prefer to add the words yourself?</summary>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <label htmlFor={`memory-words-${turnId}`}>Your words</label>
      <textarea
        id={`memory-words-${turnId}`}
        value={text}
        maxLength={50000}
        disabled={disabled || loading || saving}
        onChange={(event) => edit(event.target.value)}
        placeholder="Start anywhere. There’s no need to write it like a story."
      />
      <p className="small muted">
        Until you choose “Save these words,” this typed draft stays only on this
        device. Save it to return from another device.
      </p>
      <button
        className="button secondary"
        disabled={disabled || loading || saving || !text.trim()}
        onClick={() => void save()}
      >
        {loading
          ? "Checking saved words…"
          : saving
            ? "Saving your words…"
            : "Save these words"}
      </button>
      {!!text.length && (
        <button
          className="text-button"
          disabled={disabled || loading || saving}
          onClick={() => void discard()}
        >
          Discard these unsaved words
        </button>
      )}
    </details>
  );
}
