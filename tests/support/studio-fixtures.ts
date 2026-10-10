import { lenses, POETICS_VERSION } from "../../src/shared/poetics.js";
import { z } from "zod";
import sharp from "sharp";
import { sampleBook } from "../../src/shared/fixture.js";
import {
  HeartContract,
  ConceptSet,
  StoryPlan,
  VisualWorld,
  StoryManuscript,
  HeartReview,
  EditorialReview,
  ScenePlan,
  CRAFT_WEIGHTS,
  STYLE_VERSION,
} from "../../src/shared/studio.js";
import type {
  Provider,
  EngineConfig,
} from "../../src/server/engine/provider.js";
export const testConfig: EngineConfig = {
  enabled: true,
  apiKey: "fake-test-key-not-a-secret",
  budgetCents: 100000,
  audioReserve: 100,
  textReserve: 100,
  imageReserve: 100,
  textModel: "test-text",
  imageModel: "test-image",
  audioModel: "test-audio",
};
export const fixtureSource =
  "Ada waited while Nell tried her three blue coat buttons. She never rushed Nell. This is a synthetic test memory.";
export const fixtureHeart = HeartContract.parse({
  version: 2,
  summary: "Patient love makes room for a small brave try.",
  emotionalInheritance: "You can try again when someone makes room for you.",
  relationshipHeart: "Ada supports Nell without taking over.",
  statedWant: "Nell wants to fasten her coat.",
  deeperWant: "To feel capable beside someone she trusts.",
  deeperWantIsInterpretation: true,
  childConnection: "Doing a small thing by yourself.",
  nuggets: [
    {
      id: "n1",
      kind: "event",
      text: "Ada waited while Nell tried her three blue coat buttons.",
      sourceId: "s1",
      quote: "Ada waited while Nell tried her three blue coat buttons.",
      certainty: "stated",
      emphasis: "ordinary",
    },
  ],
  ledger: [
    {
      nuggetId: "n1",
      tier: "protected",
      rule: "Preserve the patient support and Nell's own effort.",
      check: "Nell acts while Ada makes room.",
    },
  ],
  protectedPhrases: [],
  creativeOpportunities: ["Buttons can become small moons."],
  sensitiveBoundaries: [],
  questions: [],
  adultNotes: "",
});
export const fixtureConcepts = ConceptSet.parse({
  concepts: [
    "Three little moons",
    "The coat that held a garden",
    "The tiny button orchestra",
  ].map((title, i) => ({
    id: `idea-${i + 1}`,
    title,
    premise: `${title}: a distinct synthetic premise ${i + 1}.`,
    shape: "craft",
    childDesire: "Nell wants to fasten the coat herself.",
    familySpecificity: "Ada waits beside the blue coat.",
    protectedNuggetIds: ["n1"],
    centralWonder:
      i === 0 ? "Buttons become moons." : "A distinct pretend world.",
    whyThisServesTheHeart:
      "The small action becomes a visible moment of courage.",
  })),
});
export const fixturePlan = StoryPlan.parse({
  conceptId: "idea-2",
  premise: fixtureConcepts.concepts[1].premise,
  shape: "craft",
  transformation: "Nell acts with growing confidence.",
  protagonist: {
    name: "Nell",
    desire: "Fasten the coat",
    deeperNeed: "Feel capable",
    strength: "Noticing",
    vulnerability: "Hurrying",
    voice: "Concrete and curious",
  },
  amplifications: [
    {
      move: "talisman",
      nuggetIds: ["n1"],
      proposal: "The blue coat carries small courage.",
      truthServed: "Patient support makes trying possible.",
    },
  ],
  refrain: "A little turn",
  talisman: "Blue coat",
  setups: [
    {
      plantedAt: 1,
      paidOffAt: 12,
      detail: "Waiting at the doorway",
      changedMeaning: "Nell can wait for someone else.",
    },
  ],
  beats: Array.from({ length: 12 }, (_, i) => ({
    spread: i + 1,
    action: `Action ${i + 1}`,
    choice: `Choice ${i + 1}`,
    consequence: `Consequence ${i + 1}`,
    emotionalChange: "New confidence",
    pageTurn: "A new discovery",
    visualDiscovery: "A small visual detail",
    nuggetIds: ["n1"],
  })),
});
const sample = sampleBook();
export const fixtureWorld = VisualWorld.parse({
  version: 1,
  styleVersion: STYLE_VERSION,
  name: "Nell and Ada’s beaver family",
  palette: "Sage, rust, cream, blue",
  worldRules: "Animals with real family relationships",
  characters: sample.people.map((p) => ({
    id: p.id,
    name: p.name,
    relationship: p.relationship,
    species: "beaver",
    ageState: p.depictedAge === 5 ? "child" : "adult",
    depictedAge: p.depictedAge,
    silhouette: "Substantial walnut torso and paddle tail",
    face: "Small dark eyes and ivory muzzle",
    bodyColors: "Walnut fur, ivory muzzle",
    proportions: p.depictedAge === 5 ? "0.7 adult height" : "1.0",
    signatureDetail: p.id === "nell" ? "Blue coat" : "Sage apron",
    outfit: p.id === "nell" ? "Blue coat" : "Sage apron",
    strength: "Patient observation",
    vulnerability: "Wants to hurry",
  })),
  objects: [
    {
      id: "coat",
      name: "Blue coat",
      nuggetIds: ["n1"],
      geometry: "Three round buttons",
      colors: "Blue",
      allowedStates: ["open", "fastened"],
    },
  ],
});
export const fixtureManuscript = StoryManuscript.parse({
  title: "Three little moons",
  byline: "A synthetic test only",
  inventions: ["Animal casting and the moon metaphor are imagined."],
  trueParts:
    "In this synthetic example Ada waited while Nell tried the blue coat buttons. The animals and moons are imagined.",
  spreads: sample.spreads.map((s) => ({
    text: s.text,
    nuggetIds: ["n1"],
    characterIds: s.characterIds,
    artDirection: s.artDescription,
    visualDiscovery: "A small supporting visual detail",
  })),
});
export const fixtureAudit = HeartReview.parse({
  checks: [
    {
      nuggetId: "n1",
      present: true,
      contradicted: false,
      spread: 1,
      evidence: "Scripted test-only finding, not real editorial evidence.",
    },
  ],
  meaningPreserved: true,
  tellerNotDiminished: true,
  inventionsDisclosed: true,
  failures: [],
});
export const fixtureCritic = EditorialReview.parse({
  scores: Object.keys(CRAFT_WEIGHTS).map((criterion) => ({
    criterion,
    score: 4,
    spread: 1,
    evidence: "Scripted test verdict; no actual child or literary validation.",
  })),
  ageAppropriate: true,
  genericStory: false,
  genericnessEvidence: "Scripted fixture",
  weakestSpread: 6,
  bestLine: fixtureManuscript.spreads[0].text,
  repairs: [],
  blockingIssues: [],
});
export const fixtureScenes = ScenePlan.parse({
  colorRhythm: "Daylight to quiet interior",
  scenes: fixtureManuscript.spreads.map((s, i) => ({
    spread: i + 1,
    characterIds: s.characterIds,
    objectIds: ["coat"],
    nuggetIds: ["n1"],
    action: s.artDirection,
    emotion: "Concentration",
    physicalInteractions: ["Paws support the coat"],
    composition: ["wide", "medium", "close"][i % 3],
    paletteMode: "day",
    propStates: "Coat consistent",
    quietRegion: [0, 0, 0.2, 0.2],
    exclusions: ["No extra animals"],
    visualDiscovery: s.visualDiscovery,
  })),
});
export class StudioFake implements Provider {
  calls: string[] = [];
  imageReferenceCounts: number[] = [];
  imagePrompts: string[] = [];
  onStructured?: (name: string) => void;
  failAt = "";
  weak = false;
  weakImages = false;
  artRefinements = false;
  incorrectArt = false;
  dismissArtAllegation = false;
  firstWeak = false;
  regress = false;
  async transcribe() {
    this.calls.push("transcription");
    return fixtureSource;
  }
  async structured<T>(
    name: string,
    schema: z.ZodType<T>,
    _instructions: string,
    data: unknown,
    images: Buffer[] = [],
  ): Promise<T> {
    this.calls.push(name);
    this.onStructured?.(name);
    if (name === this.failAt) throw new Error("Private response must not leak");
    let result: unknown;
    if (name === "heart") result = fixtureHeart;
    else if (name === "heart_questions_v1")
      result = {
        decisions: (data as { questions: { id: string }[] }).questions.map(
          (q) => ({
            id: q.id,
            kind: q.id === "unknown" ? "unresolved_fact" : "creative_choice",
            decision:
              q.id === "unknown"
                ? "Leave the neighbor unnamed."
                : "Choose an original animal species.",
          }),
        ),
      };
    else if (name === "concepts") result = fixtureConcepts;
    else if (name === "concept_review")
      result = {
        assessments: fixtureConcepts.concepts.map((c, i) => ({
          conceptId: c.id,
          heartViolations: [],
          childAppeal: i === 1 ? 5 : 3,
          familySpecificity: 4,
          imaginativePotential: 4,
          evidence: "Test-only premise assessment",
        })),
      };
    else if (name === "story_plan") result = fixturePlan;
    else if (name === "world") result = fixtureWorld;
    else if (/^draft_\d$|^refine_\d$/.test(name)) result = fixtureManuscript;
    else if (name.endsWith("_heart")) result = fixtureAudit;
    else if (name.endsWith("_craft"))
      result = {
        ...fixtureCritic,
        repairs:
          this.weak || (this.firstWeak && name === "draft_1_craft")
            ? ["Make the ending more specific"]
            : [],
        scores: fixtureCritic.scores.map((s) => ({
          ...s,
          score:
            this.regress && name.startsWith("refine_") ? 2 : this.weak ? 3 : 4,
        })),
      };
    else if (name.endsWith("_poetics"))
      result = {
        version: POETICS_VERSION,
        findings: lenses.map((lens) => ({
          lens,
          status: "effective",
          spread: 1,
          quote: (data as { manuscript: typeof fixtureManuscript }).manuscript
            .spreads[0].text,
          analysis: "Scripted literary diagnosis, not creative validation.",
          repair: "",
          preserve: "Keep the protected family details.",
        })),
      };
    else if (name.endsWith("_meaning_review_v2"))
      result = {
        visibleCharacterIds:
          this.incorrectArt && !this.dismissArtAllegation
            ? []
            : (data as { expectedCharacterIds: string[] }).expectedCharacterIds,
        unexpectedForegroundCharacters: [],
        identityConsistent: true,
        actionReadable: true,
        physicalCoherence: true,
        childAppropriate: true,
        unwantedLettering: false,
        protectedContradictions: [],
        evidence: ["Scripted visual meaning check; not creative validation."],
        refinements: [],
      };
    else if (name.endsWith("_critique_evidence_v1"))
      result = {
        findings: (data as { allegations: { id: number }[] }).allegations.map(
          (a) => ({
            id: a.id,
            finding: this.dismissArtAllegation
              ? "not_substantiated"
              : "supported",
            requirement: "Exact cast",
            observation: "Synthetic missing member remains blocking",
          }),
        ),
      };
    else if (name === "scenes") result = fixtureScenes;
    else if (name === "wording_repair") {
      const d = data as { repair: { spreads: number[] } };
      result = {
        changes: d.repair.spreads.map((spread) => ({
          spread,
          text: fixtureManuscript.spreads[spread - 1].text.replace(
            "Nell",
            "Little Nell",
          ),
        })),
      };
    } else if (name === "scene_repair") {
      const d = data as { repair: { spreads: number[] } };
      result = {
        scenes: d.repair.spreads.map((n) => ({
          ...fixtureScenes.scenes[n - 1],
          action: "Repaired blue coat scene",
        })),
      };
    } else if (name === "character_repair") {
      const d = data as { original: (typeof fixtureWorld.characters)[number] };
      result = { ...d.original, outfit: "Green apron" };
    } else {
      if (!images.length) throw new Error("Actual pixels required");
      result = {
        correctnessDefects: this.incorrectArt ? ["Missing family member"] : [],
        identity: 4,
        style: this.weakImages ? 2 : this.artRefinements ? 3 : 4,
        actionReadability: 4,
        physicalCoherence: 4,
        evidence: [
          "Scripted image judgment; colored squares are not art approval.",
        ],
        defects: this.incorrectArt
          ? ["Missing family member"]
          : this.weakImages
            ? ["Wrong style"]
            : this.artRefinements
              ? ["Simplify brushwork"]
              : [],
      };
    }
    return schema.parse(result);
  }
  async image(_prompt: string, refs?: Buffer | Buffer[]) {
    this.imagePrompts.push(_prompt);
    this.calls.push(refs ? "image_with_references" : "image_new");
    this.imageReferenceCounts.push(
      Array.isArray(refs) ? refs.length : refs ? 1 : 0,
    );
    return sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: { r: this.calls.length % 255, g: 91, b: 123 },
      },
    })
      .png()
      .toBuffer();
  }
}
