import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
type Access = { canInvite?:boolean; pilot?:{state:string;totalCents:number;accountedCents:number;households:number;maxHouseholds:number}; cycleReserveCents:number; availableCents:number; invitations:{id:string;label:string;bookCount:number;expiresAt:number;redeemedBy:string|null;revokedAt:string|null}[] };
export function OperatorAccess() {
  const [data,setData]=useState<Access|null>(null),[label,setLabel]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[link,setLink]=useState(""),[copyStatus,setCopyStatus]=useState(""),[creationReady,setCreationReady]=useState<boolean|null>(null);
  const linkInput=useRef<HTMLInputElement>(null);
  const inviteKey=useRef<string|null>(null);
  const load=()=>api<Access>("/operator/access").then(setData);
  useEffect(()=>{void load().catch(()=>setError("Sign in to the configured operator shelf to manage invitations."));},[]);
  useEffect(()=>{void api<{ready:boolean}>("/engine").then((s)=>setCreationReady(s.ready)).catch(()=>undefined);},[]);
  async function issue() {
    if (!data) return;
    setBusy(true);setError("");setLink("");setCopyStatus("");
    try { const r=await api<{code:string|null}>("/operator/invitations",{label,bookCount:1,expiresDays:7,creditCents:data.cycleReserveCents,...(data.pilot?{key:inviteKey.current??(inviteKey.current=crypto.randomUUID())}:{})});await load();inviteKey.current=null;if(!r.code)throw new Error("This invitation already exists. If you lost its link, revoke it below and create another.");setLink(`${location.origin}/#/join?invite=${encodeURIComponent(r.code)}`);setLabel("");await load(); }
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function copyLink(){
    try {
      if(!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(link);
      setCopyStatus("Invitation link copied. Send it to the family you’re inviting.");
    } catch {
      linkInput.current?.focus();linkInput.current?.select();
      setCopyStatus("The link is selected. Copy it, then send it to the family you’re inviting.");
    }
  }
  async function revoke(id:string){setBusy(true);try{await api(`/operator/invitations/${id}/revoke`,{});await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <main className="narrow project-state"><span className="eyebrow">PRIVATE FEEDBACK PILOT</span><h1>Welcome a family.</h1><p>Share one invitation link. The family chooses a private shelf name and password; their invitation is filled in for them. Each link can be used once and expires after seven days.</p>
    <p>The invited digital book is free to the family, with no card required. A printed copy is an optional purchase after reading, when ordering is available.</p>
    {creationReady===false&&<p className="alert">Book creation is currently unavailable. Invitees can explore and save memories, but cannot make a book yet.</p>}
    {creationReady===null&&<p className="small muted">Check service readiness before promising book creation to invitees.</p>}
    {error&&<p role="alert">{error}</p>}{data&&<><p>Available generation estimate: ${(data.availableCents/100).toFixed(2)}. This is an internal estimate, not a provider balance or billing cap.</p>{data.pilot&&<p>Feedback pilot: {data.pilot.state} · {data.pilot.households} of {data.pilot.maxHouseholds} families · ${(data.pilot.accountedCents/100).toFixed(2)} accounted against ${(data.pilot.totalCents/100).toFixed(2)}. One digital book per family; completion remains subject to available funding and quality checks.</p>}<label>Family or invitation name<input value={label} maxLength={100} onChange={e=>setLabel(e.target.value)}/></label><button className="button" disabled={busy||!label.trim()||data.canInvite===false||data.availableCents<data.cycleReserveCents} onClick={()=>void issue()}>{busy?"Saving…":"Create invitation"}</button>
      {link&&<section className="story-studio"><p>Save this private invitation link now. It is shown only once.</p><label>Invitation link<input ref={linkInput} readOnly value={link} onFocus={e=>e.target.select()}/></label><button className="button secondary" onClick={()=>void copyLink()}>Copy invitation link</button>{copyStatus&&<p role="status">{copyStatus}</p>}</section>}
      {data.invitations.map(i=><section className="story-studio" key={i.id}><h2>{i.label}</h2><p>{i.revokedAt?"Revoked":i.redeemedBy?"Accepted":i.expiresAt<Date.now()?"Expired":"Ready to share"} · expires {new Date(i.expiresAt).toLocaleDateString()}</p>{!i.redeemedBy&&!i.revokedAt&&i.expiresAt>Date.now()&&<button className="button secondary" disabled={busy} onClick={()=>void revoke(i.id)}>Revoke invitation</button>}</section>)}
      <p><a href="#/operator/feedback">Family feedback</a> · <a href="#/operator/costs">Book costs and recovery</a> · <a href="#/operator/studio">AI connection and service settings</a> · <a href="#/operator/orders">Manage orders and support</a></p></>}
  </main>;
}
