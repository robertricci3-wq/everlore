import { useEffect, useState } from "react";
import { api } from "./api.js";

type Overall = "loved_it" | "good_start" | "needs_work";
const labels: Record<Overall, string> = {
  loved_it: "I loved it",
  good_start: "A good start",
  needs_work: "Needs some work",
};
interface FeedbackReport {
  note: string;
  total: number;
  limit: number;
  offset: number;
  counts: { overall: Overall; count: number }[];
  responses: {
    id: string;
    projectId: string;
    revision: number;
    editionId: string | null;
    overall: Overall;
    text: string;
    updatedAt: string;
  }[];
}

export function OperatorFeedback() {
  const [report, setReport] = useState<FeedbackReport>();
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void api<FeedbackReport>(`/operator/feedback?limit=25&offset=${offset}`)
      .then((value) => { if (current) setReport(value); })
      .catch((cause: Error) => { if (current) setError(cause.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [offset, refresh]);
  return <main className="narrow project-state">
    <span className="eyebrow">PRIVATE FEEDBACK PILOT</span>
    <h1>What families are saying.</h1>
    <p>Optional responses from the book reader. Nothing here changes a family’s book or starts generation.</p>
    <p><a href="#/operator/access">Invitations</a> · <a href="#/operator/costs">Book costs</a></p>
    <button className="button secondary" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>Refresh feedback</button>
    {loading && <p role="status">Opening feedback…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && report && <>
      <p>{report.total} saved {report.total === 1 ? "response" : "responses"} across book versions.</p>
      <p className="small muted">{report.note}</p>
      {!!report.counts.length && <dl className="cost-summary">
        {report.counts.map((count) => <div key={count.overall}><dt>{labels[count.overall]}</dt><dd>{count.count}</dd></div>)}
      </dl>}
      {!report.total && <p>After reading, families can open “Help shape Everlore” to share what they loved or would change.</p>}
      {report.responses.map((response) => <article className="story-studio" key={response.id}>
        <h2>{labels[response.overall]}</h2>
        {response.text && <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{response.text}</p>}
        <p className="small muted">Book version {response.revision} · {new Date(response.updatedAt).toLocaleDateString()}</p>
      </article>)}
      {report.total > report.limit && <nav className="pagination" aria-label="Feedback pages">
        <button className="button secondary" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - report.limit))}>Newer feedback</button>
        <span>{offset + 1}–{Math.min(offset + report.limit, report.total)} of {report.total}</span>
        <button className="button secondary" disabled={offset + report.limit >= report.total} onClick={() => setOffset(offset + report.limit)}>Older feedback</button>
      </nav>}
    </>}
  </main>;
}
