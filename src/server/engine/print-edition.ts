import { z } from "zod";
import { Book } from "../../shared/contracts.js";
import {
  ImageRenderSpec,
  type ImageRenderSpecification,
} from "../../shared/imageRender.js";
import { Store, type ProjectRow } from "../store.js";
import { saveProfile } from "../lab/profiles.js";
import type { EngineConfig } from "./provider.js";
import { queueRepair } from "./studio.js";

/** Internal operator action. It creates a new revision, never replaces a saved edition or activates a global profile. */
export function queuePrintArtwork(
  store: Store,
  project: ProjectRow,
  input: unknown,
  config: EngineConfig,
  specification: ImageRenderSpecification,
) {
  const body = z
      .object({
        key: z.string().uuid(),
        baseRevision: z.number().int().positive(),
      })
      .parse(input),
    render = ImageRenderSpec.parse(specification);
  if (
    render.capability !== "verified" ||
    render.width !== 2560 ||
    render.height !== 2560 ||
    render.quality !== "high"
  )
    throw new Error(
      "Native print rendering must have retained capability evidence before commissioning a book.",
    );
  const row = store.one<{ book: string }>(
    "SELECT book FROM revisions WHERE projectId=? AND revision=?",
    project.id,
    body.baseRevision,
  );
  if (!row) throw new Error("The source book revision is unavailable.");
  const book = Book.parse(JSON.parse(row.book)),
    base = book.production?.engineProfile;
  if (!base)
    throw new Error("This book has no pinned rendering profile to extend.");
  const { hash: _hash, ...original } = base;
  const profile = saveProfile(store, {
    ...original,
    name: `${base.name.slice(0, 70)} · native print`,
    parentHash: base.hash,
    imageRender: render,
    change: {
      target: "art",
      mechanism:
        "Native print-resolution repaint with original scene and canonical references",
      amendment:
        "Preserve the manuscript, scene plans, family identity and original edition.",
    },
  });
  return queueRepair(
    store,
    project,
    {
      ...body,
      kind: "resolution",
      spreads: Array.from({ length: 12 }, (_, i) => i + 1),
      characterId: null,
      defect:
        "The digital illustrations do not provide sufficient native detail for the selected print layout.",
      intendedChange:
        "Repaint all twelve scenes at native 2560 by 2560 pixels using their saved compositions and stable canonical references.",
      preserve:
        "Every manuscript word, source nugget, family relationship, canonical identity, scene action, meaningful object and saved edition.",
    },
    config,
    { renderProfile: profile },
  );
}
