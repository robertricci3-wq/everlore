import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { Book, type BookDocument } from "../shared/contracts.js";
import { canonical, hash, type Store } from "./store.js";

export const fontBytes = () =>
  readFileSync(resolve("public/fonts/literata-latin-400-normal.woff"));
let measureFont: Promise<PDFFont> | undefined;
function getMeasureFont() {
  return (measureFont ??= (async () => {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    return pdf.embedFont(fontBytes(), { subset: true });
  })());
}
export function wrapText(
  text: string,
  font: Pick<PDFFont, "widthOfTextAtSize">,
  width = 450,
  size = 24,
) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (font.widthOfTextAtSize(word, size) > width)
      throw new Error(
        "A word is too wide for this review layout. Please shorten it.",
      );
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  if (lines.length > 10) throw new Error("Text needs a shorter layout.");
  return lines;
}
export async function finalizeBook(input: BookDocument) {
  const book = structuredClone(input),
    font = await getMeasureFont();
  for (const spread of book.spreads) spread.lines = wrapText(spread.text, font);
  book.sourceHash = hash(canonical(book.transcript));
  book.contentHash = "";
  book.contentHash = hash(canonical({ ...book, fontHash: hash(fontBytes()) }));
  return Book.parse(book);
}
export function textTop(book: BookDocument, index: number) {
  return (
    (book.layout.height -
      book.spreads[index].lines.length * book.layout.lineHeight) /
      2 +
    22
  );
}
export async function renderPdf(
  book: BookDocument,
  store: Store,
  projectId: string,
) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`${book.title} — review copy`);
  pdf.setAuthor("Everlore");
  pdf.setSubject(
    `${book.adaptation ? "Imaginative family adaptation" : "Synthetic fixture"}. Revision ${book.revision}. ${book.contentHash}. NOT PRINT READY.`,
  );
  pdf.setCreationDate(new Date(0));
  pdf.setModificationDate(new Date(0));
  const font = await pdf.embedFont(fontBytes(), { subset: true });
  const ink = rgb(0.17, 0.21, 0.17),
    muted = rgb(0.4, 0.43, 0.36),
    paper = rgb(0.98, 0.96, 0.91);
  const draw = (
    page: ReturnType<typeof pdf.addPage>,
    text: string,
    x: number,
    top: number,
    size: number,
    color = ink,
  ) => page.drawText(text, { x, y: 600 - top, size, font, color });
  const cover = pdf.addPage([1200, 600]);
  cover.drawRectangle({ x: 0, y: 0, width: 1200, height: 600, color: paper });
  const coverImage = await pdf.embedPng(
    await sharp(store.readAsset(projectId, book.spreads[0].artHash))
      .png()
      .toBuffer(),
  );
  cover.drawImage(coverImage, { x: 0, y: 0, width: 600, height: 600 });
  draw(cover, "EVERLORE  /  A STORY TO KEEP", 670, 150, 16, muted);
  const titleLines = wrapText(book.title, font, 470, 42);
  titleLines.forEach((line, i) => draw(cover, line, 670, 236 + i * 57, 42));
  draw(cover, book.byline, 670, 390, 20);
  draw(
    cover,
    book.adaptation
      ? "Inspired by a family memory · AI illustrations"
      : "Synthetic example · designed sample illustrations",
    670,
    477,
    13,
    muted,
  );
  draw(
    cover,
    `Review copy · Revision ${book.revision} · Not print ready`,
    670,
    510,
    13,
    muted,
  );
  for (const [i, spread] of book.spreads.entries()) {
    const page = pdf.addPage([1200, 600]);
    page.drawRectangle({ x: 0, y: 0, width: 1200, height: 600, color: paper });
    const image = await pdf.embedPng(
      await sharp(store.readAsset(projectId, spread.artHash)).png().toBuffer(),
    );
    page.drawImage(image, { x: 0, y: 0, width: 600, height: 600 });
    draw(page, "EVERLORE / A FAMILY STORY", 680, 67, 12, muted);
    spread.lines.forEach((line, n) =>
      draw(
        page,
        line,
        book.layout.textX,
        textTop(book, i) + n * book.layout.lineHeight,
        book.layout.fontSize,
      ),
    );
    draw(page, `${String(i + 1).padStart(2, "0")} / 12`, 680, 540, 14, muted);
    draw(
      page,
      `Review copy · ${book.adaptation ? "Imaginative adaptation" : "Synthetic example"} · Revision ${book.revision}`,
      680,
      570,
      11,
      muted,
    );
  }
  if (book.production) {
    const words = book.production.manuscript.trueParts;
    // Paginate this adult/source note independently of the twelve story spreads.
    const lines: string[] = [];
    let line = "";
    for (const word of words.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(word, 22) > 1000)
        throw new Error("Source note contains an overlong word");
      if (font.widthOfTextAtSize(candidate, 22) > 1000) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
    for (let start = 0; start < lines.length; start += 10) {
      const note = pdf.addPage([1200, 600]);
      note.drawRectangle({
        x: 0,
        y: 0,
        width: 1200,
        height: 600,
        color: paper,
      });
      draw(
        note,
        start ? "The True Parts, continued" : "The True Parts",
        80,
        90,
        34,
      );
      lines
        .slice(start, start + 10)
        .forEach((l, i) => draw(note, l, 80, 160 + i * 34, 22));
      draw(
        note,
        "The remembered heart, and the story we imagined around it.",
        80,
        550,
        14,
        muted,
      );
    }
  }
  const colophon = pdf.addPage([1200, 600]);
  colophon.drawRectangle({
    x: 0,
    y: 0,
    width: 1200,
    height: 600,
    color: paper,
  });
  draw(colophon, "A memory, kept with care.", 80, 110, 34);
  const details = [
    book.byline,
    "12 digital spreads · Ages 4–7 · 250–450-word editorial target",
    book.adaptation
      ? "An imaginative adaptation of a family memory. Scenes and dialogue may be invented."
      : "This book uses a synthetic memory and original designed vector sample illustrations.",
    book.production?.editorialStatus === "revision_recommended" ||
    book.production?.artStatus === "revision_recommended"
      ? "Story or art refinements remain. This is a review copy, not final creative approval or a print file."
      : "Creative checks are provisional. This is a review copy, not a validated print file.",
    `Revision: ${book.revision}`,
    `Content SHA-256: ${book.contentHash}`,
    `Immutable source SHA-256: ${book.sourceHash}`,
    `Font SHA-256: ${hash(fontBytes())}`,
  ];
  details.forEach((line, i) =>
    draw(colophon, line, 80, 185 + i * 39, i > 4 ? 13 : 18, muted),
  );
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

