import { useEffect, useState } from "react";
import { api } from "./api.js";
type Access = { cycleReserveCents:number; availableCents:number; invitations:{id:string;label:string;bookCount:number;expiresAt:number;redeemedBy:string|null;revokedAt:string|null}[] };
export function OperatorAccess() {
  const [data,setData]=useState<Access|null>(null),[label,setLabel]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[link,setLink]=useState("");
  const load=()=>api<Access>("/operator/access").then(setData);
  useEffect(()=>{void load().catch(()=>setError("Sign in to the configured operator shelf to manage invitations."));},[]);
  async function issue() {
    if (!data) return;
    setBusy(true);setError("");setLink("");
    try { const r=await api<{code:string}>("/operator/invitations",{label,bookCount:1,expiresDays:7,creditCents:data.cycleReserveCents});setLink(`${location.origin}/#/join?invite=${encodeURIComponent(r.code)}`);setLabel("");await load(); }
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function revoke(id:string){setBusy(true);try{await api(`/operator/invitations/${id}/revoke`,{});await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <main className="narrow project-state"><span className="eyebrow">PRIVATE PILOT</span><h1>Welcome a family.</h1><p>Each invitation opens one private shelf with one story creation, using the existing generation allowance. Invitations expire after seven days.</p>
    {error&&<p role="alert">{error}</p>}{data&&<><p>Available generation allowance: ${(data.availableCents/100).toFixed(2)}. This is an internal estimate, not a provider balance.</p><label>Family or invitation name<input value={label} maxLength={100} onChange={e=>setLabel(e.target.value)}/></label><button className="button" disabled={busy||!label.trim()||data.availableCents<data.cycleReserveCents} onClick={()=>void issue()}>{busy?"Saving…":"Create invitation"}</button>
      {link&&<section className="story-studio"><p>Save this private invitation link now. It is shown only once and can be used once.</p><label>Invitation link<input readOnly value={link} onFocus={e=>e.target.select()}/></label></section>}
      {data.invitations.map(i=><section className="story-studio" key={i.id}><h2>{i.label}</h2><p>{i.revokedAt?"Revoked":i.redeemedBy?"Accepted":i.expiresAt<Date.now()?"Expired":"Ready to share"} · expires {new Date(i.expiresAt).toLocaleDateString()}</p>{!i.redeemedBy&&!i.revokedAt&&i.expiresAt>Date.now()&&<button className="button secondary" disabled={busy} onClick={()=>void revoke(i.id)}>Revoke invitation</button>}</section>)}
      <p><a href="#/operator/orders">Manage orders and support</a></p></>}
  </main>;
}
