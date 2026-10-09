import { useState } from "react";
import { ArrowLeft, ArrowRight, Sprout } from "lucide-react";
import { PUBLIC_ART_SHOWCASE } from "../shared/publicArt.js";

export function PublicExample() {
  const [page, setPage] = useState(0);
  const artwork = PUBLIC_ART_SHOWCASE.artworks[page];
  return (
    <main className="public-art-page enter">
      <header className="public-art-heading">
        <span className="eyebrow">THE ART OF A FAMILY STORY</span>
        <h1>{PUBLIC_ART_SHOWCASE.heading}</h1>
        <p>{PUBLIC_ART_SHOWCASE.description}</p>
      </header>
      <section className="public-art-gallery" aria-label="Illustration gallery">
        <figure className="public-art-piece" aria-labelledby="public-art-title">
          <div className="public-art-frame">
            <img
              key={artwork.id}
              className="public-art-image"
              src={artwork.src}
              width={artwork.width}
              height={artwork.height}
              alt={artwork.alt}
            />
          </div>
          <figcaption>
            <span className="eyebrow">A MOMENT, REIMAGINED</span>
            <h2 id="public-art-title">{artwork.title}</h2>
            <p>{artwork.caption}</p>
          </figcaption>
        </figure>
        <div className="public-art-navigation">
          <button
            className="button secondary"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            <ArrowLeft size={18} aria-hidden="true" /> Previous illustration
          </button>
          <span role="status" aria-live="polite" aria-atomic="true">
            Illustration {page + 1} of {PUBLIC_ART_SHOWCASE.artworks.length}
          </span>
          <button
            className="button secondary"
            disabled={page === PUBLIC_ART_SHOWCASE.artworks.length - 1}
            onClick={() => setPage(page + 1)}
          >
            Next illustration <ArrowRight size={18} aria-hidden="true" />
          </button>
        </div>
        <div
          className="public-art-thumbnails"
          role="group"
          aria-label="Choose an illustration"
        >
          {PUBLIC_ART_SHOWCASE.artworks.map((image, index) => (
            <button
              key={image.id}
              aria-label={`Show ${image.title}`}
              aria-pressed={index === page}
              onClick={() => setPage(index)}
            >
              <img
                src={image.src}
                width={image.width}
                height={image.height}
                alt=""
              />
              <span>{image.title}</span>
            </button>
          ))}
        </div>
        <p className="public-art-attribution">
          {PUBLIC_ART_SHOWCASE.attribution}
        </p>
      </section>
      <aside className="public-art-invitation">
        <Sprout size={30} strokeWidth={1.2} aria-hidden="true" />
        <h2>Every family has a world of stories.</h2>
        <p>Start with a memory. Give them a story to love.</p>
        <a className="button" href="#/capture">
          Tell your family’s story <ArrowRight size={18} aria-hidden="true" />
        </a>
      </aside>
    </main>
  );
}
