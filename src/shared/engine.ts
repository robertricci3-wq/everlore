import { z } from "zod";
import { Claim, Person } from "./contracts.js";

export const ENGINE_VERSION = "legacy-1";
export const Kernel = z.object({
  emotionalInheritance: z.string(),
  relationshipHeart: z.string(),
  childDesire: z.string(),
  personalSpecifics: z.array(z.string()).min(2),
  anchors: z.array(Claim).min(1),
  sensitiveBoundaries: z.array(z.string()),
});
export const Outline = z.object({
  premise: z.string(),
  transformation: z.string(),
  refrain: z.string(),
  endingEcho: z.string(),
  beats: z
    .array(
      z.object({
        spread: z.number().int().min(1).max(12),
        action: z.string(),
        emotionalChange: z.string(),
        pageTurn: z.string(),
        visualSurprise: z.string(),
      }),
    )
    .length(12),
});
export const Manuscript = z.object({
  title: z.string().min(1).max(65),
  byline: z.string().max(70),
  people: z.array(Person).min(1),
  artBible: z.object({
    medium: z.string(),
    palette: z.string(),
    worldRules: z.string(),
    recurringMotif: z.string(),
    characterReference: z.string(),
  }),
  inventions: z.array(z.string()).min(1),
  spreads: z
    .array(
      z.object({
        text: z.string().min(1).max(700),
        anchorIds: z.array(z.string()).min(1),
        characterIds: z.array(z.string()),
        artDirection: z.string(),
        composition: z.enum([
          "wide",
          "medium",
          "close",
          "overhead",
          "low_angle",
        ]),
        visualDiscovery: z.string(),
      }),
    )
    .length(12),
});
export const CraftReview = z.object({
  scores: z.object({
    emotionalHeart: z.number().int().min(1).max(5),
    childAgency: z.number().int().min(1).max(5),
    momentum: z.number().int().min(1).max(5),
    readAloud: z.number().int().min(1).max(5),
    specificity: z.number().int().min(1).max(5),
    earnedEnding: z.number().int().min(1).max(5),
    visualStorytelling: z.number().int().min(1).max(5),
  }),
  evidence: z
    .array(
      z.object({
        spread: z.number().int().min(1).max(12),
        observation: z.string(),
      }),
    )
    .min(3),
  repairs: z.array(z.string()),
  blockingIssues: z.array(z.string()),
});
export const ArtReview = z.object({
  observations: z.array(z.string()).min(1),
  blockingIssues: z.array(z.string()),
  characterContinuity: z.number().int().min(1).max(5),
  childReadability: z.number().int().min(1).max(5),
  visualCraft: z.number().int().min(1).max(5),
});
export const EngineConsent = z.object({
  processWithOpenAI: z.literal(true),
  imaginativeAdaptation: z.literal(true),
  legacyWish: z.string().trim().max(1000).default(""),
});
export interface EngineAvailability {
  ready: boolean;
  message: string;
}
export interface EngineView {
  id: string;
  status: string;
  stage: string;
  error: string | null;
  transcript: string | null;
  preview: {
    title: string;
    heart: string;
    inventions: string[];
    spreads: { text: string; artHash: string; artDescription: string }[];
  } | null;
}
