import { labeledReferences } from "./evidence.mjs";
import { buildLayout, joinWrappedIdentifiers, labeledValues } from "./layout-read.mjs";
import { joinOcrWords, wordsOverlappingFindings } from "./vendor/plainsight/ocr-map.mjs";

function labeledLines(lines) {
  const labels = [];
  for (const words of joinWrappedIdentifiers(lines)) {
    const { text, spans } = joinOcrWords(words);
    for (const match of labeledReferences(text)) labels.push({ match, text, spans });
  }
  return labels;
}

// Number of distinct payer references OCR can read on the page: values under the familiar label
// grammar plus any value whose own label (in any wording) says payer authorization.
export function countOcrReferences(lines) {
  return new Set([...labeledLines(lines).map(label => label.match.reference), ...labeledValues(buildLayout(lines))]).size;
}

export function readOcrCandidate(lines) {
  const labels = labeledLines(lines);
  if (labels.length !== 1 || countOcrReferences(lines) > 1) return null;
  const { text, spans, match } = labels[0];
  const start = text.indexOf(match.quote);
  const words = wordsOverlappingFindings(spans, [{ start, end: start + match.quote.length }]);
  if (!words.length || words.some(word => !validBox(word.bbox)
    || !Number.isFinite(word.confidence) || word.confidence < 55)) return null;
  const box = {
    x0: Math.min(...words.map(word => word.bbox.x0)),
    y0: Math.min(...words.map(word => word.bbox.y0)),
    x1: Math.max(...words.map(word => word.bbox.x1)),
    y1: Math.max(...words.map(word => word.bbox.y1)),
  };
  return { reference: match.reference, quote: match.quote, box };
}

export function locateReference(lines, reference) {
  const candidate = readOcrCandidate(lines);
  return candidate && candidate.reference === reference ? candidate.box : null;
}

function validBox(box) {
  return box && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)
    && box.x0 >= 0 && box.y0 >= 0 && box.x1 > box.x0 && box.y1 > box.y0;
}

const assets = new URL("./ocr-runtime/", import.meta.url);
let worker;

async function createLocalWorker() {
  const url = name => new URL(name, assets).href;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url("tesseract.min.js");
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  return globalThis.Tesseract.createWorker("eng", 1, {
    workerPath: url("worker.min.js"),
    corePath: url("core/"),
    langPath: url("lang/"),
    workerBlobURL: false,
  });
}

export function prepareOcr() {
  worker ??= createLocalWorker().catch(error => {
    worker = undefined;
    throw error;
  });
  return worker;
}

// Tesseract page-segmentation modes: 6 reads the page as one block (it can skip bordered table rows);
// 4 reads columns of lines (keeps table rows with their labels). The private layout read uses both.
async function readScanLines(image, mode = "6") {
  const ocrWorker = await prepareOcr();
  await ocrWorker.setParameters({ tessedit_pageseg_mode: mode });
  const { data } = await ocrWorker.recognize(image, {}, { blocks: true });
  return (data.blocks ?? []).flatMap(block =>
    block.paragraphs.flatMap(paragraph => paragraph.lines.map(line => line.words)));
}

export async function readScanReference(image) {
  return readOcrCandidate(await readScanLines(image));
}

export async function readScanEvidence(image) {
  const lines = await readScanLines(image);
  return { candidate: readOcrCandidate(lines), references: countOcrReferences(lines) };
}

export async function locateOnScan(image, reference) {
  return locateReference(await readScanLines(image), reference);
}

// Lines plus the OCR rule's own reading, for the private layout read.
export async function readScanLayoutEvidence(image) {
  const lines = await readScanLines(image, "4");
  const alternate = await readScanLines(image, "6");
  return { lines, alternate, candidate: readOcrCandidate(lines),
    references: Math.max(countOcrReferences(lines), countOcrReferences(alternate)) };
}
