import { useEffect, useRef, useState, type RefObject } from "react";
import { api } from "./api.js";
import {
  studioReservation,
  studioSettingsIssue,
  usdCents,
  type StudioSetupView,
} from "../shared/studioSetup.js";
export function StudioSetup({
  state,
  onConnected,
  detailsRef,
  nextAction,
  additionalReserveUsd,
  endpoint = "/studio-setup",
}: {
  state: StudioSetupView;
  onConnected: (state: StudioSetupView) => void;
  detailsRef: RefObject<HTMLDetailsElement | null>;
  nextAction?: string;
  additionalReserveUsd?: number;
  endpoint?: string;
}) {
  const [key, setKey] = useState(""),
    [budget, setBudget] = useState(
      state.budgetUsd > 0 ? String(state.budgetUsd) : "",
    ),
    [audio, setAudio] = useState(String(state.audioReserveUsd || 3)),
    [text, setText] = useState(String(state.textReserveUsd || 0.5)),
    [image, setImage] = useState(String(state.imageReserveUsd || 0.75)),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const reserve =
    studioReservation({
      audioReserve: usdCents(Number(audio)),
      textReserve: usdCents(Number(text)),
      imageReserve: usdCents(Number(image)),
    }) / 100;
  const validReserve = [audio, text, image].every(
    (v) => Number.isFinite(Number(v)) && Number(v) >= 0.01 && Number(v) <= 100,
  );
  async function save() {
    const input = {
      apiKey: key,
      budgetUsd: Number(budget),
      audioReserveUsd: Number(audio),
      textReserveUsd: Number(text),
      imageReserveUsd: Number(image),
      authorizeCosts: consent,
    };
    const issue = studioSettingsIssue(
      input,
      state.hasKey,
      usdCents(state.usedReserveUsd),
    );
    setSaved(false);
    if (issue) {
      setError(issue);
      errorRef.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const updated = await api<StudioSetupView>(endpoint, input);
      setKey("");
      setSaved(true);
      onConnected(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function check() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const updated = await api<StudioSetupView>(`${endpoint}/check`, {});
      onConnected(updated);
      if (!updated.ready) setError(updated.message);
      else setSaved(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!state.canManage)
    return (
      <p className="notice" role="status">
        {state.message}
      </p>
    );
  return (
    <details ref={detailsRef} className="source-details studio-setup">
      <summary>
        {state.hasKey
          ? "Connection and allowance settings"
          : "Connect the story studio"}
      </summary>
      <h3>One private connection. Then your story can begin.</h3>
      <ol>
        <li>
          Create an API key in your{" "}
          <a
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noreferrer"
          >
            OpenAI project
          </a>{" "}
          and enable API billing there.
        </li>
        <li>
          Paste it below. It stays in the server’s private app storage and is
          never returned by the app or included in story backups.
        </li>
        <li>
          Manage the existing authorized allowance. Families separately consent
          to sharing their memory when they create a story.
        </li>
      </ol>
      <p className="small muted">
        A ChatGPT subscription or GitHub connection does not configure this
        app’s API access.
      </p>
      {state.hasKey && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void check()}
        >
          {busy ? "Checking your connection…" : "Check saved connection"}
        </button>
      )}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        onChange={() => {
          setSaved(false);
          setError("");
        }}
      >
        <label>
          API key
          <input
            type="password"
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              state.hasKey
                ? "Leave blank to keep your existing key"
                : "Paste your API key privately here"
            }
          />
        </label>
        <label>
          Total allowance in US dollars
          <input
            type="number"
            min="0.01"
            max="10000"
            step="0.01"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="Enter the amount you authorize"
          />
        </label>
        <p className="small muted">
          {validReserve
            ? additionalReserveUsd !== undefined
              ? `Unused funds from stopped jobs are released. Resuming this story needs a total allowance of at least $${(state.usedReserveUsd + additionalReserveUsd).toFixed(2)}, including its $${additionalReserveUsd.toFixed(2)} remaining-work reserve.`
              : `To start one book at these settings, the total allowance needs to be at least $${(reserve + state.usedReserveUsd).toFixed(2)}. You choose the amount; saving a smaller allowance keeps generation paused.`
            : "Enter valid request reserves below to calculate the allowance needed for one book."}
        </p>
        <details>
          <summary>How generation costs are reserved</summary>
          <p>
            One cycle allows up to three manuscripts, two story revisions, and
            two corrections per image. The current conservative reservation is{" "}
            <strong>${validReserve ? reserve.toFixed(2) : "—"}</strong>. This is
            not a price quote or a provider billing cap; actual usage may
            differ. Provider-side billing controls should also be configured.
          </p>
          <label>
            Audio request reserve ($)
            <input
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              value={audio}
              onChange={(e) => setAudio(e.target.value)}
            />
          </label>
          <label>
            Editorial/vision request reserve ($)
            <input
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <label>
            Illustration request reserve ($)
            <input
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              value={image}
              onChange={(e) => setImage(e.target.value)}
            />
          </label>
        </details>
        <p>
          At these settings, one complete cycle reserves $
          {validReserve ? reserve.toFixed(2) : "—"}. Active reservations and
          past request estimates: ${state.usedReserveUsd.toFixed(2)}. Unused
          reservations from stopped or completed books are released
          automatically. These estimates are not confirmed API charges.
        </p>
        <label className="consent">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <span>
            I authorize this allowance for AI generation that I request. I
            understand it reserves estimated costs rather than imposing a
            provider billing limit.
          </span>
        </label>
        {error && (
          <p ref={errorRef} tabIndex={-1} role="alert" className="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button full" disabled={busy}>
          {busy
            ? "Checking and saving your connection…"
            : "Save connection and allowance"}
        </button>
        {saved && (
          <p className="notice" role="status">
            {nextAction && state.ready
              ? nextAction
              : state.canStart
                ? "Connection and allowance saved. Check the recording-sharing box below, then choose Make my legacy story."
                : state.message}
          </p>
        )}
        <p className="small muted">
          Saving checks the key with OpenAI without sending your memory or
          making a paid generation request. Generation also needs available API
          billing and permission for the requested models.
        </p>
      </form>
    </details>
  );
}
