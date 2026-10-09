import { z } from "zod";

export const PrintProduct = z.object({
  version: z.literal(1),
  provider: z.literal("prodigi"),
  sku: z.string().min(1),
  widthMm: z.literal(210),
  heightMm: z.literal(210),
  interiorPages: z.literal(32),
  binding: z.literal("hardcover"),
  coverFinish: z.literal("matte"),
  paper: z.literal("uncoated"),
  destination: z.literal("US"),
  attributes: z.record(z.string(), z.string()),
  requiredAssets: z
    .array(
      z.object({
        printArea: z.enum(["default", "spine"]),
        widthMm: z.number().positive(),
        heightMm: z.number().positive(),
      }),
    )
    .min(1),
  catalogue: z.object({
    checkedAt: z.string(),
    responseHash: z.string().length(64),
    description: z.string().optional(),
    materialEvidenceUrl: z.string().url().nullable(),
    materialEvidenceDescription: z.string().optional(),
    materialEvidenceHash: z.string().length(64).nullable().optional(),
    spineResponseHash: z.string().length(64).nullable(),
  }),
});
export type PrintProductSpec = z.infer<typeof PrintProduct>;
export type PrintColor = [number, number, number];
export interface PrintText {
  lines: string[];
  x: number;
  top: number;
  size: number;
  leading: number;
  color: PrintColor;
}
export interface PrintImage {
  hash: string;
  x: number;
  top: number;
  width: number;
  height: number;
}
export interface PrintPage {
  role:
    | "cover"
    | "title"
    | "dedication"
    | "invitation"
    | "story_art"
    | "story_text"
    | "true_parts"
    | "family_note"
    | "conversation"
    | "colophon"
    | "back_cover";
  spread?: number;
  background: PrintColor;
  text: PrintText[];
  images: PrintImage[];
}
export interface PrintLayout {
  version: 2;
  width: number;
  height: number;
  safeMargin: number;
  fontHash: string;
  pages: PrintPage[];
}
export interface PrintBundleV1 {
  version: 1;
  id: string;
  editionId: string;
  projectId: string;
  pdfHash: string;
  pageCount: number;
  widthMm: number;
  heightMm: number;
  minimumPpi: number;
  issues: string[];
  ready: boolean;
}
export interface PrintBundleV2 extends Omit<PrintBundleV1, "version"> {
  version: 2;
  product: PrintProductSpec | null;
  productHash: string;
  layout: PrintLayout;
  layoutHash: string;
  assets: {
    printArea: "default" | "spine";
    pdfHash: string;
    pageCount: number;
  }[];
  imageResolutions: {
    hash: string;
    width: number;
    height: number;
    minimumPpi: number;
  }[];
}
export type PrintBundle = PrintBundleV1 | PrintBundleV2;
