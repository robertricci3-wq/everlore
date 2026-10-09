import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { BookDocument } from "../shared/contracts.js";
export function PublicExample() {
  const [data, setData] = useState<{book:BookDocument;artwork:string[]} | null>(null), [page,setPage] = useState(0), [error,setError] = useState("");
  useEffect(() => { void api<{book:BookDocument;artwork:string[]}>("/example").then(setData).catch(() => setError("The example could not be loaded. Please try again.")); }, []);
  return <main className="reader">
    <div className="reader-heading"><span className="eyebrow">AN ORIGINAL SYNTHETIC EXAMPLE</span><h1>{data?.book.title ?? "A story to explore"}</h1><p>This example is open to everyone. Your own family stories stay private.</p></div>
    {error && <p role="alert">{error}</p>}
    {data && <><div className="open-book"><div className="art-page"><img src={data.artwork[page]} alt={data.book.spreads[page].artDescription}/></div><div className="words-page"><p>{data.book.spreads[page].text}</p></div></div>
      <div className="reader-pagination"><button className="button secondary" disabled={page === 0} onClick={() => setPage(page-1)}>Previous spread</button><span aria-live="polite">Spread {page+1} of 12</span><button className="button secondary" disabled={page === 11} onClick={() => setPage(page+1)}>Next spread</button></div>
      <p><a className="button" href="#/join">Tell your family’s story</a></p></>}
  </main>;
}
