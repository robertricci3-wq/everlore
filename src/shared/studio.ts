import { z } from "zod";
import { PoeticsReview } from "./poetics.js";
import {
  ReaderExperience,
  VisualDirection,
  PremiseDiversity,
} from "./picturebook.js";
import { EngineProfile } from "./profile.js";
import type { ContinuityView } from "./continuity.js";

export const STUDIO_VERSION = "legacy-2";
export const STYLE_VERSION = "folk-gouache-1";
const text = z.string().trim().min(1).max(3000);
const texts = z.array(text);
const spread = z.number().int().min(1).max(12);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const SourceNugget = z.object({
  id: text,
  kind: z.enum([
    "person",
    "relationship",
    "place",
    "object",
    "event",
    "feeling",
    "quote",
    "lesson",
    "sensory",
    "confessed_flaw",
  ]),
  text,
  sourceId: text,
  quote: text,
  certainty: z.enum(["stated", "uncertain"]),
  emphasis: z.enum(["ordinary", "repeated", "explicit_cue"]),
});
export const HeartContract = z.object({
  version: z.literal(2),
  summary: text,
  emotionalInheritance: text,
  relationshipHeart: text,
  statedWant: text,
  deeperWant: text,
  deeperWantIsInterpretation: z.literal(true),
  childConnection: text,
  nuggets: z.array(SourceNugget).min(1).max(30),
  ledger: z
    .array(
      z.object({
        nuggetId: text,
        tier: z.enum(["protected", "flexible", "open"]),
        rule: text,
        check: text,
      }),
    )
    .min(1)
    .max(30),
  protectedPhrases: texts.max(5),
  creativeOpportunities: texts.max(8),
  sensitiveBoundaries: texts.max(8),
  questions: z
    .array(
      z.object({
        id: text,
        question: text,
        whyItMatters: text,
        essential: z.boolean(),
        answer: z.string().max(1500),
      }),
    )
    .max(3),
  adultNotes: z.string().max(3000),
});
export type Heart = z.infer<typeof HeartContract>;
export const StoryConcept = z.object({
  id: text,
  title: text,
  premise: text,
  shape: z.enum([
    "crossing",
    "trial",
    "meeting",
    "catch",
    "mischief",
    "kindness",
    "loss",
    "craft",
    "creature",
    "secret",
    "discovery",
  ]),
  childDesire: text,
  familySpecificity: text,
  protectedNuggetIds: texts.min(1),
  centralWonder: z.string().max(2000),
  whyThisServesTheHeart: text,
});
export const ConceptSet = z.object({
  concepts: z.array(StoryConcept).length(3),
});
export const ConceptReview = z.object({
  diversity: PremiseDiversity.optional(),
  assessments: z
    .array(
      z.object({
        conceptId: text,
        heartViolations: texts,
        childAppeal: z.number().int().min(1).max(5),
        familySpecificity: z.number().int().min(1).max(5),
        imaginativePotential: z.number().int().min(1).max(5),
        evidence: text,
      }),
    )
    .length(3),
});
export const StoryPlan = z.object({
  readerExperience: ReaderExperience.optional(),
  conceptId: text,
  premise: text,
  shape: text,
  transformation: text,
  protagonist: z.object({
    name: text,
    desire: text,
    deeperNeed: text,
    strength: text,
    vulnerability: text,
    voice: text,
  }),
  amplifications: z
    .array(
      z.object({
        move: text,
        nuggetIds: texts.min(1),
        proposal: text,
        truthServed: text,
      }),
    )
    .min(1)
    .max(8),
  refrain: z.string().max(300),
  talisman: z.string().max(300),
  setups: z
    .array(
      z.object({
        plantedAt: spread,
        paidOffAt: spread,
        detail: text,
        changedMeaning: text,
      }),
    )
    .min(1)
    .max(5),
  beats: z
    .array(
      z.object({
        spread,
        action: text,
        choice: text,
        consequence: text,
        emotionalChange: text,
        pageTurn: text,
        visualDiscovery: text,
        nuggetIds: texts.min(1),
      }),
    )
    .length(12),
});
export const CharacterVersion = z.object({
  id: text,
  name: text,
  relationship: text,
  species: text,
  ageState: text,
  depictedAge: z.number().int().positive().nullable(),
  silhouette: text,
  face: text,
  bodyColors: text,
  proportions: text,
  signatureDetail: text,
  outfit: text,
  strength: text,
  vulnerability: text,
});
export const ObjectVersion = z.object({
  id: text,
  name: text,
  nuggetIds: texts,
  geometry: text,
  colors: text,
  allowedStates: texts,
});
export const VisualWorld = z.object({
  version: z.literal(1),
  styleVersion: z.literal(STYLE_VERSION),
  name: text,
  palette: text,
  worldRules: text,
  characters: z.array(CharacterVersion).min(1).max(5),
  objects: z.array(ObjectVersion).max(8),
});
export const StoryManuscript = z.object({
  title: z.string().trim().min(1).max(65),
  byline: z.string().max(70),
  inventions: texts.min(1).max(20),
  trueParts: text,
  spreads: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(700),
        nuggetIds: texts.min(1),
        characterIds: texts,
        artDirection: text,
        visualDiscovery: text,
      }),
    )
    .length(12),
});
export type Manuscript2 = z.infer<typeof StoryManuscript>;
export const HeartReview = z.object({
  checks: z.array(
    z.object({
      nuggetId: text,
      present: z.boolean(),
      contradicted: z.boolean(),
      spread: spread.nullable(),
      evidence: text,
    }),
  ),
  meaningPreserved: z.boolean(),
  tellerNotDiminished: z.boolean(),
  inventionsDisclosed: z.boolean(),
  failures: texts,
});
export const CRAFT_WEIGHTS = {
  surprise: 1.5,
  readAloud: 1.5,
  concreteness: 1,
  stakes: 1,
  heart: 2,
  pageTurn: 1,
  ending: 1.5,
  playfulness: 1,
  visualStorytelling: 1,
  childAgency: 1,
} as const;
export const CraftCriterion = z.enum(
  Object.keys(CRAFT_WEIGHTS) as [
    keyof typeof CRAFT_WEIGHTS,
    ...(keyof typeof CRAFT_WEIGHTS)[],
  ],
);
export const EditorialReview = z.object({
  scores: z.array(
    z.object({
      criterion: CraftCriterion,
      score: z.number().int().min(1).max(5),
      spread,
      evidence: text,
    }),
  ),
  ageAppropriate: z.boolean(),
  genericStory: z.boolean(),
  genericnessEvidence: text,
  weakestSpread: spread,
  bestLine: text,
  repairs: texts.max(10),
  blockingIssues: texts,
});
export interface StoryVerdict {
  heartFailures: string[];
  craftFailures: string[];
  mechanical: string[];
  weightedMean: number;
  minimum: number;
  passed: boolean;
}
const box = z.array(z.number().min(0).max(1)).length(4);
export const SceneContract = z.object({
  spread,
  characterIds: texts,
  objectIds: texts,
  nuggetIds: texts.min(1),
  action: text,
  emotion: text,
  physicalInteractions: texts,
  composition: z.enum(["wide", "medium", "close", "overhead", "low_angle"]),
  paletteMode: z.enum(["day", "night", "snow", "interior"]),
  propStates: text,
  quietRegion: box,
  exclusions: texts,
  visualDiscovery: text,
});
export const ScenePlan = z.object({
  visualDirection: VisualDirection.optional(),
  scenes: z.array(SceneContract).length(12),
  colorRhythm: text,
});
export const ImageReview = z.object({
  identity: z.number().int().min(1).max(5),
  style: z.number().int().min(1).max(5),
  actionReadability: z.number().int().min(1).max(5),
  physicalCoherence: z.number().int().min(1).max(5),
  evidence: texts.min(1),
  defects: texts,
});
export const ReferenceAsset = z.object({
  hash: digest,
  role: z.enum(["identity", "interaction"]),
  approved: z.boolean(),
  approval: z.enum(["human", "machine"]).optional(),
});
export const ProductionSnapshot = z.object({
  artStatus: z.enum(["passed", "revision_recommended"]).optional(),
  artNotes: texts.optional(),
  editorialStatus: z.enum(["passed", "revision_recommended"]).optional(),
  editorialNotes: texts.optional(),
  poeticsReview: PoeticsReview.optional(),
  engineProfile: EngineProfile.optional(),
  automation: z.enum(["autonomous", "guided"]).optional(),
  version: z.literal(2),
  engineVersion: z.literal(STUDIO_VERSION),
  styleVersion: z.literal(STYLE_VERSION),
  heart: HeartContract,
  concepts: ConceptSet,
  selectedConceptId: text,
  plan: StoryPlan,
  world: VisualWorld,
  familyVersionId: z.string().nullable(),
  references: z.array(ReferenceAsset),
  manuscript: StoryManuscript,
  scenes: ScenePlan,
  heartReview: HeartReview,
  editorialReview: EditorialReview,
  humanReview: z.enum(["pending", "approved"]),
  reviewCopyException: z.object({id:z.string(),approvedAt:z.string(),scope:z.literal("digital_feedback_only")}).optional(),
});
export type Snapshot = z.infer<typeof ProductionSnapshot>;
export const RepairRequest = z.object({
  key: z.string().uuid(),
  baseRevision: z.number().int().positive(),
  kind: z.enum(["wording", "scene", "character", "resolution"]),
  spreads: z.array(spread).min(1).max(12),
  characterId: z.string().nullable(),
  defect: z.string().trim().min(3).max(1500),
  intendedChange: z.string().trim().min(3).max(1500),
  preserve: z.string().max(1500),
});
export const ManuscriptPatch = z.object({
  changes: z
    .array(z.object({ spread, text: z.string().trim().min(1).max(700) }))
    .min(1)
    .max(12),
});
export const ScenePatch = z.object({
  scenes: z.array(SceneContract).min(1).max(12),
});
export interface StudioView {
  continuity?: ContinuityView;
  progressPreview?: { artHash: string; alt: string };
  id: string;
  status: string;
  stage: string;
  error: string | null;
  transcript: string | null;
  heart: Heart | null;
  heartHash: string | null;
  concepts: z.infer<typeof ConceptSet> | null;
  selectedConceptId: string | null;
  world: z.infer<typeof VisualWorld> | null;
  references: z.infer<typeof ReferenceAsset>[];
  preview: {
    title: string;
    heart: string;
    inventions: string[];
    spreads: { text: string; artHash: string; artDescription: string }[];
  } | null;
  kind: string;
  recovery?: {
    callId: string;
    stage: string;
    requestId: string | null;
    message: string;
    uncertain: boolean;
    extraReserveUsd: number;
    resumeReserveUsd?: number;
  } | null;
}
