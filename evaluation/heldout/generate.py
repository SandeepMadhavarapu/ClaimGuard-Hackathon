"""Generate ClaimGuard's held-out evaluation set.

50 distinct synthetic supporting documents that were never used during development, plus degraded
variants of 10 of them (reported separately, as variants, not as new documents). Every name,
clinic and identifier is invented. Run once; results are reported against a frozen commit.

    python3 evaluation/heldout/generate.py    # needs Playwright + Google Chrome, Pillow
"""
import asyncio, json, pathlib, random
from PIL import Image, ImageFilter

import sys
OUT = pathlib.Path(__file__).resolve().parents[2] / "evidence-review" / "heldout"
SET = sys.argv[1] if len(sys.argv) > 1 else "a"   # "a" = first held-out set, "b" = fresh set generated after fixes
SEED = 20261128 if SET == "a" else 20261129
PREFIX = "h" if SET == "a" else "b"
JSON_NAME = "cases.json" if SET == "a" else "cases-b.json"
rng = random.Random(SEED)

CLINICS = ["Ridgeview Demo Hospital", "Lakeshore Sample Clinic", "Acacia Training Medical Centre",
           "Northgate Synthetic Hospital", "Baobab Demo Health", "Riverside Mock Infirmary",
           "Highland Practice Hospital", "Coastline Example Clinic"]
TITLES = ["Specialist referral", "Referral for imaging", "Admission summary", "Theatre booking note",
          "Supporting evidence", "Outpatient referral", "Dialysis referral", "Physiotherapy referral"]
FAMILIAR = ["Preauthorization reference:", "Preauthorization number:", "Pre-authorization number:",
            "PREAUTHORIZATION REFERENCE:"]
UNFAMILIAR = ["Pre-auth ref:", "Payer authorization no.:", "Authorization code:", "Approval reference:",
              "PA number:", "Preauth #:", "Insurer approval ref:", "Prior authorization number:",
              "Authorisation reference:", "Payer approval number:", "Auth. ref:", "SHA preauthorization:"]
if SET == "b":
    # Set B swaps in four wordings that were never seen during development.
    UNFAMILIAR = UNFAMILIAR[:8] + ["Payer auth code:", "Pre-approval no.:", "Authorization ID:", "Approval #:"]
FONTS = ["'DejaVu Serif'", "'DejaVu Sans'", "Inter", "'Courier 10 Pitch', Courier, monospace", "'DejaVu Sans Condensed'"]


def num(n):
    return "".join(rng.choice("0123456789") for _ in range(n))


def ref(style=None):
    style = style if style is not None else rng.randrange(4)
    return [f"DEMO-PA-{num(6)}", f"PA-{num(6)}", f"AUTH-26-{num(5)}", f"DPA{num(7)}"][style]


def others():
    return [("Case number:", f"CASE-{num(4)}"), ("Hospital tracking ID:", f"FAC-{num(5)}"),
            ("Referral ID:", f"REF-{num(4)}"), ("Claim draft:", f"DRAFT-{num(4)}"),
            ("Member number:", f"CR{num(11)}-{num(1)}"), ("Facility:", f"FID-21-{num(6)}-{num(1)}")]


cases = []


def add(category, expected, fields, note, layout=None, prose=None, two_docs=None):
    cases.append(dict(category=category, expected=expected, fields=fields, note=note,
                      layout=layout or rng.choice(["letter", "table", "fax", "memo", "card", "plain"]),
                      font=rng.choice(FONTS), clinic=rng.choice(CLINICS), title=rng.choice(TITLES),
                      prose=prose, two_docs=two_docs))


def mix(payer_rows, k=2):
    rows = rng.sample(others(), k) + payer_rows
    rng.shuffle(rows)
    return rows


# Readable: one payer reference, familiar label (8)
for _ in range(8):
    v = ref()
    add("readable", v, mix([(rng.choice(FAMILIAR), v)], rng.randint(1, 3)), "familiar label")
# Readable: unfamiliar label wording (12)
for label in UNFAMILIAR:
    v = ref()
    add("readable", v, mix([(label, v)], rng.randint(1, 3)), f"unfamiliar label '{label}'")
# Readable: reference inside a sentence, no colon (2)
for _ in range(2):
    v = ref(0)
    add("readable", v, mix([], 2), "reference stated in prose", layout="letter",
        prose=f"The payer issued preauthorization reference {v} for this service.")
# Readable: same reference printed twice (not a conflict) (2)
for _ in range(2):
    v = ref()
    add("readable", v, mix([("Preauthorization reference:", v), ("Payer approval number:", v)], 1), "same reference twice")
# Look-alike characters, one payer reference (8)
lookalikes = ["DEM0-PA-" + num(6), "PA-" + num(2) + "O" + num(3), "AUTH-26-" + num(2) + "I" + num(2),
              "DPA" + num(3) + "O" + num(3), "PA-1" + num(2) + "l" + num(2), "DEMO-PA-0" + num(2) + "O0" + num(1),
              "AUTH-2I-" + num(5), "PA-" + num(3) + "0O" + num(1)]
for v in lookalikes:
    add("lookalike", v, mix([(rng.choice(FAMILIAR + UNFAMILIAR[:4]), v)], rng.randint(1, 2)), "O/0 or I/1 look-alike")
