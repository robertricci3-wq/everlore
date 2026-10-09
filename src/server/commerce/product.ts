import { z } from "zod";
import { PrintProduct, type PrintProductSpec } from "../../shared/print.js";
import { canonical, hash, now } from "../store.js";

/** Only authenticated catalogue data and a separately read manufacturer material source belong here. */
export function verifyPrintProduct(
  catalogue: unknown,
  sku: string,
  evidence: {
    spine?: unknown;
    materialEvidence?: { url: string; description: string };
  } = {},
): PrintProductSpec {
  const product = z
    .object({
      outcome: z.literal("Ok"),
      product: z.object({
        sku: z.string(),
        description: z.string().default(""),
        productDimensions: z.object({
          width: z.number(),
          height: z.number(),
          units: z.string(),
        }),
        printAreas: z.record(z.string(), z.object({ required: z.boolean() })),
        variants: z.array(
          z.object({
            shipsTo: z.array(z.string()),
            attributes: z.record(z.string(), z.string()).default({}),
          }),
        ),
      }),
    })
    .parse(catalogue).product;
  const factor: Record<string, number> = { mm: 1, cm: 10, in: 25.4 },
    multiplier = factor[product.productDimensions.units.toLowerCase()] ?? 0;
  if (
    product.sku !== sku ||
    Math.abs(product.productDimensions.width * multiplier - 210) > 1 ||
    Math.abs(product.productDimensions.height * multiplier - 210) > 1
  )
    throw new Error(
      "The selected product must be a verified 210 mm square hardcover.",
    );
  const matches = (description: string) =>
    /hard[ -]?(?:cover|back)/i.test(description) &&
    /matte?\b/i.test(description) &&
    /uncoated/i.test(description);
  const material = evidence.materialEvidence?.description ?? "";
  const variant = product.variants.find(
    (v) =>
      v.shipsTo.includes("US") &&
      !Object.entries(v.attributes).some(
        ([key, value]) =>
          (/finish|lamination|cover/i.test(key) &&
            /gloss|satin/i.test(value)) ||
          (/paper/i.test(key) &&
            /coated/i.test(value) &&
            !/uncoated/i.test(value)) ||
          (/binding/i.test(key) && /soft|paperback/i.test(value)),
      ) &&
      matches(
        `${product.description} ${Object.entries(v.attributes).flat().join(" ")} ${material}`,
      ),
  );
  if (!variant)
    throw new Error(
      "US availability, matte hardcover and uncoated paper must be confirmed in product evidence.",
    );
  const names = Object.entries(product.printAreas)
    .filter(([, v]) => v.required)
    .map(([k]) => k);
  if (
    !names.includes("default") ||
    names.some((k) => !["default", "spine"].includes(k))
  )
    throw new Error(
      "This product requires a print area not supported by the current layout.",
    );
  const requiredAssets: PrintProductSpec["requiredAssets"] = [
    { printArea: "default", widthMm: 210, heightMm: 210 },
  ];
  let spineHash: string | null = null;
  if (names.includes("spine")) {
    const spine = z
      .object({
        success: z.literal(true),
        spineInfo: z.object({ widthMm: z.number().positive().max(50) }),
      })
      .parse(evidence.spine);
    requiredAssets.push({
      printArea: "spine",
      widthMm: spine.spineInfo.widthMm,
      heightMm: 210,
    });
    spineHash = hash(canonical(evidence.spine));
  }
  return PrintProduct.parse({
    version: 1,
    provider: "prodigi",
    sku,
    widthMm: 210,
    heightMm: 210,
    interiorPages: 32,
    binding: "hardcover",
    coverFinish: "matte",
    paper: "uncoated",
    destination: "US",
    attributes: variant.attributes,
    requiredAssets,
    catalogue: {
      checkedAt: now(),
      responseHash: hash(canonical(catalogue)),
      description: product.description,
      materialEvidenceUrl: evidence.materialEvidence?.url ?? null,
      materialEvidenceDescription: material,
      materialEvidenceHash: evidence.materialEvidence
        ? hash(canonical(evidence.materialEvidence))
        : null,
      spineResponseHash: spineHash,
    },
  });
}
