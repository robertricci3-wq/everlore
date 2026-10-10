import { useEffect, useRef, useState } from "react";
import { Mic, Pause, Play, Square, Upload, ShieldCheck } from "lucide-react";
import { deleteDraft, loadDraft, saveDraft, type AudioDraft } from "./api.js";

/** Each turn owns its recovery draft. No silence detection or voice commands. */
export function VoiceTurnRecorder({
  ownerId,
  sessionId,
  turnId,
  onSaved,
  onDraftState,
  disabled = false,
  initialStream,
  completion,
  onRecordingStarted,
}: {
  ownerId: string;
  sessionId: string;
  turnId: string;
  onSaved: () => Promise<void>;
  onDraftState?: (unsaved: boolean) => void;
  disabled?: boolean;
  initialStream?: MediaStream;
  completion?: {
    canCreate: boolean;
    onComplete: (intent: "save" | "create") => Promise<void>;
  };
  onRecordingStarted?: () => void;
}) {
  const [draft, setDraft] = useState<AudioDraft>();
  const [state, setState] = useState<
    "loading" | "idle" | "opening" | "recording" | "paused" | "ready" | "saving"
  >("loading");
  const [seconds, setSeconds] = useState(0),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [url, setUrl] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const recording = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    chunks = useRef<Blob[]>([]),
    alive = useRef(true),
    queue = useRef(Promise.resolve()),
    file = useRef<HTMLInputElement>(null);
  const latestDraft = useRef<AudioDraft | undefined>(undefined),
    uploading = useRef(false),
    finishIntent = useRef<"save" | "create" | null>(null),
    startedStream = useRef<MediaStream | null>(null);
  const active = state === "recording" || state === "paused";
  useEffect(() => {
    onDraftState?.(
      active ||
        state === "loading" ||
        state === "opening" ||
        state === "saving" ||
        !!draft,
    );
  }, [active, state, draft, onDraftState]);
  useEffect(() => {
    alive.current = true;
    void loadDraft(ownerId, turnId)
      .then((value) => {
        if (!alive.current) return;
        if (value) {
          latestDraft.current = value;
          setDraft(value);
          setState("ready");
          setNotice("Your unsaved recording is still here on this device.");
        } else setState("idle");
      })
      .catch(() => {
        if (alive.current) {
          setState("idle");
          setNotice(
            "Keep this page open until your recording is saved; this browser cannot keep a recovery draft.",
          );
        }
      });
    return () => {
      alive.current = false;
      if (recording.current && recording.current.state !== "inactive")
        recording.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, [ownerId, turnId]);
  useEffect(() => {
    if (initialStream && state === "idle" && startedStream.current !== initialStream) {
      startedStream.current = initialStream;
      void start(initialStream);
    }
    // This stream comes only from the person's explicit Record action.
  }, [initialStream, state]);
  useEffect(() => {
    if (!draft) return;
    const value = URL.createObjectURL(draft.blob);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [draft]);
  useEffect(() => {
    if (state !== "recording") return;
    const timer = setInterval(() => setSeconds((x) => x + 1), 1000);
    return () => clearInterval(timer);
  }, [state]);
  useEffect(() => {
    if (seconds >= 300 && recording.current?.state === "recording") {
      recording.current.stop();
      setNotice(
        "This five-minute part is ready to save. You can add another part afterwards.",
      );
    }
  }, [seconds]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (active || state === "saving") {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active, state]);
  function persist(blob: Blob, mode: "microphone" | "upload") {
    const value: AudioDraft = {
      ownerId,
      projectId: turnId,
      interviewId: sessionId,
      turnId,
      blob,
      mode,
      savedAt: Date.now(),
    };
    if (alive.current) setDraft(value);
    latestDraft.current = value;
    queue.current = queue.current
      .then(() => saveDraft(value))
      .catch(() => {
        if (alive.current)
          setNotice(
            "The device could not keep a recovery draft. Please save before leaving this page.",
          );
      });
  }
  async function start(preparedStream?: MediaStream) {
    setError("");
    setState("opening");
    window.speechSynthesis?.cancel();
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
        throw new Error(
          "Recording is unavailable in this browser. You can choose an audio file instead.",
        );
      const audio = preparedStream ?? await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = audio;
      if (!alive.current) {
        audio.getTracks().forEach((t) => t.stop());
        return;
      }
      const mime = [
        "audio/webm;codecs=opus",
        "audio/mp4",
        "audio/webm",
        "audio/ogg",
      ].find((x) => MediaRecorder.isTypeSupported(x));
      const recorder = new MediaRecorder(
        audio,
        mime ? { mimeType: mime } : undefined,
      );
      recording.current = recorder;
      chunks.current = [];
      setSeconds(0);
      recorder.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.current.push(event.data);
          persist(
            new Blob(chunks.current, { type: recorder.mimeType }),
            "microphone",
          );
        }
      };
      recorder.onstop = () => {
        audio.getTracks().forEach((t) => t.stop());
        if (alive.current) setState("ready");
        const intent = finishIntent.current;
        finishIntent.current = null;
        if (intent) void upload(intent);
      };
      recorder.onerror = () => {
        audio.getTracks().forEach((t) => t.stop());
        if (alive.current) {
          setState(chunks.current.length ? "ready" : "idle");
          setError(
            "Recording stopped. Any captured audio is kept below; please listen before saving.",
          );
        }
      };
      recorder.start(1000);
      setState("recording");
      onRecordingStarted?.();
    } catch (cause) {
      stream.current?.getTracks().forEach((t) => t.stop());
      setError((cause as Error).message);
      setState("idle");
    }
  }
  function choose(selected: File) {
    setError("");
    if (selected.size < 44 || selected.size > 25 * 1024 * 1024) {
      setError("Choose a complete audio recording smaller than 25 MB.");
      return;
    }
    const mime =
      selected.type ||
      (/\.m4a$/i.test(selected.name)
        ? "audio/mp4"
        : /\.wav$/i.test(selected.name)
          ? "audio/wav"
          : /\.mp3$/i.test(selected.name)
            ? "audio/mpeg"
            : "application/octet-stream");
    persist(new Blob([selected], { type: mime }), "upload");
    setState("ready");
    setNotice("Ready to save. Your file has not been sent yet.");
  }
  async function upload(intent?: "save" | "create") {
    const savedDraft = latestDraft.current ?? draft;
    if (!savedDraft || uploading.current) return;
    uploading.current = true;
    setState("saving");
    setError("");
    try {
      await queue.current;
      const response = await fetch(
        `/api/interviews/${sessionId}/turns/${turnId}/audio`,
        {
          method: "PUT",
          headers: {
            "Content-Type": savedDraft.blob.type,
            "X-Evermore-Client": "1",
            "X-Capture-Mode": savedDraft.mode,
          },
          body: savedDraft.blob,
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "The recording could not be saved.");
      if (intent && completion) await completion.onComplete(intent);
      else await onSaved();
      await deleteDraft(turnId).catch(() => undefined);
    } catch (cause) {
      if (alive.current) {
        setError(
          `${(cause as Error).message} Your draft is still here. Saving again will not create another recording.`,
        );
        setState("ready");
      }
    } finally {
      uploading.current = false;
    }
  }
  function finish(intent: "save" | "create") {
    if (uploading.current) return;
    if (active) {
      if (finishIntent.current || !recording.current || recording.current.state === "inactive") return;
      finishIntent.current = intent;
      recording.current?.stop();
    } else void upload(intent);
  }
  async function discard() {
    setError("");
    try {
      await queue.current;
      await deleteDraft(turnId);
      setDraft(undefined);
      latestDraft.current = undefined;
      setState("idle");
      setDiscarding(false);
      setNotice(
        "Only the unsaved recording was discarded. Your earlier answers are safe.",
      );
    } catch {
      setError("The local draft could not be removed. Please try again.");
    }
  }
  return (
    <section className="voice-turn" aria-label="Recording controls">
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {active ? (
        <>
          <div className="voice-live">
            <span
              className={`recording-dot ${state === "paused" ? "paused" : ""}`}
            />
            <span className="timer">
              {String(Math.floor(seconds / 60)).padStart(2, "0")}:
              {String(seconds % 60).padStart(2, "0")}
            </span>
          </div>
          <p>
            {state === "paused"
              ? "Paused. Take your time."
              : "We’re recording. Take all the pauses you need."}
          </p>
          <div className="button-row">
            <button
              className="button secondary"
              onClick={() => {
                if (!recording.current || recording.current.state === "inactive") return;
                if (state === "recording") {
                  recording.current?.pause();
                  setState("paused");
                } else {
                  recording.current?.resume();
                  setState("recording");
                }
              }}
            >
              {state === "paused" ? <Play size={18} /> : <Pause size={18} />}
              {state === "paused" ? "Resume" : "Pause"}
            </button>
            {completion ? <>
              {completion.canCreate && <button className="button" onClick={() => finish("create")}>
                Make my book
              </button>}
              <button className={completion.canCreate ? "text-button" : "button"} onClick={() => finish("save")}>
                Save for later
              </button>
            </> : <button
              className="button"
              onClick={() => recording.current?.stop()}
            >
              <Square size={17} />
              Finish this part
            </button>}
          </div>
        </>
      ) : state === "ready" || state === "saving" ? (
        <>
          <audio controls src={url} aria-label="Your unsaved recording" />
          {completion ? <div className="button-row">
            {completion.canCreate && <button className="button" disabled={state === "saving" || !draft} onClick={() => finish("create")}>
              {state === "saving" ? "Saving your memory…" : "Make my book"}
            </button>}
            <button className={completion.canCreate ? "text-button" : "button"} disabled={state === "saving" || !draft} onClick={() => finish("save")}>
              {state === "saving" ? "Saving your memory…" : "Save for later"}
            </button>
          </div> : <button
            className="button full"
            disabled={state === "saving" || !draft}
            onClick={() => void upload()}
          >
            <ShieldCheck size={20} />
            {state === "saving" ? "Saving your words…" : "Save this part"}
          </button>}
          <p className="small muted">
            Your earlier recordings stay safe. This part is saved separately.
          </p>
          {state !== "saving" &&
            (discarding ? (
              <div className="memory-status">
                <p>Discard only this unsaved part and record it again?</p>
                <button className="text-button" onClick={() => void discard()}>
                  Discard this unsaved part
                </button>
                <button
                  className="text-button"
                  onClick={() => setDiscarding(false)}
                >
                  Keep this recording
                </button>
              </div>
            ) : (
              <button
                className="text-button"
                onClick={() => setDiscarding(true)}
              >
                Record this part again
              </button>
            ))}
        </>
      ) : (
        <>
          <button
            className="button full"
            disabled={disabled || state === "loading" || state === "opening"}
            onClick={() => void start()}
          >
            <Mic size={23} />
            {state === "opening"
              ? "Opening microphone…"
              : state === "loading"
                ? "Checking saved draft…"
                : "Start telling"}
          </button>
          <button
            className="text-button"
            disabled={disabled || state !== "idle"}
            onClick={() => file.current?.click()}
          >
            <Upload size={17} /> Or choose an audio file
          </button>
          <input
            hidden
            ref={file}
            type="file"
            accept="audio/*,.m4a,.webm"
            aria-label="Choose a recording for this part"
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) choose(selected);
            }}
          />
        </>
      )}
    </section>
  );
}
