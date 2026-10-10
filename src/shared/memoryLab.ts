import type { GuideDecisionRecord, InterviewSessionRecord } from "./almanac.js";
import type { MemoryGuideProfileRecord } from "./memoryGuide.js";
import type { MemoryInvitationRecord } from "./invitations.js";

export interface MemoryPolicyCase {
  id: string;
  title: string;
  category: string;
  synthetic: true;
  session: InterviewSessionRecord;
  invitation: MemoryInvitationRecord;
  expected: {
    baseline: { action: GuideDecisionRecord["action"]; promptSuffix?: string };
    candidate: { action: GuideDecisionRecord["action"]; promptSuffix?: string };
  };
}
export interface MemoryPolicyPlan {
  version: 1;
  hypothesis: string;
  risk: string;
  criterion: string;
  caseVersion: string;
  replicates: 3;
  baseline: MemoryGuideProfileRecord;
  candidate: MemoryGuideProfileRecord;
  baselineHash: string;
  candidateHash: string;
  implementationHash: string;
  cases: MemoryPolicyCase[];
}
export interface MemoryPolicyRun {
  caseId: string;
  replicate: number;
  arm: "baseline" | "candidate";
  profileHash: string;
  sourceHash: string;
  output: GuideDecisionRecord;
  assertions: string[];
  failures: string[];
}
export interface MemoryComparisonSummary {
  pairCount: number;
  complete: number;
  total: number;
  candidateWins: number;
  baselineWins: number;
  ties: number;
  failures: number;
  providerCalls: 0;
  engineeringOnly: true;
  promotionEligible: false;
  verdict: "incomplete" | "policy_supported" | "inconclusive";
  limitation: string;
}
export interface MemoryExperimentView {
  id: string;
  status: "planned" | "paused" | "complete" | "needs_attention";
  planHash: string;
  plan: MemoryPolicyPlan;
  runs: MemoryPolicyRun[];
  summary: MemoryComparisonSummary;
  createdAt: string;
  error: string | null;
}
