# ClaimGuard Evidence Review

**Catch a missing preauthorization reference before a hospital claim goes out. Patient documents are read on the device, and only public policy text can reach the cloud.**

Entry for [#BuildHybridAI 2026](https://firebasehybridaihackathon.devpost.com/). Platforms: **Web (Chrome) with Gemini Nano** and **iOS (iPhone) with Apple Foundation Models**, both through Firebase AI Logic.

**Live demo:** https://claimguard-hackathon.vercel.app/?judge=1 (desktop Chrome)

---

## The problem

Kenya’s [Social Health Insurance Regulations](https://www.refworld.org/sites/default/files/2026-09/kenya_the_social_health_insurance_regulations.pdf) describe preauthorization for specified specialized services. ClaimGuard tests one practical billing scenario: a clerk needs to locate the payer’s reference in a supporting scan. A hospital tracking ID, a referral number, or an O read as a 0 can look plausible in that field.

The supporting documents are scanned referral letters and cover sheets that contain patient information. Uploading them to a general-purpose cloud chatbot is not an option.

## What ClaimGuard does

1. **Read on-device.** Gemini Nano reads the scan in Chrome through Firebase AI Logic (`ONLY_ON_DEVICE`). It returns the labeled reference and an exact quote, or it abstains.
2. **Cross-check.** Tesseract OCR runs on the same image in a browser worker. If Nano and OCR disagree, the suggestion is withheld and the case goes to manual review. If OCR cannot corroborate a proposal, it is also withheld. When the reads agree, the evidence line is highlighted on the scan.
3. **The clerk confirms.** Nothing is recorded until the clerk compares the value with the original and ticks the confirmation. Payer verification stays pending; ClaimGuard never claims approval.
4. **Explain the rule with hybrid inference.** The policy explanation uses `PREFER_ON_DEVICE`: Nano answers when it is ready, and Firebase AI Logic falls back to the cloud when it isn't. The UI shows which route the SDK actually reported. You can view the exact cloud request, which contains only a fixed, public policy summary.

## Why hybrid inference

| Task | Mode | Why |
|---|---|---|
| Read a patient scan | `ONLY_ON_DEVICE` | Patient documents must never fall back to the cloud. If Nano isn't available, the app falls back to local OCR and manual entry, never to the cloud. |
| Explain the policy rule | `PREFER_ON_DEVICE` (default) | The text is public, so the cloud is a safe fallback. Clerks on machines without Nano still get an answer. |
| Explain the policy rule | `ONLY_IN_CLOUD` (option) | Forces the cloud path for comparison. |

Every result is labeled from `response.inferenceSource` (On-device or Cloud). If the SDK reports a route the call did not allow, the result is rejected. The **Runtime trace** panel logs each action, its route and its latency, without any document text.

Firebase AI Logic is imported and called at runtime in [`evidence-review/firebase-ai.mjs`](evidence-review/firebase-ai.mjs) (`getAI`, `getGenerativeModel`, `InferenceMode`, `generateContent`), with Firebase App Check (reCAPTCHA) initialized before any call.

## Judge walkthrough (about 3 minutes)

Open the [live demo](https://claimguard-hackathon.vercel.app/?judge=1) in desktop Chrome.

1. **Specialist referral.** Click **Read with Gemini Nano** (on-device) or **Read with local OCR** (works without an account). Click **Locate evidence on scan**, tick the confirmation, then click **Record reference**.
2. **Pending referral.** The only ID on the page is a hospital tracking ID. ClaimGuard abstains instead of guessing.
3. **Conflicting references.** Two references are printed. The finding stays open for a human.
4. **Policy and cloud request.** Click **View the exact cloud request**, then **Explain policy · on-device first**. The status line shows whether Nano answered or the cloud fallback did.
5. **Benchmark 12 labeled scans.** Run Gemini Nano and the local OCR baseline on the same 12 synthetic scans. Six contain a payer reference and six require abstention, with faint print, low resolution, leading zeros, an O/0 confusion case, blank fields and conflicting references.

All documents in the demo are synthetic. There is no real patient data.

## Run it locally

Requires desktop Chrome with Gemini Nano support. See the [Firebase hybrid web guide](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started).

```sh
git clone https://github.com/SandeepMadhavarapu/ClaimGuard-Hackathon
cd ClaimGuard-Hackathon
python -m http.server 8000 --bind 127.0.0.1 --directory evidence-review
```

Then open http://127.0.0.1:8000/?judge=1. Local OCR, manual entry and the OCR benchmark work immediately.

To enable Gemini Nano and the cloud explanation:

1. Create a Firebase project, register a web app, and enable **Firebase AI Logic** with the Gemini Developer API.
2. Register the app with **App Check** using reCAPTCHA v3.
3. Copy `evidence-review/firebase-config.example.json` to `evidence-review/firebase-config.local.json` and fill in your web config and reCAPTCHA site key. This file is ignored by Git.
4. On localhost, set `"localDebug": true` and register the debug token printed in Chrome's console in the Firebase console.

To deploy (Vercel), set the `CLAIMGUARD_FIREBASE_CONFIG` environment variable to the same JSON with a reCAPTCHA Enterprise key registered for your domain. `tools/build-vercel.mjs` writes it into the build.

Full details, the benchmark methodology and the network capture tool are in [`evidence-review/README.md`](evidence-review/README.md).

## Tests

```sh
node --experimental-vm-modules --test "evidence-review/*.test.mjs" "tools/*.test.mjs"
```

The tests cover evidence parsing and abstention, the benchmark scorer, scan tools, the privacy meter, and inference routing against a simulated Firebase SDK. The routing tests check that private canaries only reach on-device calls and that only the public prompt reaches cloud or hybrid calls.

## Built with

Firebase AI Logic (Gemini Nano in Chrome, Apple Foundation Models on iPhone, Gemini in the cloud) · Firebase App Check · Tesseract.js · plain JavaScript modules · Vercel · SwiftUI, VisionKit and Vision on iOS

## License

[Apache License 2.0](LICENSE). Third-party components and their licenses are listed in [NOTICE](NOTICE).

## iOS

The native iPhone app is in [ios/ClaimGuard](ios/ClaimGuard). It uses VisionKit capture, on-device Vision OCR, and a Firebase AI Logic session that runs only on Apple Foundation Models for extraction. The OCR text never falls back to the cloud. The public policy explanation uses a separate hybrid session (Apple Foundation Models first, then Gemini in the cloud) protected by App Check. The guard is the same as on Web, plus one iOS rule: the model's reference must match exactly one labeled payer line in the OCR text it read.

**Measured on an iPhone 17 (iOS 26.6.1) in airplane mode, Nov 27, 2026, on the same 12 synthetic scans:**

| Method | Correct outcomes | False suggestions | Wrong model proposals blocked | Median time |
|---|---|---|---|---|
| Apple Intelligence + guard | 11/12 (5 extractions, 6 abstentions) | 0 | 5 | 1.2 s |
| Vision OCR only | 11/12 | 0 | n/a | 0.14 s |

The one miss for both methods is the deliberate O-versus-0 case. Offline, the policy explanation answered on-device. Online, the cloud route was verified by Firebase App Check.

### Install on an iPhone

- **With a Mac:** follow the [iOS setup and device checklist](ios/ClaimGuard/README.md) (Xcode, Firebase registration, signing).
- **Without a Mac:** the GitHub Actions workflow `iOS build and tests` builds an unsigned debug `.ipa` on a macOS runner when a `GOOGLE_SERVICE_INFO_PLIST` repository secret is set. Download the `ClaimGuard-debug-ipa` artifact and sign and install it with your own Apple ID using a sideloading tool such as Sideloadly. The debug build shows a **Copy App Check debug token** button. Register that token in Firebase App Check before testing the cloud route.

Requirements: an Apple Intelligence-capable iPhone on iOS 26 with Apple Intelligence turned on. The unsigned IPA and per-install Firebase Debug enrollment are a developer reproduction path. The repository does not currently publish a general iOS judge install link.
