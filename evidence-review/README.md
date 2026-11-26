# ClaimGuard Evidence Review

This standalone Chrome demo helps a billing clerk locate and record a preauthorization reference on a synthetic claim. Read a supporting scan with local OCR or Gemini Nano, compare the suggestion with the original, and confirm it. Payer verification stays pending.

## Start the demo

From the folder that contains `evidence-review/`, run:

```sh
python -m http.server 8000 --bind 127.0.0.1 --directory evidence-review
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) in desktop Chrome. You can inspect all four scan samples, enter a reference manually, and use the pasted-text matcher immediately. The AI buttons become available after Firebase is configured.

Use [Judge walkthrough](http://127.0.0.1:8000/?judge=1) for the two sample cases and the benchmark. **Read with local OCR** runs the workflow without an account. Each result identifies the method that produced it. If Nano and local OCR return different IDs, the app withholds the Nano suggestion and routes the clerk to manual review.

## Enable Firebase AI Logic

1. Register a web app in a Firebase project, enable Firebase AI Logic with the Gemini Developer API, and register the app with Firebase App Check using reCAPTCHA v3.
2. Copy `firebase-config.example.json` to `firebase-config.local.json`. Enter the web app configuration and the public reCAPTCHA site key. The local configuration file is ignored by Git.
3. For localhost, set `localDebug` to `true`. Register the token printed by Chrome's console as an App Check debug token in the Firebase console. Keep that token private.
4. Follow the [Firebase Chrome setup guide](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started) on the computer you will use. The initial Gemini Nano download can take several minutes.
5. For a hosted demo, use a production App Check provider registered for the hosting domain, keep `localDebug` off, and deploy the static runtime files and bundled samples with the hosted web configuration.

## Run the walkthrough

1. Open **Specialist referral** and click **Read scan on-device**. Compare Nano's transcription with the scan, tick the confirmation, and click **Apply and rerun check**.
2. Switch to **Request pending** and rerun. The hospital tracking ID alone leaves the reference missing. **Conflicting references** exercises the case where the clerk must resolve which value applies.
3. Open **Policy and cloud request**, then **View the exact cloud request**. **Explain rule with cloud AI** sends a fixed synthetic policy summary and excludes scans, case data, references, and patient text.
4. Open **Benchmark 12 labeled scans** and run both Gemini Nano and the local OCR baseline. Six scans have a payer reference and six require abstention. The set includes faint print, low resolution, leading zeros, an O/0 confusion case, blank fields, and conflicting references.

### Source image tools

**Straighten scan** detects the page boundary and shows a corrected copy while preserving the original. It leaves the image as-is when detection is uncertain. Switching views clears the previous finding and any selected evidence so observations stay tied to the image being reviewed.

After Nano suggests a reference, **Locate evidence on scan** runs local OCR on the same image in a browser worker. A highlight requires one labeled reference, an exact match to the proposed value, and usable OCR coordinates. If local OCR cannot locate the line, the clerk can mark it manually. The clerk confirms the evidence before applying the reference. The evidence viewer keeps its controls visible while the image scrolls.

### Capture the network boundary

Use a separate desktop Chrome profile with Gemini Nano and working Firebase App Check. Start the app, then run from the package root:

```powershell
node tools/capture-privacy.mjs "C:/Program Files/Google/Chrome/Application/chrome.exe" "$env:LOCALAPPDATA/ClaimGuardBenchmarkChrome"
```

The tool opens the app and prompts for the two actions on the bundled **Specialist referral** sample. It exports aggregate counts and flags for the attached Chrome page target. It checks for recognized inference endpoints, the expected public prompt, image markers, and the synthetic reference canary. Worker and browser background traffic are outside the capture scope. A missing inference result or an unreadable request body makes the check inconclusive. The capture does not save raw bodies or request headers.

## Benchmark methodology

The table compares the expected reference, the model's proposal, and the outcome for each scan. The JSON export includes the candidate ClaimGuard displayed, any wrong proposals blocked by its guard, and per-case inference source and duration. Reported p50 and p95 use the successful inference durations, excluding device preparation and image loading. The quote character error rate sums edits across scored reference lines and divides by their total expected characters. The scorer collapses whitespace but preserves case, punctuation, and digits. On a completed inference with a missing quote, the expected line counts as omitted.

Failures remain in the denominator for correct outcomes. If Nano fails to initialize, the report shows `not_run` with empty metrics. This is a small synthetic evaluation of the preauthorization workflow. It measures extraction and abstention, and it records the SDK inference source. Independent network traffic and clinical accuracy are outside its scope.

The local OCR baseline runs without Firebase. It applies the same reference parser to the same originals, with only OCR text and confidence scores as input. The Nano run scores the model's output before the workflow's independent OCR cross-check and clerk confirmation. After both runs, the comparison counts jointly scored cases where both methods were correct, only one was correct, or neither was correct. Errors without a scored response stay in each run's totals and are excluded from the paired comparison.

## Implementation boundaries

- Both inference calls use Firebase AI Logic. Scan extraction uses `ONLY_ON_DEVICE`, and the rule explanation uses `ONLY_IN_CLOUD`. The display checks the SDK's `response.inferenceSource` before labeling results.
- The suggested text and label must agree before the suggestion is shown. The clerk is responsible for comparing the transcription against the original pixels. The pasted-text path verifies the quote directly against the underlying text.
- The synthetic `CG-AUTH-001` rule checks whether a preauthorization reference was recorded. Authorization requires verification with the payer.
- Selected images are prepared in memory. Use bundled or synthetic scans for the contest recording and judging.

## Run the tests

From the folder that contains `evidence-review/`, use Node.js 20 or newer:

```sh
node --experimental-vm-modules --test "evidence-review/*.test.mjs" "tools/*.test.mjs"
```

The suite checks evidence handling and exercises routing with a simulated Firebase SDK. A live Nano and cloud run requires the Firebase and Chrome setup above.

[Firebase inference modes and response metadata](https://firebase.google.com/docs/ai-logic/hybrid/web/configuration-options)
