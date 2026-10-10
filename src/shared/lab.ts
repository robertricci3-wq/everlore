import { z } from "zod";
import { HeartContract } from "./studio.js";
import type { Profile } from "./profile.js";
export const CraftPrinciple = z.object({
  version: z.literal(1),
  id: z.string(),
  title: z.string(),
  area: z.enum(["story", "art", "book", "evaluation"]),
  perspective: z.string(),
  source: z.object({
    url: z.string().url(),
    title: z.string(),
    status: z.enum(["read", "abstract_only", "proposed_reading", "hypothesis"]),
  }),
  study: z
    .object({
      version: z.literal(1),
      technique: z.string(),
      appropriateUses: z.string(),
      originalExample: z.string(),
      evidenceStatus: z.literal("hypothesis_pending_experiment"),
    })
    .optional(),
  interpretation: z.string(),
  application: z.string(),
  counterexample: z.string(),
  evaluation: z.string(),
  evidence: z.array(
    z.object({
      experimentId: z.string(),
      finding: z.enum(["supports", "contradicts", "inconclusive"]),
      notes: z.string(),
    }),
  ),
});
export type Principle = z.infer<typeof CraftPrinciple>;
export const LabCase = z.object({
  partition: z.enum(["development", "held_out"]).optional(),
  version: z.literal(1),
  id: z.string(),
  title: z.string(),
  category: z.string(),
  synthetic: z.boolean(),
  source: z.string().min(10),
  heart: HeartContract,
  projectId: z.string().nullable(),
  consentAt: z.string().nullable(),
});
export type EvaluationCase = z.infer<typeof LabCase>;
export const ExperimentPlan = z.object({
  evaluationPhase: z.enum(["development", "release"]).default("development"),
  title: z.string().trim().min(3).max(100),
  hypothesis: z.string().trim().min(12).max(2000),
  risk: z.string().trim().min(8).max(1500),
  lane: z.enum(["story", "art", "book"]),
  candidateHash: z.string(),
  caseIds: z.array(z.string()).min(1).max(18),
  replicates: z.number().int().min(1).max(3),
  mode: z.enum(["offline", "live"]),
  criterion: z.enum([
    "family_specificity",
    "child_agency",
    "read_aloud",
    "earned_ending",
    "visual_expression",
    "visual_discovery",
    "whole_book",
  ]),
  principleIds: z.array(z.string()).min(1).max(10),
  prerequisiteIds: z.array(z.string()).max(3).default([]),
});
export const ObservationInput = z.object({
  pairKey: z.string(),
  role: z.enum([
    "owner_editor",
    "contributing_expert",
    "family_adult",
    "read_aloud_observer",
  ]),
  preference: z.enum(["A", "B", "tie", "inconclusive"]),
  evidence: z.string().trim().min(12).max(4000),
  concerns: z.string().max(2000),
  readerAge: z.number().int().min(4).max(7).nullable(),
  rereadRequested: z.boolean().nullable(),
  observed: z.string().max(3000),
});
export type Observation = z.infer<typeof ObservationInput>;
export interface LabRunView {
  id: string;
  pairKey: string;
  side: "A" | "B";
  caseTitle: string;
  replicate: number;
  status: string;
  stage: string;
  error: string | null;
  projectId: string | null;
  jobId: string | null;
  output: Record<string, unknown> | null;
  attempts: Array<{ stage: string; status: string; result: unknown }>;
  calls: Array<{
    stage: string;
    status: string;
    latencyMs: number | null;
    estimatedCents: number;
    actualCents: number | null;
    usage: string | null;
  }>;
}
export interface LabExperimentView {
  evaluationPhase: "development" | "release";
  id: string;
  title: string;
  hypothesis: string;
  risk: string;
  lane: "story" | "art" | "book";
  mode: "offline" | "live";
  status: string;
  planHash: string;
  baselineHash: string;
  candidateHash: string;
  criterion: string;
  replicates: number;
  maxCents: number;
  reservedCents: number;
  engineering: string;
  createdAt: string;
  caseIds: string[];
  error: string | null;
  canon: { status: string; projectId: string; hashes: string[] } | null;
  runs: LabRunView[];
  observations: Array<Observation & { id: string; createdAt: string }>;
  summary: {
    complete: number;
    total: number;
    wins: number;
    losses: number;
    ties: number;
    inconclusive: number;
    failures: number;
    repairs: number;
    reviewed: number;
    eligible: boolean;
    blockers: string[];
    worstCases: string[];
    costPerCompletedCents: number | null;
    actualCents: number | null;
    machineDisagreements: number;
    reveal: boolean;
  };
}
export interface LabView {
  allowed: boolean;
  ownerConfigured: boolean;
  activeHash: string;
  profiles: Profile[];
  principles: Principle[];
  cases: EvaluationCase[];
  artCases: Array<{ id: string; title: string; instruction: string }>;
  experiments: LabExperimentView[];
  releases: Array<{
    id: string;
    action: string;
    profileHash: string;
    previousHash: string;
    notes: string;
    createdAt: string;
  }>;
  providerConfigured: boolean;
  reserves: { text: number; image: number };
  message: string;
}
