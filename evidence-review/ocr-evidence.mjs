import { labeledReferences } from "./evidence.mjs";
import { joinOcrWords, wordsOverlappingFindings } from "./vendor/plainsight/ocr-map.mjs";

function labeledLines(lines) {
  const labels = [];
  for (const words of lines) {
    const { text, spans } = joinOcrWords(words);
    for (const match of labeledReferences(text)) labels.push({ match, text, spans });
  }
  return labels;
}

// Number of distinct payer references OCR can read on the page.
export function countOcrReferences(lines) {
  return new Set(labeledLines(lines).map(label => label.match.reference)).size;
}

export function readOcrCandidate(lines) {
  const labels = labeledLines(lines);
  if (labels.length !== 1) return null;
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

async function readScanLines(image) {
  const { data } = await (await prepareOcr()).recognize(image, {}, { blocks: true });
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
  const lines = await readScanLines(image);
  return { lines, candidate: readOcrCandidate(lines), references: countOcrReferences(lines) };
}
