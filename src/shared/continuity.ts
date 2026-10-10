import { z } from "zod";

export const ContinuityMode = z.enum(["auto", "new", "specific"]);
export type ContinuityMode = z.infer<typeof ContinuityMode>;
export const PinnedContinuity = z.object({
  mode: ContinuityMode,
  familyVersionIds: z.array(z.string().min(1)).max(200),
});
export type PinnedContinuity = z.infer<typeof PinnedContinuity>;
export interface ContinuityQuestion {
  id: string;
  kind: "identity" | "relationship";
  prompt: string;
  options: { id: string; label: string; detail?: string }[];
  allowUnspecified: boolean;
}
export interface ContinuityView {
  status: "needs_identity" | "resolved";
  question: ContinuityQuestion | null;
}
export interface ContinuityResponse {
  answerId: string;
  text?: string;
  key: string;
}
export interface ContinuityState {
  questions: ContinuityQuestion[];
  responses: Record<string, ContinuityResponse>;
}
