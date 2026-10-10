import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Mic, Plus } from "lucide-react";
import type { ProjectView } from "../shared/contracts.js";
import { StoryStudio } from "./StoryStudio.js";
import { FAMILY_CONSENT_VERSION, type JourneySetup as Setup, type JourneyView as Journey } from "../shared/journey.js";
import type { InterviewSessionRecord } from "../shared/almanac.js";
import { MEMORY_INVITATIONS } from "../shared/invitations.js";
import { PUBLIC_HERO_ARTWORK } from "../shared/publicArt.js";
import { api, go, type SessionUser } from "./api.js";
import { VoiceTurnRecorder } from "./VoiceTurnRecorder.js";
import { MemoryTextAnswer } from "./MemoryTextAnswer.js";
import "./MemoryComposer.css";

const consentVersion = FAMILY_CONSENT_VERSION;
interface SessionView { session: InterviewSessionRecord }

// Only a direct Record gesture opens a microphone. The stream is handed to
// the routed recorder once; reloads never start recording by themselves.
const microphoneHandoffs = new Map<string, MediaStream>();
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
  async function begin(microphone = true) {
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
  const [initialStream] = useState(() => {
    const stream = microphoneHandoffs.get(sessionId);
    microphoneHandoffs.delete(sessionId);
    return stream;
  });
  const creationKey = useRef(crypto.randomUUID());
  async function load() {
    const [s,j] = await Promise.all([api<SessionView>(`/interviews/${sessionId}`), api<Journey>(`/journey/${sessionId}`)]);
    setSession(s.session); setJourney(j);
    if (j.projectId) setProject(await api<ProjectView>(`/projects/${j.projectId}`));
  }
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const [s,j] = await Promise.all([api<SessionView>(`/interviews/${sessionId}`), api<Journey>(`/journey/${sessionId}`)]);
        const project = j.projectId ? await api<ProjectView>(`/projects/${j.projectId}`) : undefined;
        if (live) { setSession(s.session); setJourney(j); setProject(project); }
      } catch (e) { if (live) setError((e as Error).message); }
    };
    void poll(); const timer = setInterval(() => void poll(), 2000);
    return () => { live = false; clearInterval(timer); initialStream?.getTracks().forEach((t) => t.stop()); };
  }, [sessionId, initialStream]);
  const active = session?.turns.find((t) => t.status === "awaiting_audio");
  const saved = session?.turns.filter((t) => t.audio || t.transcript) ?? [];
  async function complete(intent: "save" | "create") {
    setBusy(true); setError("");
    try {
      if (intent === "create") {
        const result = await api<Journey>(`/journey/${sessionId}/create`, {
          key: creationKey.current, consentVersion, processWithOpenAI: true, imaginativeAdaptation: true,
        });
        setJourney(result);
        creationKey.current = crypto.randomUUID();
      } else await api(`/interviews/${sessionId}/finish`, {});
      setAudioDraft(false); await load();
    } catch (cause) { setError((cause as Error).message); throw cause; }
    finally { setBusy(false); }
  }
  async function add() {
    setBusy(true); setError("");
    try {
      if (session?.status === "finished") await api(`/interviews/${sessionId}/reopen`, {});
      await api(`/journey/${sessionId}/turns`, {key: crypto.randomUUID(), promptId: "additional-memory"});
      await load();
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  const creating = !!journey?.requestId;
  return <main className="memory-composer enter">
    <a className="back-link" href="#/shelf"><ArrowLeft size={17}/> Your stories</a>
    {error && <p className="alert" role="alert">{error}</p>}
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
          initialStream={session.turns[0]?.id === active.id && initialStream?.getTracks().some((t) => t.readyState === "live") ? initialStream : undefined} onSaved={load} onDraftState={setAudioDraft} disabled={textDraft}
          onRecordingStarted={() => { void api(`/journey/${sessionId}/recording-started`, {}).catch(() => undefined); }}
          completion={{canCreate: journey.canCreate, onComplete: complete}} />
        <MemoryTextAnswer ownerId={user.id} turnId={active.id} disabled={busy || audioDraft} onDraftState={setTextDraft}
          onSave={async (rawText) => {await api(`/interviews/${sessionId}/turns/${active.id}/text`, {rawText}); setTextDraft(false); await load();}} />
      </> : <section className="composer-saved">
        <p><Check size={18}/> Your memory is saved.</p>
        {journey.canCreate && saved.length > 0 && <button className="button" disabled={busy} onClick={() => void complete("create").catch(() => undefined)}>Make my book <ArrowRight size={18}/></button>}
        <button className="text-button" disabled={busy} onClick={() => void add()}><Plus size={17}/> Add something</button>
        <a className="text-button" href="#/shelf">Back to your stories</a>
      </section>}
      <p className="small muted">{journey.canCreate ? "“Make my book” uses AI to turn your memory into an imaginative family story." : "Book creation is currently unavailable. Your memory can stay here until you’re ready to return."}</p>
      {saved.length > 0 && <details className="source-details"><summary>Your original memory</summary>
        {saved.map((turn) => <div key={turn.id}>{turn.audio && <audio controls aria-label={`Saved recording ${turn.sequence + 1}`} src={`/api/interviews/${sessionId}/turns/${turn.id}/audio`}/>} {turn.transcript && <p>{turn.transcript.rawText}</p>}</div>)}
      </details>}
    </>}
  </main>;
}
