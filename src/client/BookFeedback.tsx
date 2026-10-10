import { useEffect, useId, useRef, useState } from "react";
import { api } from "./api.js";
import "./BookFeedback.css";

type Overall = "loved_it" | "good_start" | "needs_work";
interface Feedback {
  overall: Overall;
  text: string;
  version: number;
}

export function BookFeedback({
  projectId,
  revision,
  contentHash,
  editionId,
}: {
  projectId: string;
  revision: number;
  contentHash: string;
  editionId?: string;
}) {
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [overall, setOverall] = useState<Overall | "">("");
  const [text, setText] = useState("");
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const loadedContext = useRef<string | null>(null);
  const feedbackContext = JSON.stringify([projectId, revision, contentHash]);
  const requestContext = JSON.stringify({
    revision,
    contentHash,
    ...(editionId ? { editionId } : {}),
  });
  useEffect(() => {
    // Closing this optional section or saving a PDF must not discard an
    // unfinished response. A new edition of the same revision only enriches
    // the next save's context; explicit Reload is the only draft replacement.
    if (!open || loadedContext.current === feedbackContext) return;
    let current = true;
    setLoading(true);
    setLoadFailed(false);
    setError("");
    const query = new URLSearchParams({
      revision: String(revision),
      contentHash,
      ...(editionId ? { editionId } : {}),
    });
    void api<{ feedback: Feedback | null }>(
      `/projects/${projectId}/feedback?${query}`,
    )
      .then(({ feedback }) => {
        if (!current) return;
        setOverall(feedback?.overall ?? "");
        setText(feedback?.text ?? "");
        setVersion(feedback?.version ?? 0);
        setSaved(!!feedback);
        loadedContext.current = feedbackContext;
        pending.current = null;
      })
      .catch((cause: Error) => {
        if (current) {
          setError(cause.message);
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [
    open,
    projectId,
    revision,
    contentHash,
    editionId,
    feedbackContext,
    reload,
  ]);

  async function save() {
    if (!overall || loading || inFlight.current) return;
    const body = { ...JSON.parse(requestContext), overall, text, version };
    const fingerprint = JSON.stringify(body);
    if (pending.current?.fingerprint !== fingerprint)
      pending.current = { fingerprint, key: crypto.randomUUID() };
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await api<{ feedback: Feedback }>(
        `/projects/${projectId}/feedback`,
        { ...body, key: pending.current.key },
      );
      setVersion(response.feedback.version);
      setText(response.feedback.text);
      setSaved(true);
      pending.current = null;
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <details
      className="source-details book-feedback"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Help shape Everlore</summary>
      <p>
        Your thoughts help us improve. This is optional and shared privately
        with the Everlore team.
      </p>
      {loading ? (
        <p role="status">Opening your feedback…</p>
      ) : !loadFailed ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy}>
            <legend>How did this book feel to you?</legend>
            {(
              [
                ["loved_it", "I loved it"],
                ["good_start", "A good start"],
                ["needs_work", "Needs some work"],
              ] as const
            ).map(([value, label]) => (
              <label className="consent" key={value}>
                <input
                  type="radio"
                  name={labelId}
                  value={value}
                  checked={overall === value}
                  onChange={() => {
                    setOverall(value);
                    setSaved(false);
                  }}
                />
                {label}
              </label>
            ))}
            <label htmlFor={labelId}>
              Anything you loved or would change?{" "}
              <span className="muted">Optional</span>
            </label>
            <textarea
              id={labelId}
              rows={3}
              maxLength={2000}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setSaved(false);
              }}
            />
            <button
              type="submit"
              className="button secondary"
              disabled={!overall || saved || busy}
            >
              {busy
                ? "Saving…"
                : version
                  ? "Update feedback"
                  : "Share feedback"}
            </button>
          </fieldset>
        </form>
      ) : null}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => {
              loadedContext.current = null;
              setReload((value) => value + 1);
            }}
          >
            Reload saved feedback
          </button>
        </>
      )}
      {saved && <p role="status">Thank you. Your feedback is saved.</p>}
    </details>
  );
}
