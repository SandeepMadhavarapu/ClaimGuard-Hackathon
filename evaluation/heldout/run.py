"""Run the held-out set through the deterministic parts of ClaimGuard's workflow.

Serves the built app (dist/) locally and, in Chrome, runs each held-out document through the same
modules the app uses: on-device Tesseract OCR, the OCR label rule, the private-layout builder, the
leak gate and the slot guard. The model step needs Firebase App Check in a real browser, so here it is
bounded instead of sampled:
  - best case: the model picks the right slot (or NONE when there is no single reference);
  - worst case: the guard sweep tries every slot as the model's answer and counts wrong values shown.
The real-model run is the "Run held-out set" button in the app's benchmark panel.

    node tools/build-vercel.mjs && python3 evaluation/heldout/run.py
"""
import asyncio, json, pathlib, subprocess, sys, time
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
SET_FILE = "cases"  # cases.json = set A; cases-b.json = set B
JS = """
async () => {
  const ocr = await import('./ocr-evidence.mjs');
  const L = await import('./layout-read.mjs');
  const { documents, variants } = await (await fetch('./heldout/' + (window.__set || 'cases') + '.json')).json();
  await ocr.prepareOcr();
  const run = async item => {
    const blob = await (await fetch('./heldout/' + item.file)).blob();
    const ev = await ocr.readScanLayoutEvidence(blob);
    const layout = L.buildLayout(ev.lines);
    const prompt = L.layoutPrompt(layout.layout);
    const gate = L.leakGate(prompt, layout);
    const ocrShown = ev.references > 1 ? null : ev.candidate?.reference ?? null;
    const right = layout.slots.find(s => s.value === item.expected);
    const best = L.resolveLayoutSlot(JSON.stringify({ slot: right && item.expected ? right.id : 'NONE' }), layout, ev);
    const sweep = L.guardSweep(layout, ev, item.expected);
    // Realistic model: picks the one value labeled as a payer authorization, else NONE.
    const labeled = L.labeledValues ? L.labeledValues(layout) : [];
    const faithfulSlot = labeled.length === 1 ? layout.slots.find(s => s.value === labeled[0]).id : 'NONE';
    const faithful = L.resolveLayoutSlot(JSON.stringify({ slot: faithfulSlot }), layout, ev);
    return { ...item, ocrReferences: ev.references, ocrShown, valueRead: Boolean(right), gateOk: gate.ok, gateBytes: gate.bytes,
             bestShown: best.candidate?.reference ?? null, bestStatus: best.status, sweep,
             faithfulShown: faithful.candidate?.reference ?? null };
  };
  const out = { documents: [], variants: [] };
  for (const d of documents) out.documents.push(await run(d));
  for (const v of variants) out.variants.push(await run(v));
  return out;
}
"""


def tally(rows, shown_key):
    readable = [r for r in rows if r["expected"] is not None]
    hold = [r for r in rows if r["expected"] is None]
    return {
        "readable": len(readable),
        "extracted": sum(r[shown_key] == r["expected"] for r in readable),
        "readable_held": sum(r[shown_key] is None for r in readable),
        "readable_wrong": sum(r[shown_key] not in (None, r["expected"]) for r in readable),
        "should_hold": len(hold),
        "held": sum(r[shown_key] is None for r in hold),
        "wrongly_ready": sum(r[shown_key] is not None for r in hold),
    }


async def main():
    server = subprocess.Popen([sys.executable, "-m", "http.server", "8799"], cwd=ROOT / "dist",
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(executable_path="/usr/bin/google-chrome")
            page = await browser.new_page()
            await page.goto("http://localhost:8799/index.html")
            await page.evaluate(f"window.__set = {json.dumps(SET_FILE)}")
            result = await page.evaluate(JS)
            await browser.close()
    finally:
        server.terminate()
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if subprocess.run(["git", "status", "--porcelain", "--", "evidence-review"], cwd=ROOT, capture_output=True, text=True).stdout.strip():
        commit += "-dirty"
    label = "A" if SET_FILE == "cases" else "B"
    docs, var = result["documents"], result["variants"]
    summary = {
        "commit": commit,
        "documents": len(docs), "variants": len(var),
        "ocr_rule": {"documents": tally(docs, "ocrShown"), "variants": tally(var, "ocrShown")},
        "private_layout_best_case": {"documents": tally(docs, "bestShown"), "variants": tally(var, "bestShown")},
        "private_layout_label_faithful_model": {"documents": tally(docs, "faithfulShown"), "variants": tally(var, "faithfulShown")},
        "private_layout_any_model": {
            "documents_with_a_wrong_value_possible": sum(r["sweep"]["wrongShown"] > 0 for r in docs),
            "documents_list": [r["file"] for r in docs if r["sweep"]["wrongShown"] > 0],
            "variants_with_a_wrong_value_possible": sum(r["sweep"]["wrongShown"] > 0 for r in var),
            "picks_tried": sum(r["sweep"]["tried"] for r in docs + var),
        },
        "leak_gate": {"blocked": sum(not r["gateOk"] for r in docs + var), "requests": len(docs) + len(var)},
        "ocr_read_expected_value": sum(r["valueRead"] for r in docs if r["expected"]),
    }
    summary["set"] = label
    out = ROOT / "evaluation" / "heldout" / f"results-{label}-{commit}.json"
    out.write_text(json.dumps({"summary": summary, "rows": result}, indent=1) + "\n")
    print(json.dumps(summary, indent=1))
    for r in docs:
        if r["bestShown"] != r["expected"] or r["ocrShown"] != r["expected"]:
            print(f"{r['file']} {r['category']:12} exp={r['expected']} ocr={r['ocrShown']} best={r['bestShown']} ({r['bestStatus']}) read={r['valueRead']} | {r['note']}")


if len(sys.argv) > 1:
    SET_FILE = sys.argv[1]
asyncio.run(main())