# Conflicting: two different payer references (8)
for i in range(8):
    a, b = ref(), ref()
    if i < 5:
        add("conflict", None, mix([(rng.choice(FAMILIAR), a), (rng.choice(FAMILIAR + UNFAMILIAR), b)], 1),
            "two different payer references on one page")
    elif i < 7:
        add("conflict", None, mix([("Preauthorization reference:", a)], 1), "two documents, different references",
            two_docs=[("Preauthorization reference:", b)])
    else:
        add("conflict", None, mix([("Original preauthorization:", a), ("Amended preauthorization:", b)], 1),
            "original and amended references")
# Pending, blank or no payer reference (10)
pending = [[("Preauthorization reference:", "pending")], [("Preauthorization number:", "not yet issued")],
           [("Preauthorization reference:", "")], [("Pre-auth ref:", "N/A")],
           [("Preauthorization:", "requested, awaiting payer")], [("Preauthorization reference:", "to be confirmed")],
           [("Preauthorization:", "denied")], [], [], []]
for i, rows in enumerate(pending):
    add("no_reference", None, mix(rows, 2 if rows else 3), "pending/blank/denied" if rows else "hospital identifiers only")

assert len(cases) == 50, len(cases)
rng.shuffle(cases)
for i, case in enumerate(cases, 1):
    case["file"] = f"{PREFIX}{i:02d}.jpg"

CSS = """
body{margin:0;background:#cfd2d6}
.page{width:860px;padding:44px 52px;background:#fbfaf6;color:#1d1d1f;margin:24px;box-shadow:0 2px 6px rgba(0,0,0,.25);font-size:19px;line-height:1.5}
h1{font-size:28px;margin:0 0 4px} .clinic{font-weight:700;letter-spacing:.06em;font-size:15px;text-transform:uppercase}
.muted{color:#555;font-size:15px} table{border-collapse:collapse;width:100%;margin-top:14px} td{border:1px solid #999;padding:8px 10px}
.row{margin:6px 0} .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 26px;margin-top:14px}
.foot{margin-top:22px;font-size:13px;color:#666;letter-spacing:.08em} .fax{font-size:40px;font-weight:800;letter-spacing:.2em}
.sep{border-top:2px dashed #888;margin:26px 0}
"""


def rows_html(rows, layout):
    if layout == "table":
        return "<table>" + "".join(f"<tr><td>{l.rstrip(':')}</td><td>{v}</td></tr>" for l, v in rows) + "</table>"
    if layout == "card":
        return "<div class=grid>" + "".join(f"<div>{l} {v}</div>" for l, v in rows) + "</div>"
    return "".join(f"<div class=row>{l} {v}</div>" for l, v in rows)


def doc_html(case, rows, title):
    head = {
        "fax": f"<div class=fax>FAX</div><div class=muted>To: Billing office · From: Referral desk · Pages: 1</div>",
        "memo": f"<div class=fax style='font-size:30px'>MEMO</div><div class=muted>Subject: {title}</div>",
    }.get(case["layout"], f"<div class=clinic>{case['clinic']}</div><h1>{title}</h1><div class=muted>Billing office / Supporting evidence</div>")
    body = rows_html(rows, case["layout"])
    prose = f"<p>{case['prose']}</p>" if case.get("prose") else ""
    return f"{head}<hr>{body}{prose}<p class=muted>Confirm approval status in the payer records before submitting.</p><div class=foot>SYNTHETIC TRAINING DOCUMENT</div>"


async def render():
    from playwright.async_api import async_playwright
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path="/usr/bin/google-chrome")
        page = await browser.new_page(viewport={"width": 1000, "height": 1400})
        for case in cases:
            inner = doc_html(case, case["fields"], case["title"])
            if case.get("two_docs"):
                inner += "<div class=sep></div>" + doc_html(dict(case, layout="letter", prose=None), case["two_docs"], "Payer approval letter")
            await page.set_content(f"<style>{CSS}</style><div class=page style=\"font-family:{case['font']}\">{inner}</div>")
            await page.locator(".page").screenshot(path=str(OUT / case["file"]), type="jpeg", quality=88)
        await browser.close()


def variants():
    picks = [c for c in cases if c["category"] in ("readable", "lookalike")][:8] + [c for c in cases if c["category"] == "conflict"][:2]
    out = []
    for case in picks:
        src = Image.open(OUT / case["file"]).convert("RGB")
        w, h = src.size
        for kind in ("blur", "lowres", "skew"):
            if kind == "blur":
                img = src.filter(ImageFilter.GaussianBlur(1.6))
            elif kind == "lowres":
                img = src.resize((int(w * 0.42), int(h * 0.42))).resize((w, h))
            else:
                img = src.rotate(2.5, expand=True, fillcolor=(205, 208, 212))
            name = case["file"].replace(".jpg", f"-{kind}.jpg")
            img.save(OUT / name, quality=40 if kind == "skew" else 80)
            out.append(dict(file=name, of=case["file"], kind=kind, category=case["category"], expected=case["expected"]))
    return out


if __name__ == "__main__":
    asyncio.run(render())
    var = variants()
    labels = [dict(file=c["file"], category=c["category"], expected=c["expected"], note=c["note"], layout=c["layout"]) for c in cases]
    (OUT / JSON_NAME).write_text(json.dumps({"seed": SEED, "documents": labels, "variants": var}, indent=1) + "\n")
    print(len(labels), "documents,", len(var), "variants")