// Render the same measured lines, font outlines and coordinates used by PDF/reader.
// These are evaluation panels; original illustration files remain unchanged.
export async function renderBookPanels(
  book: BookDocument,
  store: Store,
  projectId: string,
) {
  const font = fontkit.create(fontBytes());
  if (!("layout" in font)) throw new Error("Book font must be a single font.");
  const outlines = (text: string, x: number, y: number, size: number) => {
    const run = font.layout(text),
      scale = size / font.unitsPerEm;
    let pen = 0;
    return run.glyphs
      .map((glyph, i) => {
        const pos = run.positions[i],
          path = `<path d="${glyph.path.toSVG()}" transform="translate(${x + (pen + pos.xOffset) * scale} ${y - pos.yOffset * scale}) scale(${scale} ${-scale})"/>`;
        pen += pos.xAdvance;
        return path;
      })
      .join("");
  };
  const hashes: string[] = [];
  for (const [index, spread] of book.spreads.entries()) {
    const art = await sharp(store.readAsset(projectId, spread.artHash))
      .resize(600, 600, { fit: "fill" })
      .png()
      .toBuffer();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="600"><rect width="1200" height="600" fill="#faf5e8"/><image x="0" y="0" width="600" height="600" xlink:href="data:image/png;base64,${art.toString("base64")}"/><g fill="#2b362b">${spread.lines.map((line, n) => outlines(line, book.layout.textX, textTop(book, index) + n * book.layout.lineHeight, book.layout.fontSize)).join("")}</g><g fill="#666e5c">${outlines("EVERLORE / A FAMILY STORY", 680, 67, 12)}${outlines(`${String(index + 1).padStart(2, "0")} / 12`, 680, 540, 14)}</g></svg>`;
    hashes.push(
      store.putAsset(
        projectId,
        await sharp(Buffer.from(svg)).png().toBuffer(),
        "art",
      ),
    );
  }
  return hashes;
}
