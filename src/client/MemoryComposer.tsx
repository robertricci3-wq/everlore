import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Mic, Plus } from "lucide-react";
import type { ProjectView } from "../shared/contracts.js";
import { StoryStudio } from "./StoryStudio.js";
import { FAMILY_CONSENT_VERSION, type JourneySetup as Setup, type JourneyView as Journey } from "../shared/journey.js";
import type { InterviewSessionRecord } from "../shared/almanac.js";
import { MEMORY_INVITATIONS } from "../shared/invitations.js";
import { PUBLIC_HERO_ARTWORK } from "../shared/publicArt.js";
import { api, go, loadTextDraft, type SessionUser } from "./api.js";
import { VoiceTurnRecorder } from "./VoiceTurnRecorder.js";
import { MemoryTextAnswer } from "./MemoryTextAnswer.js";
import { boundedJsonRequest, RequestTimeoutError } from "./bounded-request.js";
import "./MemoryComposer.css";

const consentVersion = FAMILY_CONSENT_VERSION;
interface SessionView { session: InterviewSessionRecord }
type UncertainAction =
  | { kind: "create"; previousRequestId: string | null }
  | { kind: "finish" }
  | { kind: "reopen" }
  | { kind: "add"; afterTurnId: string | null };

// Only a direct Record gesture opens a microphone. The stream is handed to
// the routed recorder once; reloads never start recording by themselves.
const microphoneHandoffs = new Map<string, MediaStream>();
const transcriptHandoffs = new Set<string>();
function handoff(sessionId: string, stream: MediaStream) {
  microphoneHandoffs.set(sessionId, stream);
  window.setTimeout(() => {
    if (microphoneHandoffs.get(sessionId) === stream) {
      stream.getTracks().forEach((t) => t.stop());
      microphoneHandoffs.delete(sessionId);
    }
  }, 10000);
}

