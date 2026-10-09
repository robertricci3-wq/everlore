import { useEffect, useRef, useState } from "react";
import {
  Mic,
  Pause,
  Play,
  Square,
  Upload,
  ShieldCheck,
  ArrowLeft,
} from "lucide-react";
import { StudioStatus } from "./StoryStudio.js";
import {
  api,
  deleteDraft,
  go,
  loadDraft,
  saveDraft,
  type AudioDraft,
  type SessionUser,
} from "./api.js";

export function Capture({ user }: { user: SessionUser }) {
  const [consent, setConsent] = useState(false),
    [prompt, setPrompt] = useState(0),
    [state, setState] = useState("idle"),
    [seconds, setSeconds] = useState(0),
    [draft, setDraft] = useState<AudioDraft>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [url, setUrl] = useState("");
  const recorder = useRef<MediaRecorder | null>(null),
    chunks = useRef<Blob[]>([]),
    projectId = useRef(""),
    saveQueue = useRef(Promise.resolve()),
    stream = useRef<MediaStream | null>(null),
    file = useRef<HTMLInputElement>(null);
  const [loadingDraft, setLoadingDraft] = useState(true);
  const mounted = useRef(true);
  const prompts = [
    "When did you discover you were braver than you thought?",
    "What adventure from your childhood would you love them to know?",
    "Who taught you what love looks like in the little things?",
  ];
  useEffect(() => {
    void loadDraft(user.id)
      .then((value) => {
        if (value) {
          setDraft(value);
          projectId.current = value.projectId;
          setConsent(true);
          setState("ready");
          setNotice(
            "We found a recording draft on this device. Listen to it, then save it to your private shelf.",
          );
        }
      })
      .catch(() =>
        setNotice(
          "This browser cannot keep a recovery draft. Keep this page open until your recording is saved.",
        ),
      )
      .finally(() => setLoadingDraft(false));
    return () => {
      mounted.current = false;
      if (recorder.current?.state !== "inactive") recorder.current?.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, [user.id]);
  useEffect(() => {
    if (!draft) return;
    const objectUrl = URL.createObjectURL(draft.blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [draft]);
  useEffect(() => {
    if (state !== "recording") return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [state]);
  useEffect(() => {
    if (seconds >= 300 && recorder.current?.state === "recording") {
      recorder.current.stop();
      setNotice("Your five-minute recording is ready to save.");
    }
  }, [seconds]);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (["recording", "paused", "saving"].includes(state)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [state]);
  async function ensureProject() {
    if (!projectId.current) {
      const p = await api<{ id: string }>("/projects", {
        title: "A memory to keep",
        consent: true,
      });
      projectId.current = p.id;
    }
    return projectId.current;
  }
  function persist(blob: Blob, mode: "microphone" | "upload", pid: string) {
    const value: AudioDraft = {
      ownerId: user.id,
      projectId: pid,
      blob,
      mode,
      savedAt: Date.now(),
    };
    setDraft(value);
    saveQueue.current = saveQueue.current
      .then(() => saveDraft(value))
      .catch(() =>
        setNotice(
          "The recovery draft could not be kept on this device. Keep this page open and save your recording.",
        ),
      );
  }
  async function start() {
    setError("");
    setState("requesting");
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
        throw new Error(
          "This browser cannot record here. Choose an audio file below instead.",
        );
      const pid = await ensureProject();
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      if (!mounted.current) {
        stream.current.getTracks().forEach((track) => track.stop());
        return;
      }
      const mime = [
        "audio/webm;codecs=opus",
        "audio/mp4",
        "audio/webm",
        "audio/ogg",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const active = new MediaRecorder(
        stream.current,
        mime ? { mimeType: mime } : undefined,
      );
      recorder.current = active;
      chunks.current = [];
      setSeconds(0);
      active.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.current.push(event.data);
          persist(
            new Blob(chunks.current, { type: active.mimeType }),
            "microphone",
            pid,
          );
        }
      };
      active.onstop = () => {
        stream.current?.getTracks().forEach((track) => track.stop());
        setState("ready");
      };
      active.onerror = () => {
        setError(
          "The microphone was interrupted. Listen to any available draft below, or choose an audio file.",
        );
        if (active.state !== "inactive") active.stop();
        setState("ready");
      };
      stream.current.getAudioTracks()[0].onended = () => {
        if (active.state !== "inactive") {
          active.stop();
          setNotice(
            "The microphone stopped. Please listen to the available draft before saving.",
          );
        }
      };
      active.start(1000);
      setState("recording");
      setNotice(
        "Recording stays on this device until you choose Save recording.",
      );
    } catch (cause) {
      setState("idle");
      setError(
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "The microphone is not available. Allow microphone access in your browser, or choose an audio file below."
          : cause instanceof Error
            ? cause.message
            : "The microphone could not start. Please try an audio file.",
      );
      stream.current?.getTracks().forEach((track) => track.stop());
    }
  }
  async function choose(selected: File) {
    if (!consent) return;
    setError("");
    try {
      if (selected.size > 25 * 1024 * 1024)
        throw new Error("Please choose a recording smaller than 25 MB.");
      if (selected.size < 44)
        throw new Error(
          "That file is empty or incomplete. Please choose another recording.",
        );
      const pid = await ensureProject();
      const mime =
        selected.type ||
        (/\.m4a$/i.test(selected.name)
          ? "audio/mp4"
          : /\.wav$/i.test(selected.name)
            ? "audio/wav"
            : /\.mp3$/i.test(selected.name)
              ? "audio/mpeg"
              : "application/octet-stream");
      persist(new Blob([selected], { type: mime }), "upload", pid);
      setState("ready");
      setNotice(
        "Your audio file is ready to listen to. It has not been saved to the server yet.",
      );
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  async function upload() {
    if (!draft) return;
    setState("saving");
    setError("");
    try {
      await saveQueue.current;
      const response = await fetch(
        `/api/projects/${draft.projectId}/recording`,
        {
          method: "POST",
          headers: {
            "Content-Type": draft.blob.type,
            "X-Evermore-Client": "1",
            "X-Capture-Mode": draft.mode,
          },
          body: draft.blob,
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await deleteDraft(draft.projectId).catch(() => undefined);
      go(`/story/${draft.projectId}`);
    } catch (cause) {
      setState("ready");
      setError(
        `${(cause as Error).message || "We could not save your recording."} Your draft is still here. Try saving again.`,
      );
    }
  }
  const active = ["recording", "paused"].includes(state);
  return (
    <main className="capture-page narrow enter">
      <button className="back-link" onClick={() => go("/")}>
        <ArrowLeft size={17} /> Back to home
      </button>
      <div className="eyebrow">ONE MEMORY IS ENOUGH</div>
      <h1>
        Take your time.
        <br />
        <em>We’re listening.</em>
      </h1>
      <p className="lead">
        You don’t have to be a storyteller. A memory, a little rambling, a
        moment you still feel—that’s a beautiful place to start.
      </p>
      <StudioStatus />
      <section className="question-card">
        <span className="card-index">A place to begin</span>
        <h2>{prompts[prompt]}</h2>
        <button
          className="text-button"
          disabled={active}
          onClick={() => setPrompt((prompt + 1) % prompts.length)}
        >
          Try another question ↗
        </button>
      </section>
      {!active && state !== "ready" && state !== "saving" && (
        <label className="consent">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <span>
            I’m an adult and have permission to save this recording on this
            computer. I’ll choose separately whether to send it to the AI story
            studio.
          </span>
        </label>
      )}
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <section className="recorder" aria-label="Recording controls">
        {active ? (
          <>
            <div
              className={`recording-dot ${state === "paused" ? "paused" : ""}`}
            />
            <span className="timer">
              {String(Math.floor(seconds / 60)).padStart(2, "0")}:
              {String(seconds % 60).padStart(2, "0")}
            </span>
            <p>
              {state === "paused"
                ? "Paused. Take a little breath."
                : "Recording your memory"}
            </p>
            <div className="button-row">
              <button
                className="button secondary"
                onClick={() => {
                  if (state === "recording") {
                    recorder.current?.pause();
                    setState("paused");
                  } else {
                    recorder.current?.resume();
                    setState("recording");
                  }
                }}
              >
                {state === "paused" ? <Play size={18} /> : <Pause size={18} />}{" "}
                {state === "paused" ? "Resume" : "Pause"}
              </button>
              <button
                className="button"
                onClick={() => recorder.current?.stop()}
              >
                <Square size={16} /> I’m finished
              </button>
            </div>
          </>
        ) : (
          <>
            {state === "idle" || state === "requesting" ? (
              <button
                className="button record-button"
                disabled={loadingDraft || !consent || state === "requesting"}
                onClick={() => void start()}
              >
                <Mic size={24} />
                {state === "requesting"
                  ? "Opening microphone…"
                  : "Start telling"}
              </button>
            ) : (
              <>
                <h3>Listen to your memory</h3>
                <audio controls src={url} aria-label="Your recording draft" />
                <button
                  className="button full"
                  disabled={state === "saving" || !draft}
                  onClick={() => void upload()}
                >
                  <ShieldCheck size={21} />
                  {state === "saving"
                    ? "Saving your recording…"
                    : "Save recording"}
                </button>
                <p className="small muted">
                  {state === "saving"
                    ? "Please keep this page open until saving finishes."
                    : "Not yet saved to your shelf. Your draft stays on this device."}
                </p>
              </>
            )}
          </>
        )}
      </section>
      {!active && state !== "saving" && (
        <div className="upload-fallback">
          <input
            ref={file}
            type="file"
            accept="audio/*,.m4a,.webm"
            aria-label="Choose an audio file"
            hidden
            onChange={(e) => {
              const selected = e.target.files?.[0];
              if (selected) void choose(selected);
            }}
          />
          <button
            className="text-button"
            disabled={loadingDraft || !consent}
            onClick={() => file.current?.click()}
          >
            <Upload size={17} />{" "}
            {draft
              ? "Choose a different audio file"
              : "Or choose an audio file"}
          </button>
          <p className="small muted">
            WAV, MP3, M4A, OGG or WebM · Up to 25 MB
          </p>
        </div>
      )}
      <p className="privacy-note">
        <ShieldCheck size={17} /> Saved privately here. Sent to the AI story
        studio only when you choose.
      </p>
    </main>
  );
}
