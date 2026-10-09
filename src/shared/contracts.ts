import { z } from "zod";
import { ProductionSnapshot } from "./studio.js";

export const Mode = z.enum([
  "synthetic_fixture",
  "manual",
  "unavailable",
  "live",
]);
export const Segment = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  startMs: z.number().nonnegative().nullable(),
  endMs: z.number().nonnegative().nullable(),
});
export const Transcript = z.object({
  version: z.literal(1),
  mode: Mode,
  rawText: z.string().min(1).max(50000),
  segments: z.array(Segment).min(1),
  recordingId: z.string().nullable(),
});
export const Claim = z.object({
  id: z.string(),
  type: z.enum([
    "person",
    "relationship",
    "event",
    "sensory",
    "feeling",
    "time",
    "place",
  ]),
  text: z.string(),
  sourceIds: z.array(z.string()).min(1),
  certainty: z.enum(["stated", "uncertain", "clarified"]),
  clarification: z.string().nullable(),
});
export const Person = z.object({
  id: z.string(),
  name: z.string().min(1).max(50),
  relationship: z.string(),
  depictedAge: z.number().int().positive().nullable(),
  appearance: z.string(),
  appearanceSource: z.literal("artistic_design"),
});
export const Spread = z.object({
  id: z.string(),
  text: z.string().min(1),
  claimIds: z.array(z.string()).min(1),
  scene: z.number().int().min(0).max(11),
  artHash: z.string(),
  artDescription: z.string(),
  characterIds: z.array(z.string()),
  lines: z.array(z.string()),
});
export const Book = z
  .object({
    version: z.literal(1),
    revision: z.number().int().positive(),
    title: z.string().min(1),
    byline: z.string(),
    mode: Mode,
    artMode: z.enum(["designed_sample", "generated"]),
    adaptation: z
      .object({
        version: z.string(),
        emotionalInheritance: z.string(),
        premise: z.string(),
        inventions: z.array(z.string()),
        disclosure: z.literal(
          "An imaginative story inspired by a family memory.",
        ),
      })
      .optional(),
    production: ProductionSnapshot.optional(),
    ageBand: z.literal("4–7"),
    transcript: Transcript,
    ledger: z.array(Claim).min(1),
    people: z.array(Person),
    spreads: z.array(Spread).length(12),
    sourceHash: z.string(),
    contentHash: z.string(),
    printReady: z.literal(false),
    reviewFlags: z.array(z.string()),
    layout: z.object({
      version: z.literal(1),
      width: z.literal(1200),
      height: z.literal(600),
      fontSize: z.literal(24),
      lineHeight: z.literal(38),
      textX: z.literal(680),
      textWidth: z.literal(450),
      textY: z.number(),
    }),
  })
  .superRefine((book, ctx) => {
    const sources = new Set(book.transcript.segments.map((s) => s.id));
    const claims = new Set(book.ledger.map((c) => c.id));
    const people = new Set(book.people.map((p) => p.id));
    if (
      sources.size !== book.transcript.segments.length ||
      claims.size !== book.ledger.length ||
      new Set(book.spreads.map((s) => s.id)).size !== 12
    )
      ctx.addIssue({ code: "custom", message: "IDs must be unique" });
    for (const c of book.ledger)
      if (c.sourceIds.some((id) => !sources.has(id)))
        ctx.addIssue({
          code: "custom",
          message: "Claim references missing source",
        });
    for (const s of book.spreads) {
      if (
        s.claimIds.some((id) => !claims.has(id)) ||
        s.characterIds.some((id) => !people.has(id))
      )
        ctx.addIssue({
          code: "custom",
          message: "Spread references missing claim or person",
        });
      if (s.lines.length > 10)
        ctx.addIssue({ code: "custom", message: "Text does not fit" });
    }
    const count = wordCount(book.spreads.map((s) => s.text).join(" "));
    if (count < 250 || count > 450)
      ctx.addIssue({
        code: "custom",
        message: "Manuscript must have 250–450 words",
      });
  });
export type BookDocument = z.infer<typeof Book>;
export type TranscriptDocument = z.infer<typeof Transcript>;
export type ClaimDocument = z.infer<typeof Claim>;
export const Credentials = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-zA-Z0-9 _-]+$/),
  password: z.string().min(10).max(128),
  adult: z.literal(true),
});
export const Login = Credentials.omit({ adult: true });
export const RevisionRequest = z.object({
  baseRevision: z.number().int().positive(),
  personId: z.string(),
  newName: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[\p{L}][\p{L} '-]*$/u),
  key: z.string().uuid(),
});
export const Approval = z.object({
  baseRevision: z.number().int().positive(),
  contentHash: z.string().length(64),
});
export const ManualTranscript = z.object({
  rawText: z.string().trim().min(10).max(50000),
  attested: z.literal(true),
});
export const Correction = z.object({
  baseRevision: z.number().int().positive(),
  detail: z.string().trim().min(3).max(2000),
  spreadId: z.string().nullable(),
  kind: z.enum(["fact", "picture"]),
});
export function wordCount(text: string) {
  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}
export interface ProjectSummary {
  id: string;
  title: string;
  mode: string;
  status: string;
  revision: number;
  createdAt: string;
}
export interface JobView {
  id: string;
  status: string;
  stage: string;
  error: string | null;
  attempt: number;
}
export interface EditionView {
  id: string;
  revision: number;
  contentHash: string;
  pdfHash: string;
  createdAt: string;
}
export interface RecordingView {
  id: string;
  mime: string;
  bytes: number;
  sha256: string;
  captureMode: string;
  createdAt: string;
}
export interface ProjectView extends ProjectSummary {
  engine?:
    import("./engine.js").EngineView | import("./studio.js").StudioView | null;
  book: BookDocument | null;
  transcript: TranscriptDocument | null;
  jobs: JobView[];
  editions: EditionView[];
  recording: RecordingView | null;
  corrections: { id: string; detail: string; kind: string; status: string }[];
}
