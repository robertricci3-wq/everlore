import { POETICS_PROMPT } from "../engine/poetics.js";
import { legacyImageRender } from "../../shared/imageRender.js";
import { Store, hash, canonical, now } from "../store.js";
import {
  EngineProfile,
  ProfileBody,
  type Profile,
} from "../../shared/profile.js";
import {
  STORY_SYSTEM,
  ART_SYSTEM,
  instructions,
} from "../engine/studio-prompts.js";
import { AMPLIFICATION_MOVES, HOUSE_STYLE, SHAPES } from "../engine/craft.js";
import type { EngineConfig } from "../engine/provider.js";
import { EngineError } from "../engine/pipeline.js";
export function saveProfile(store: Store, body: unknown): Profile {
  const parsed = ProfileBody.parse(body),
    p = { ...parsed, hash: hash(canonical(parsed)) };
  if (p.imageRender && p.imageRender.model !== p.models.image)
    throw new EngineError(
      "The image render specification must match the profile model.",
    );
  store.run(
    "INSERT OR IGNORE INTO lab_profiles VALUES(?,?,?)",
    p.hash,
    JSON.stringify(p),
    now(),
  );
  return p;
}
export function loadProfile(store: Store, digest: string): Profile {
  const row = store.one<{ body: string }>(
    "SELECT body FROM lab_profiles WHERE hash=?",
    digest,
  );
  if (!row) throw new EngineError("That engine profile is unavailable.");
  return verifyProfile(JSON.parse(row.body));
}
export function verifyProfile(value: unknown): Profile {
  const p = EngineProfile.parse(value),
    { hash: digest, ...body } = p;
  if (
    hash(canonical(body)) !== digest ||
    (p.imageRender && p.imageRender.model !== p.models.image)
  )
    throw new EngineError(
      "The pinned engine profile failed its integrity check.",
    );
  return p;
}
export function activeProfile(store: Store, c: EngineConfig): Profile {
  const active = store.one<{ value: string }>(
    "SELECT value FROM lab_settings WHERE key='active_profile'",
  );
  if (active) return loadProfile(store, active.value);
  const base = saveProfile(store, {
    version: 1,
    name: "Everlore • starting profile",
    parentHash: null,
    engineVersion: "legacy-2",
    styleVersion: "folk-gouache-1",
    models: { text: c.textModel, image: c.imageModel, audio: c.audioModel },
    imageRender: legacyImageRender(c.imageModel),
    storySystem: STORY_SYSTEM,
    artSystem: ART_SYSTEM,
    instructions: { ...instructions, poetics: POETICS_PROMPT },
    craftRules: {
      shapes: SHAPES,
      moves: AMPLIFICATION_MOVES,
      houseStyle: HOUSE_STYLE,
      diagnosticVersion: "child-poetics-1",
    },
    rubric: { version: "craft-2", minimum: 3, mean: 4 },
    change: {
      target: "baseline",
      mechanism: "Existing engineering baseline; creative quality unverified",
      amendment: "",
    },
  });
  store.run(
    "INSERT OR IGNORE INTO lab_settings VALUES('active_profile',?)",
    base.hash,
  );
  return base;
}