export function RecordEntry() {
  const [setup, setSetup] = useState<Setup>();
  const [showConsent, setShowConsent] = useState(false), [consent, setConsent] = useState(false);
  const [help, setHelp] = useState(false), [idea, setIdea] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const requestKey = useRef(crypto.randomUUID());
  const choices = ["people-how-we-met", "table-recipes", "outdoors-adventures", "before-mischief"];
  const invitations = [...choices.map((id) => MEMORY_INVITATIONS.find((i) => i.id === id)).filter((i) => !!i), ...MEMORY_INVITATIONS.filter((i) => !choices.includes(i.id))];
  const invitation = invitations[idea % invitations.length] ?? MEMORY_INVITATIONS[0];
  useEffect(() => { void api<Setup>("/journey/setup").then(setSetup).catch(() => setError("We couldn’t check recording availability. Please refresh and try again.")); }, []);
  async function begin(microphone = true, paste = false) {
    if (busy) return;
    if (!setup?.consented && !consent) { setShowConsent(true); return; }
    setBusy(true); setError("");
    let stream: MediaStream | undefined;
    try {
      if (microphone) {
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Recording is unavailable here. You can use a saved recording instead.");
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const value = await api<{ session: SessionView }>("/journey/start", {
        key: requestKey.current, consent: true, consentVersion,
        processWithOpenAI: true, ...(help ? { invitationId: invitation.id } : {}),
      });
      const sid = value.session.session.id;
      if (stream) handoff(sid, stream);
      if (paste) transcriptHandoffs.add(sid);
      go(`/tell/${sid}`);
    } catch (cause) {
      stream?.getTracks().forEach((t) => t.stop());
      setError(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "The microphone wasn’t opened. Allow microphone access in your browser, or use a saved recording."
        : (cause as Error).message);
      setBusy(false);
    }
  }
  return <section className="record-entry" aria-label="Begin a family story">
    <div className="record-entry-copy">
      <span className="eyebrow">ONE MEMORY. A LITTLE MAGIC.</span>
      <h2>Your memories.<br /><em>Their favorite stories.</em></h2>
      <p>Tell it in your own words. We’ll turn it into a beautifully illustrated adventure.</p>
      {help && <div className="record-idea" aria-live="polite">
        <p>{invitation.opening}</p>
        <button className="text-button" onClick={() => setIdea((i) => i + 1)}>Another idea</button>
      </div>}
      {showConsent && !setup?.consented && <label className="consent record-consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>I’m an adult with permission to share this memory. Everlore may use AI to transcribe it. My recordings stay private.</span>
      </label>}
      <button className="button record-primary" disabled={busy || !setup || (showConsent && !setup.consented && !consent)} onClick={() => void begin()}>
        <Mic size={22} />{busy ? "Opening your memory…" : setup?.canCreate ? "Record a memory" : "Save a memory"}
      </button>
      <div className="record-alternatives">
        <button className="text-button" aria-expanded={help} onClick={() => setHelp(!help)}>Help me begin</button>
        <button className="text-button" disabled={busy || !setup} onClick={() => void begin(false)}>Use a saved recording</button>
        <button className="text-button" disabled={busy || !setup} onClick={() => void begin(false, true)}>Paste a transcript</button>
      </div>
      {setup && !setup.canCreate && <p className="small muted">Book creation is currently unavailable. You can save a memory for later.</p>}
      {error && <p className="alert" role="alert">{error}</p>}
    </div>
    <figure className="record-art">
      <a href="#/example" aria-label="Explore the illustrations"><img src={PUBLIC_HERO_ARTWORK.src} width={PUBLIC_HERO_ARTWORK.width} height={PUBLIC_HERO_ARTWORK.height} alt={PUBLIC_HERO_ARTWORK.alt} /></a>
      <figcaption>An Everlore family story, shared with permission.</figcaption>
    </figure>
  </section>;
}

export function MemoryComposer({ user, sessionId }: {user: SessionUser; sessionId: string}) {
  const [session, setSession] = useState<InterviewSessionRecord>();
  const [journey, setJourney] = useState<Journey>();
  const [project, setProject] = useState<ProjectView>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [audioDraft, setAudioDraft] = useState(false), [textDraft, setTextDraft] = useState(false);
  const [textTurnId, setTextTurnId] = useState<string | null>(null);
  const [checkingTextRecovery, setCheckingTextRecovery] = useState(true);
  const checkedTextRecovery = useRef(false);
  const [pasteRequest, setPasteRequest] = useState(() => transcriptHandoffs.delete(sessionId) ? 1 : 0);
  const [connectionError, setConnectionError] = useState("");
  const readController = useRef<AbortController | null>(null), readVersion = useRef(0), actionPending = useRef(false);
  const uncertainAction = useRef<(UncertainAction & { message: string }) | null>(null);
  const [initialStream] = useState(() => {
    const stream = microphoneHandoffs.get(sessionId);
    microphoneHandoffs.delete(sessionId);
    return stream;
  });
  const creationKey = useRef(crypto.randomUUID());
  function cancelRead() {
    readVersion.current++;
    readController.current?.abort();
    readController.current = null;
  }
  async function load() {
    cancelRead();
    const version = readVersion.current, controller = new AbortController();
    readController.current = controller;
    const read = <T,>(path: string) => boundedJsonRequest<T>(`/api${path}`, {
      headers: { "X-Evermore-Client": "1" }, signal: controller.signal,
    }, 15000, "This memory could not be refreshed yet.");
    try {
      const [s,j] = await Promise.all([read<SessionView>(`/interviews/${sessionId}`), read<Journey>(`/journey/${sessionId}`)]);
      const nextProject = j.projectId ? await read<ProjectView>(`/projects/${j.projectId}`) : undefined;
      if (version !== readVersion.current || controller.signal.aborted) return;
      setSession(s.session); setJourney(j); setProject(nextProject); setConnectionError("");
      const pending = uncertainAction.current;
      if (pending) {
        const anchor = pending.kind === "add" && pending.afterTurnId
          ? s.session.turns.findIndex((turn) => turn.id === pending.afterTurnId) : -1;
        const confirmed = pending.kind === "create"
          ? !!j.requestId && j.requestId !== pending.previousRequestId
          : pending.kind === "finish" ? s.session.status === "finished"
          : pending.kind === "reopen" ? s.session.status === "open"
          : pending.afterTurnId === null ? s.session.turns.length > 0
          : anchor >= 0 && anchor < s.session.turns.length - 1;
        if (confirmed) {
          uncertainAction.current = null;
          setError((current) => current === pending.message ? "" : current);
        }
      }
    } catch (cause) {
      if (version === readVersion.current && !controller.signal.aborted) throw cause;
    } finally {
      controller.abort();
      if (readController.current === controller) readController.current = null;
    }
  }
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        if (!readController.current && !actionPending.current) await load();
      } catch { if (live) setConnectionError("Connection interrupted. We’ll try to refresh this memory again shortly."); }
      if (live) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); cancelRead(); initialStream?.getTracks().forEach((t) => t.stop()); };
  }, [sessionId, initialStream]);
  useEffect(() => {
    if (!session || checkedTextRecovery.current) return;
    let live = true;
    // Recover a newer local edit after an earlier submission was accepted.
    // This runs once per mounted memory, never changing selection on a poll.
    const completed = session.turns.filter((turn) => turn.transcript && turn.status !== "transcribing");
    void Promise.all(completed.map(async (turn) => ({ turn, draft: await loadTextDraft(user.id, turn.id).catch(() => undefined) }))).then((entries) => {
      if (!live) return;
      checkedTextRecovery.current = true;
      const recovered = entries.reverse().find(({turn, draft}) => draft?.text.trim() && draft.text.trim() !== turn.transcript?.rawText);
      if (recovered) { setTextTurnId(recovered.turn.id); setTextDraft(true); setPasteRequest((value) => value + 1); }
      setCheckingTextRecovery(false);
    });
    return () => { live = false; };
  }, [session, user.id]);
  const active = session?.turns.find((t) => t.status === "awaiting_audio");
  const saved = session?.turns.filter((t) => t.audio || t.transcript) ?? [];
  const audioWithoutTranscript = saved.filter((turn) => turn.audio && !turn.transcript && turn.status !== "transcribing");
  const selectedTextTurn = session?.turns.find((turn) => turn.id === textTurnId && turn.status !== "transcribing");
  const textTurn = selectedTextTurn ?? active ?? audioWithoutTranscript.at(-1);
  async function openTranscript(turnId: string) {
    setTextTurnId(turnId); setPasteRequest((value) => value + 1); setAudioDraft(false);
    try { await load(); } catch { setConnectionError("Connection interrupted. We’ll try to refresh this memory again shortly."); }
  }
  async function saveText(rawText: string) {
    if (!textTurn) return;
    setTextTurnId(textTurn.id);
    actionPending.current = true; cancelRead(); setBusy(true);
    uncertainAction.current = null; setError("");
    try {
      if (session?.status === "finished") await postOnce(`/interviews/${sessionId}/reopen`, {}, "Reopening this memory is taking too long. Please try saving your words again.", { kind: "reopen" });
      await boundedJsonRequest(`/api/interviews/${sessionId}/turns/${textTurn.id}/text`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Evermore-Client": "1" }, body: JSON.stringify({ rawText }),
      }, 15000, "Saving your words is taking too long. We could not confirm whether they reached your shelf.");
      setTextTurnId(null); setPasteRequest(0); setTextDraft(false);
      try { await load(); } catch { setConnectionError("Connection interrupted. We’ll try to refresh this memory again shortly."); }
    } finally { actionPending.current = false; setBusy(false); }
  }
  async function postOnce<T>(path: string, body: unknown, timeoutMessage: string, action: UncertainAction) {
    try {
      return await boundedJsonRequest<T>(`/api${path}`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Evermore-Client": "1" }, body: JSON.stringify(body),
      }, 15000, timeoutMessage);
    } catch (cause) {
      if (cause instanceof RequestTimeoutError) uncertainAction.current = { ...action, message: cause.message };
      throw cause;
    }
  }
  async function complete(intent: "save" | "create") {
    actionPending.current = true; cancelRead();
    uncertainAction.current = null;
    setBusy(true); setError("");
    let acknowledged = false;
    try {
      if (intent === "create") {
        const result = await postOnce<Journey>(`/journey/${sessionId}/create`, {
          key: creationKey.current, consentVersion, processWithOpenAI: true, imaginativeAdaptation: true,
        }, "We couldn’t confirm your book request yet. We’re checking your saved progress.", { kind: "create", previousRequestId: journey?.requestId ?? null });
        setJourney(result);
        creationKey.current = crypto.randomUUID();
      } else await postOnce(`/interviews/${sessionId}/finish`, {}, "Your recording reached your shelf, but finishing this memory is taking too long. Please check it again.", { kind: "finish" });
      acknowledged = true;
      setAudioDraft(false); await load();
    } catch (cause) {
      if (acknowledged) setConnectionError("Connection interrupted. We’ll try to refresh this memory again shortly.");
      else setError((cause as Error).message);
      throw cause;
    }
    finally { actionPending.current = false; setBusy(false); }
  }
  async function add() {
    actionPending.current = true; cancelRead();
    uncertainAction.current = null;
    setBusy(true); setError("");
    let acknowledged = false;
    try {
      if (session?.status === "finished") await postOnce(`/interviews/${sessionId}/reopen`, {}, "Reopening this memory is taking too long. We’re checking your saved progress.", { kind: "reopen" });
      // A lost reply retries the same additional part, including after reload.
      // Only a newly observed last turn gives the next deliberate add a new key.
      const key = `additional-${session?.turns.at(-1)?.id ?? sessionId}`;
      await postOnce(`/journey/${sessionId}/turns`, {key, promptId: "additional-memory"}, "We couldn’t confirm the additional part yet. We’re checking your saved progress.", { kind: "add", afterTurnId: session?.turns.at(-1)?.id ?? null });
      acknowledged = true;
      await load();
    } catch (cause) {
      if (acknowledged) setConnectionError("Connection interrupted. We’ll try to refresh this memory again shortly.");
      else setError((cause as Error).message);
    } finally { actionPending.current = false; setBusy(false); }
  }
  const creating = !!journey?.requestId;
  return <main className="memory-composer enter">
    <a className="back-link" href="#/shelf"><ArrowLeft size={17}/> Your stories</a>
    {error && <p className="alert" role="alert">{error}</p>}
    {connectionError && <p className="notice" role="status">{connectionError}</p>}
    {!session || !journey ? <p role="status">Opening your memory…</p> : creating ? <section className="creation-reveal" aria-live="polite">
      {project?.engine && !journey.bookReady ? <StoryStudio project={project} refresh={load}/> : <>
        <span className="eyebrow">YOUR MEMORY IS SAFELY SAVED</span>
        <h1>{journey.bookReady ? "Your book is ready." : journey.status === "transcribing" ? "Listening to your memory." : journey.status === "paused" ? "Your memory is waiting safely." : "A little world is taking shape."}</h1>
        <p>{journey.message}</p>
      </>}
      {journey.bookReady && project?.book && <figure className="finished-reveal"><img src={`/api/projects/${project.id}/art/${project.book.spreads[0].artHash}`} alt={project.book.title}/><figcaption>{project.book.title}</figcaption></figure>}
      {journey.bookReady && journey.projectId && <a className="button" href={`#/story/${journey.projectId}`}>Open your book<ArrowRight size={18}/></a>}
      <p className="small muted">You can leave and return. Your progress stays with your memory.</p>
      <details className="source-details"><summary>Your original memory</summary><a href={`#/interview/${sessionId}`}>Listen to your recording or add the words yourself</a></details>
    </section> : <>
      <span className="eyebrow">TELL IT YOUR WAY</span>
      <h1>{session.status === "finished" ? "A memory, kept." : <>Take your time.<br/><em>We’re listening.</em></>}</h1>
      <p className="composer-invitation">{active?.promptText ?? "An ordinary moment can become an extraordinary story."}</p>
      {active && session.status !== "finished" ? <>
        <VoiceTurnRecorder key={active.id} ownerId={user.id} sessionId={sessionId} turnId={active.id}
          initialStream={session.turns[0]?.id === active.id && initialStream?.getTracks().some((t) => t.readyState === "live") ? initialStream : undefined} onSaved={load} onDraftState={setAudioDraft} disabled={textDraft || busy}
          onRecordingStarted={() => { void api(`/journey/${sessionId}/recording-started`, {}).catch(() => undefined); }}
          onPasteTranscript={() => openTranscript(active.id)}
          completion={{canCreate: journey.canCreate, onComplete: complete}} />
      </> : <section className="composer-saved">
        <p><Check size={18}/> Your memory is saved.</p>
        {journey.canCreate && saved.length > 0 && <button className="button" disabled={busy || textDraft || checkingTextRecovery} onClick={() => void complete("create").catch(() => undefined)}>Make my book <ArrowRight size={18}/></button>}
        <button className="text-button" disabled={busy || textDraft || checkingTextRecovery} onClick={() => void add()}><Plus size={17}/> Add something</button>
        <a className="text-button" href="#/shelf">Back to your stories</a>
      </section>}
      {audioWithoutTranscript.map((turn) => <button key={turn.id} className="text-button" disabled={busy || !!active && audioDraft || textDraft} onClick={() => void openTranscript(turn.id)}>{audioWithoutTranscript.length === 1 ? "Paste a transcript" : `Paste transcript for recording ${turn.sequence + 1}`}</button>)}
      {textTurn && <MemoryTextAnswer key={textTurn.id} ownerId={user.id} turnId={textTurn.id} disabled={busy || !!active && audioDraft} onDraftState={setTextDraft}
        focusRequest={pasteRequest} transcriptForRecording={!!textTurn.audio} confirmedText={textTurn.transcript?.rawText} onResolved={() => { setTextTurnId(null); setTextDraft(false); }} onSave={saveText} />}
      <p className="small muted">{journey.canCreate ? "“Make my book” uses AI to turn your memory into an imaginative family story." : "Book creation is currently unavailable. Your memory can stay here until you’re ready to return."}</p>
      {saved.length > 0 && <details className="source-details"><summary>Your original memory</summary>
        {saved.map((turn) => <div key={turn.id}>{turn.audio && <audio controls aria-label={`Saved recording ${turn.sequence + 1}`} src={`/api/interviews/${sessionId}/turns/${turn.id}/audio`}/>} {turn.transcript && <p>{turn.transcript.rawText}</p>}</div>)}
      </details>}
    </>}
  </main>;
}
