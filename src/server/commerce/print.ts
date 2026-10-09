import { PDFDocument, rgb, type PDFFont, type PDFImage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import sharp from "sharp";
import { Book, type BookDocument } from "../../shared/contracts.js";
import {
  PrintProduct,
  type PrintBundle,
  type PrintBundleV2,
  type PrintLayout,
  type PrintPage,
  type PrintColor,
  type PrintProductSpec,
} from "../../shared/print.js";
import { fontBytes } from "../layout.js";
import { Store, hash, canonical, id, now } from "../store.js";
export type { PrintBundle } from "../../shared/print.js";
export { verifyPrintProduct } from "./product.js";

function migrate(s: Store) {
  s.run(
    "CREATE TABLE IF NOT EXISTS print_bundle_versions(id TEXT PRIMARY KEY,editionId TEXT NOT NULL,projectId TEXT NOT NULL,productHash TEXT NOT NULL,layoutVersion INTEGER NOT NULL,body TEXT NOT NULL,createdAt TEXT NOT NULL,UNIQUE(editionId,productHash,layoutVersion))",
  );
}
export function loadPrintBundle(s: Store, bundleId: string): PrintBundle {
  migrate(s);
  const row =
    s.one<{ body: string }>(
      "SELECT body FROM print_bundle_versions WHERE id=?",
      bundleId,
    ) ??
    s.one<{ body: string }>(
      "SELECT body FROM print_bundles WHERE id=?",
      bundleId,
    );
  if (!row) throw new Error("Saved print bundle unavailable.");
  return JSON.parse(row.body);
}
export function latestPrintBundle(
  s: Store,
  editionId: string,
): PrintBundle | null {
  migrate(s);
  const row =
    s.one<{ body: string }>(
      "SELECT body FROM print_bundle_versions WHERE editionId=? ORDER BY rowid DESC LIMIT 1",
      editionId,
    ) ??
    s.one<{ body: string }>(
      "SELECT body FROM print_bundles WHERE editionId=?",
      editionId,
    );
  return row ? JSON.parse(row.body) : null;
}
const paper: PrintColor = [0.98, 0.965, 0.925],
  ink: PrintColor = [0.18, 0.23, 0.19],
  muted: PrintColor = [0.37, 0.43, 0.34],
  forest: PrintColor = [0.2, 0.35, 0.28];
const points = (mm: number) => (mm * 72) / 25.4;
function lines(text: string, font: PDFFont, width: number, size: number) {
  const result: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (font.widthOfTextAtSize(word, size) > width)
        throw new Error("A word does not fit the print layout.");
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width) {
        result.push(line);
        line = word;
      } else line = next;
    }
    if (line) result.push(line);
  }
  return result;
}
async function buildLayout(book: BookDocument): Promise<PrintLayout> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes(), { subset: true }),
    size = points(210),
    margin = 36;
  const layout: PrintLayout = {
    version: 2,
    width: size,
    height: size,
    safeMargin: margin,
    fontHash: hash(fontBytes()),
    pages: [],
  };
  const add = (role: PrintPage["role"], background = paper) => {
    const p: PrintPage = { role, background, text: [], images: [] };
    layout.pages.push(p);
    return p;
  };
  const text = (
    p: PrintPage,
    value: string,
    top: number,
    fontSize = 20,
    color = ink,
    centered = false,
    width = size - 2 * margin,
  ) => {
    const wrapped = lines(value, font, width, fontSize),
      leading = fontSize * 1.5;
    if (top + (wrapped.length - 1) * leading > size - margin)
      throw new Error("Text overflows the print page.");
    if (centered)
      for (const [i, line] of wrapped.entries())
        p.text.push({
          lines: [line],
          x: (size - font.widthOfTextAtSize(line, fontSize)) / 2,
          top: top + i * leading,
          size: fontSize,
          leading,
          color,
        });
    else
      p.text.push({
        lines: wrapped,
        x: margin,
        top,
        size: fontSize,
        leading,
        color,
      });
  };
  const image = (p: PrintPage, index: number, top: number, width: number) =>
    p.images.push({
      hash: book.spreads[index].artHash,
      x: (size - width) / 2,
      top,
      width,
      height: width,
    });
  const label = (p: PrintPage, value: string) =>
    text(p, value, 65, 11, muted, true);
  const titleText = (
    p: PrintPage,
    top: number,
    preferredSize: number,
    maxLines: number,
  ) => {
    let fontSize = preferredSize;
    while (
      fontSize > 18 &&
      lines(book.title, font, size - 2 * margin, fontSize).length > maxLines
    )
      fontSize--;
    if (lines(book.title, font, size - 2 * margin, fontSize).length > maxLines)
      throw new Error(
        "The book title needs editorial shortening for this cover.",
      );
    text(p, book.title, top, fontSize, ink, true);
  };
  const cover = add("cover");
  image(cover, 0, 42, 330);
  titleText(cover, 425, 27, 3);
  text(cover, book.byline, 535, 12, muted, true);
  const title = add("title");
  label(title, "A FAMILY STORY FROM EVERLORE");
  titleText(title, 160, 30, 2);
  image(title, 0, 245, 190);
  text(title, book.byline, 505, 16, muted, true);
  const dedication = add("dedication");
  label(dedication, "FOR OUR FAMILY");
  text(
    dedication,
    "For the little listeners,\nand the people whose stories\nhelp them grow.",
    245,
    24,
    ink,
    true,
  );
  const invitation = add("invitation");
  label(invitation, "COME A LITTLE CLOSER");
  image(invitation, 1, 115, 245);
  text(
    invitation,
    "A memory begins with someone.\nA story grows when we share it.",
    420,
    22,
    ink,
    true,
  );
  for (const [i, spread] of book.spreads.entries()) {
    const art = add("story_art");
    art.spread = i + 1;
    image(art, i, margin, size - margin * 2);
    const words = add("story_text");
    words.spread = i + 1;
    const count = lines(spread.text, font, size - 2 * margin, 21).length;
    text(words, spread.text, Math.max(110, (size - count * 31.5) / 2 + 21), 21);
    text(words, String(i + 1).padStart(2, "0"), size - 40, 10, muted, true);
  }
  const truth =
    book.production?.manuscript.trueParts ??
    (book.mode === "synthetic_fixture"
      ? "This example begins with a synthetic family memory. Its people, events and illustrations show how an Everlore story can work. It does not describe a real family's history."
      : "Inspired by a family memory. Scenes and dialogue may be imagined. The original remembered words remain separate from this illustrated telling.");
  const truthLines = lines(truth, font, size - 2 * margin, 18);
  if (truthLines.length > 28)
    throw new Error(
      "The True Parts need editorial shortening for this 32-page format.",
    );
  const midpoint = Math.ceil(truthLines.length / 2);
  for (const [i, chunk] of [
    truthLines.slice(0, midpoint),
    truthLines.slice(midpoint),
  ].entries()) {
    const p = add("true_parts");
    label(p, "THE MEMORY BEHIND THE STORY");
    text(p, i ? "The True Parts, continued" : "The True Parts", 125, 26);
    p.text.push({
      lines: chunk,
      x: margin,
      top: 180,
      size: 18,
      leading: 27,
      color: ink,
    });
    if (180 + Math.max(0, chunk.length - 1) * 27 > size - margin)
      throw new Error("Source note overflows the print page.");
    text(
      p,
      "Inspired by a memory. Open to a little wonder.",
      548,
      12,
      muted,
      true,
    );
  }
  const family = add("family_note");
  label(family, "A PLACE IN YOUR FAMILY'S STORY");
  text(family, "There is always more to tell.", 145, 26);
  text(
    family,
    `${book.byline}\n\nKeep the remembered words alongside this imagined telling. The details that matter to your family are part of what makes this book yours.`,
    225,
    20,
  );
  const conversation = add("conversation");
  label(conversation, "WHEN THE BOOK CLOSES");
  text(conversation, "Tell me another.", 145, 30);
  text(
    conversation,
    "Which picture would you step into?\nWhat surprised you?\nWhat does this story remind you of?\n\nAsk someone you love for a memory.\nIt might be the beginning of the next book.",
    235,
    21,
  );
  const colophon = add("colophon");
  label(colophon, "EVERLORE");
  text(colophon, "Your life. Their wonder.", 155, 28, ink, true);
  text(
    colophon,
    book.artMode === "designed_sample"
      ? "An original Everlore example.\nSynthetic memory and designed sample illustrations.\nA beginning for a family's growing collection."
      : "An original illustrated family telling.\nStory and illustrations created with AI assistance.\nPrinted as part of a family's growing collection.",
    270,
    16,
    muted,
    true,
  );
  text(
    colophon,
    `Edition revision ${book.revision}\nAges 4-7\nTwelve story spreads`,
    400,
    13,
    muted,
    true,
  );
  const back = add("back_cover", forest);
  image(back, 11, 80, 290);
  text(back, "Some stories become part of us.", 438, 24, paper, true);
  text(back, "EVERLORE", 530, 12, paper, true);
  if (layout.pages.length !== 34)
    throw new Error(
      "The hardcover layout requires 32 interior pages and two covers.",
    );
  return layout;
}
async function renderPdf(
  s: Store,
  projectId: string,
  layout: PrintLayout,
  title: string,
) {
  if (layout.fontHash !== hash(fontBytes()))
    throw new Error("The saved print font changed.");
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(title);
  pdf.setAuthor("Everlore");
  pdf.setCreationDate(new Date(0));
  pdf.setModificationDate(new Date(0));
  const font = await pdf.embedFont(fontBytes(), { subset: true }),
    images = new Map<string, PDFImage>();
  for (const page of layout.pages) {
    const p = pdf.addPage([layout.width, layout.height]);
    p.drawRectangle({
      x: 0,
      y: 0,
      width: layout.width,
      height: layout.height,
      color: rgb(...page.background),
    });
    for (const img of page.images) {
      if (!images.has(img.hash))
        images.set(
          img.hash,
          await pdf.embedPng(
            await sharp(s.readAsset(projectId, img.hash))
              .flatten({ background: "#faf6ec" })
              .png()
              .toBuffer(),
          ),
        );
      const embedded = images.get(img.hash)!,
        scale = Math.min(
          img.width / embedded.width,
          img.height / embedded.height,
        ),
        width = embedded.width * scale,
        height = embedded.height * scale;
      p.drawImage(embedded, {
        x: img.x + (img.width - width) / 2,
        y: layout.height - img.top - (img.height + height) / 2,
        width,
        height,
      });
    }
    for (const t of page.text)
      for (const [i, line] of t.lines.entries())
        p.drawText(line, {
          x: t.x,
          y: layout.height - t.top - i * t.leading,
          size: t.size,
          font,
          color: rgb(...t.color),
        });
  }
  return Buffer.from(await pdf.save());
}
/** Preview uses the saved geometry and exact font outlines also consumed by PDF rendering. */
export async function renderPrintPreview(
  s: Store,
  bundle: PrintBundleV2,
  pageIndex: number,
) {
  const { layout } = bundle,
    page = layout.pages[pageIndex];
  if (
    !page ||
    layout.fontHash !== hash(fontBytes()) ||
    hash(canonical(layout)) !== bundle.layoutHash
  )
    throw new Error("Print preview unavailable.");
  const font = fontkit.create(fontBytes());
  if (!("layout" in font)) throw new Error("Print font unavailable.");
  const color = (c: PrintColor) =>
    `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
  const paths = page.text
    .flatMap((t) =>
      t.lines.map((line, index) => {
        const run = font.layout(line),
          scale = t.size / font.unitsPerEm;
        let pen = 0;
        return run.glyphs
          .map((g, i) => {
            const pos = run.positions[i],
              result = `<path fill="${color(t.color)}" d="${g.path.toSVG()}" transform="translate(${t.x + (pen + pos.xOffset) * scale} ${t.top + index * t.leading - pos.yOffset * scale}) scale(${scale} ${-scale})"/>`;
            pen += pos.xAdvance;
            return result;
          })
          .join("");
      }),
    )
    .join("");
  const images = (
    await Promise.all(
      page.images.map(
        async (img) =>
          `<image x="${img.x}" y="${img.top}" width="${img.width}" height="${img.height}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${(await sharp(s.readAsset(bundle.projectId, img.hash)).flatten({ background: "#faf6ec" }).png().toBuffer()).toString("base64")}"/>`,
      ),
    )
  ).join("");
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}"><rect width="100%" height="100%" fill="${color(page.background)}"/>${images}${paths}</svg>`,
    ),
  )
    .png()
    .toBuffer();
}
export async function preparePrint(
  s: Store,
  projectId: string,
  editionId: string,
  options: { product?: PrintProductSpec } = {},
): Promise<PrintBundle> {
  migrate(s);
  const product = options.product ? PrintProduct.parse(options.product) : null;
  const productHash = hash(
    canonical(
      product
        ? { ...product, catalogue: { ...product.catalogue, checkedAt: null } }
        : null,
    ),
  );
  const existing = s.one<{ body: string }>(
    "SELECT body FROM print_bundle_versions WHERE editionId=? AND projectId=? AND productHash=? AND layoutVersion=2",
    editionId,
    projectId,
    productHash,
  );
  if (existing) return JSON.parse(existing.body);
  const edition = s.one<{ book: string }>(
    "SELECT book FROM editions WHERE id=? AND projectId=?",
    editionId,
    projectId,
  );
  if (!edition) throw new Error("Saved edition unavailable.");
  const book = Book.parse(JSON.parse(edition.book)),
    layout = await buildLayout(book),
    issues: string[] = [];
  const imageResolutions: PrintBundleV2["imageResolutions"] = [];
  for (const digest of new Set(
    layout.pages.flatMap((p) => p.images.map((i) => i.hash)),
  )) {
    const meta = await sharp(s.readAsset(projectId, digest)).metadata(),
      usages = layout.pages.flatMap((p) =>
        p.images.filter((i) => i.hash === digest),
      );
    const ppi = Math.min(
      ...usages.map((i) =>
        Math.min(
          (meta.width ?? 0) / (i.width / 72),
          (meta.height ?? 0) / (i.height / 72),
        ),
      ),
    );
    imageResolutions.push({
      hash: digest,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      minimumPpi: Math.floor(ppi),
    });
  }
  const minPpi = Math.min(...imageResolutions.map((i) => i.minimumPpi));
  if (minPpi < 300)
    issues.push(
      `Artwork resolves to ${minPpi} pixels per inch; this format requires 300. Original high-resolution art is needed.`,
    );
  if (book.production?.artStatus === "revision_recommended")
    issues.push("Artwork still has unresolved review-copy refinements.");
  if (!product)
    issues.push(
      "A catalogue-verified hardcover product has not been selected.",
    );
  const bytes = await renderPdf(s, projectId, layout, book.title),
    digest = s.putAsset(projectId, bytes, "print-pdf");
  const assets: PrintBundleV2["assets"] = [
    { printArea: "default", pdfHash: digest, pageCount: 34 },
  ];
  const spine = product?.requiredAssets.find((a) => a.printArea === "spine");
  if (spine) {
    // A coordinated solid spine needs no guessed wraparound geometry or minuscule lettering.
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([points(spine.widthMm), points(spine.heightMm)]);
    pdf.setCreationDate(new Date(0));
    pdf.setModificationDate(new Date(0));
    page.drawRectangle({
      x: 0,
      y: 0,
      width: page.getWidth(),
      height: page.getHeight(),
      color: rgb(...forest),
    });
    assets.push({
      printArea: "spine",
      pdfHash: s.putAsset(
        projectId,
        Buffer.from(await pdf.save()),
        "print-pdf",
      ),
      pageCount: 1,
    });
  }
  const bundle: PrintBundleV2 = {
    version: 2,
    id: id(),
    editionId,
    projectId,
    pdfHash: digest,
    pageCount: 34,
    widthMm: 210,
    heightMm: 210,
    minimumPpi: minPpi,
    issues,
    ready: issues.length === 0,
    product,
    productHash,
    layout,
    layoutHash: hash(canonical(layout)),
    assets,
    imageResolutions,
  };
  s.run(
    "INSERT OR IGNORE INTO print_bundle_versions VALUES(?,?,?,?,?,?,?)",
    bundle.id,
    editionId,
    projectId,
    productHash,
    2,
    JSON.stringify(bundle),
    now(),
  );
  return JSON.parse(
    s.one<{ body: string }>(
      "SELECT body FROM print_bundle_versions WHERE editionId=? AND productHash=? AND layoutVersion=2",
      editionId,
      productHash,
    )!.body,
  );
}
