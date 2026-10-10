import { z } from "zod";

export const FAMILY_CONSENT_VERSION = "family-memory-v1" as const;
export const FAMILY_CONSENT_TEXT = {
  collection: "Save my words and recordings privately on my family shelf.",
  processing:
    "Use AI to transcribe my recordings and make my books when I ask.",
  adaptation:
    "Turn my memories into imaginative stories while preserving their heart.",
} as const;
const key = z.string().trim().min(1).max(100);
export const JourneyStart = z.object({
  key,
  consent: z.literal(true).optional(),
  consentVersion: z.literal(FAMILY_CONSENT_VERSION).optional(),
  processWithOpenAI: z.literal(true).optional(),
  imaginativeAdaptation: z.literal(true).optional(),
  invitationId: z.string().min(1).optional(),
});
export const JourneyCreate = z.object({
  key,
  consentVersion: z.literal(FAMILY_CONSENT_VERSION),
  processWithOpenAI: z.literal(true),
  imaginativeAdaptation: z.literal(true),
  familyVersionId: z.string().min(1).nullable().optional(),
  continuityMode: z.enum(["auto", "new", "specific"]).default("auto"),
});
export interface JourneySetup {
  consentVersion: typeof FAMILY_CONSENT_VERSION;
  consented: boolean;
  aiProcessingConsented: boolean;
  adaptationConsented: boolean;
  canCreate: boolean;
}
export interface JourneyView {
  sessionId: string;
  requestId: string | null;
  status: "saved" | "transcribing" | "creating" | "paused" | "ready";
  message: string;
  projectId: string | null;
  bookReady: boolean;
  canCreate: boolean;
}
