# ClaimGuard iOS

ClaimGuard for iPhone captures a referral, runs Vision OCR locally, and checks a Firebase AI Logic Apple Foundation Models suggestion against the recognized payer reference. A clerk compares the highlighted line and confirms the reference. The app always leaves payer approval pending verification. The example policy and all 12 bundled scans are synthetic.

## Plan and folder layout

1. Run Vision OCR on each page and find distinct payer references. Reject a conflict across pages.
2. Ask Apple Foundation Models to read OCR text in a system-only Firebase session. Require the SDK to report the system-model version, then corroborate the model suggestion with Vision.
3. Verify and record with a human. Explain the fixed public policy in a separate, local-first hybrid session.
4. Compare the baseline and guarded model on the existing Web fixtures and verify the phone and cloud paths independently.

    ios/ClaimGuard/
    ├── ClaimGuard.xcodeproj/
    │   ├── project.pbxproj
    │   └── xcshareddata/xcschemes/ClaimGuard.xcscheme
    ├── Assets.xcassets/AppIcon.appiconset/
    ├── ClaimGuard.entitlements
    ├── Info.plist
    ├── GoogleService-Info.example.plist
    ├── Sources/
    │   ├── BenchmarkScreen.swift
    │   ├── ClaimBenchmark.swift
    │   ├── ClaimGuardApp.swift
    │   ├── ClaimInference.swift
    │   ├── ClaimReview.swift
    │   ├── ClaimReviewScreen.swift
    │   ├── DocumentCamera.swift
    │   ├── EvidenceParser.swift
    │   ├── LocalVision.swift
    │   └── ScanDocument.swift
    ├── Tests/EvidenceParserTests.swift
    ├── README.md
    └── SUBMISSION.md

The Xcode resource phase copies the existing evidence-review/samples directory into the app as samples. The project uses the exact same PNG bytes as Web and requires no manual duplication. Keep the repo layout when cloning.

## Firebase API and privacy boundaries

The Xcode project pins [Firebase Apple SDK 12.19.3](https://github.com/firebase/firebase-ios-sdk/tree/12.19.3) through Swift Package Manager, linking FirebaseAILogic, FirebaseAppCheck, and FirebaseCore. It follows Firebase's [Apple hybrid get-started guide](https://firebase.google.com/docs/ai-logic/hybrid/ios/get-started) and [Apple hybrid configuration options](https://firebase.google.com/docs/ai-logic/hybrid/ios/configuration-options), checked against the tagged SDK. SDK 13 removed the intermediary hybrid session types described by those guides. Keep the exact package pin for this implementation. See the [Apple SDK release notes](https://firebase.google.com/support/release-notes/ios#version_1300_-_october_7_2026).

- **Private input:** FirebaseAI.SystemLanguageModel.default is the single model in a fresh generativeModelSession. There is no cloud model in the session. The app sends serialized OCR text, with no image bytes. It accepts the response only if rawResponse.modelVersion equals apple-foundation-models-system-language-model.
- **Public policy:** A fresh HybridModel uses the system model as primary and Gemini as secondary. The policy method accepts only a Boolean to choose between local-first and cloud-only diagnostics. In both cases, its prompt is the fixed public string copied from Web. The sheet shows that prompt before any cloud test. Route indicators require a recognized response model version.
- **OCR:** Vision supplies line bounding boxes, and ClaimGuard uses the existing Web label grammar and the same quote guard. The iOS implementation counts distinct references across all scanned pages, as required for this app. Repeated sightings of the same reference collapse to one distinct ID. Unlike Tesseract, Vision returns observations for whole lines, so iOS highlights the matched line and does not port the Tesseract-specific per-word confidence cutoff.
- **Review:** An AI suggestion needs an exact corroborating reference from Vision. A conflict, disagreement, missing corroboration, or invalid quote cannot produce a proposed reference for recording. Local OCR and manual review remain available. The app keeps document images, OCR, references and trace entries in memory. The runtime trace records only action, route, and duration.
- **Benchmark:** Both paths use a single Vision read for the same bundled PNG. Model times include OCR and model time. p50/p95 use nearest-rank percentiles across measured attempts. Expected, proposed and displayed values are distinct. A model failure is “Not measured” and never counts as a correct abstention. The model metrics are blank until they are run.

## Set up and build on a Mac

1. On a Mac, install a supported Xcode 26 release, preferably 26.2 or later, and open it once to install iOS support. Check that it supports the iOS version installed on your iPhone. Confirm in **Xcode → About Xcode** and **iPhone Settings → General → About**.
2. In Terminal, clone and open the shared project:

       git clone --branch feature/claimguard-ios https://github.com/SandeepMadhavarapu/ClaimGuard-Hackathon.git
       cd ClaimGuard-Hackathon
       open ios/ClaimGuard/ClaimGuard.xcodeproj

   For an existing checkout, fetch the branch and switch to it. The project and targets are already created. Xcode should resolve the Firebase package automatically. In Xcode, check **Project → Package Dependencies** for Firebase 12.19.3. If package resolution was interrupted, choose **File → Packages → Resolve Package Versions**. In the Project Navigator, **samples** should be the existing blue folder reference. In **ClaimGuard target → Build Phases → Copy Bundle Resources**, confirm it appears exactly once. The Camera permission string is already in Info.plist.
3. In Xcode, choose the **ClaimGuard** project in the navigator, then the **ClaimGuard** app target → **Signing & Capabilities**. Check **Automatically manage signing**. In **Xcode → Settings → Accounts**, add your Apple Account, then select its **Personal Team** in the app target. The default bundle identifier is **com.sandeepmadhavarapu.claimguard**. If Xcode says you cannot register that identifier with your team, choose a unique identifier and use it verbatim in Firebase. Avoid adding App Attest to the Debug target or changing the run scheme to Release for a Personal Team.
4. In [Firebase Console → ClaimGuard Live Test](https://console.firebase.google.com/project/claimguard-live-test/overview), open **Project settings → General → Your apps → Add app**. Choose the **iOS** icon. Enter the exact Xcode app target bundle ID, optionally use the nickname **ClaimGuard iOS**, then click **Register app**. Leave App Store ID blank. Download **GoogleService-Info.plist** into **ios/ClaimGuard/GoogleService-Info.plist**. The build phase copies this file into the app bundle if present. Skip the wizard's dependency setup because the project already includes it. The real plist is ignored by Git. The example identifies the project and bundle ID, and is deliberately not a runnable Firebase configuration.
5. Confirm the **ClaimGuard** scheme is set to **Debug** for Run. Connect and unlock the iPhone, choose **Trust** if prompted, then select your iPhone as the run destination. After initiating device pairing, turn on **Settings → Privacy & Security → Developer Mode** if iOS asks, restart, and confirm. Press **⌘R**. If Xcode asks you to verify the developer certificate, follow the on-phone prompt. For unit tests, choose an iPhone simulator and press **⌘U**. The tests need no Firebase configuration, debug token, or Apple Intelligence.
6. Confirm **Settings → Apple Intelligence & Siri → Apple Intelligence** remains on. The app should say **Apple Intelligence model ready**. If it says the model is getting ready, keep the phone on Wi-Fi and power while the system finishes and return to the app to refresh. See [Apple Intelligence requirements](https://support.apple.com/en-us/121115).
7. Register **the device's own Debug token**:

   - In the app, open **View exact cloud request → Test App Check cloud route** once online to trigger App Check. An unregistered first call can fail.
   - In Xcode, show the debug console and find **App Check debug token**. The shared Debug scheme includes the -FIRDebugEnabled launch argument.
   - In Firebase Console, open **App Check → Apps → ClaimGuard iOS → ⋮ → Manage debug tokens**. Add the token with a recognizable development label. Keep it private. The Web app's token and the iOS app's token are separate.
   - Relaunch and run the same cloud test. Success requires the sheet to show **Cloud · verified by Firebase** and the runtime trace to list **Cloud** for Explain public policy. Check [App Check → APIs → Firebase AI Logic](https://console.firebase.google.com/project/claimguard-live-test/appcheck) with enforcement left enabled.
   - Remove the debug token when the approved testing window is over. Do not place it in source, a public build, a video, or public instructions. See Firebase's [debug provider instructions](https://firebase.google.com/docs/app-check/ios/debug-provider).

### Free Apple ID versus release

A free Apple ID can sign a Debug build to your own iPhone from Xcode using a Personal Team. Apple says these provisioning profiles expire after seven days. For App Attest release builds and normal judge distribution through TestFlight, use a paid Apple Developer Program team. The provided Release configuration includes the production App Attest entitlement. With a paid team, enable App Attest for the explicit app identifier, select the team for Release, and register the iOS app under **Firebase App Check → Apps → App Attest** using the team's Apple Team ID. Use a registered signed Release build on supported physical hardware to test attestation. Keep Debug for Personal Team development. The contest accepts App Check debug tokens, but a debug token supplies attestation for an installed app and does not distribute or install the app. Use the [Apple account guide](https://developer.apple.com/help/account/basics/about-your-developer-account), [Apple supported capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios), [Apple Developer Mode guide](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device), and [Firebase App Attest guide](https://firebase.google.com/docs/app-check/ios/app-attest-provider).

## Run the device checks

1. Use a device build configured for Firebase. On the phone, keep Wi-Fi off after enabling Airplane Mode and verify cellular data is off. Choose **Use sample → Specialist referral → Read with Apple Intelligence**. Expect **DEMO-PA-240817**, a green line highlight, and an **On-device** entry in **Tools → Runtime trace**. Local OCR has its own trace item. Check the confirmation, press **Record reference**, and verify the payer approval remains pending. Camera testing can use a printout of the synthetic referral.
2. Select **Conflicting references**, run the same read, and confirm the suggestion is withheld. Try **Look-alike O and 0** and **Low resolution and leading zeros** as separate regressions.
3. Still offline, press **Explain policy**. A successful result must say **On-device**. If the model is unavailable, the app may show an error. Keep that failed attempt out of the on-device claims.
4. Reconnect, open **View exact cloud request**, and run **Test App Check cloud route**. Check the recognized Cloud result and exact fixed prompt. A Debug cloud success demonstrates the registered debug provider. It does not demonstrate App Attest.
5. Open **Tools → Benchmark**, run all 12 samples, and record both summaries and the failed rows. Screenshot the device model and iOS version for the run record. The submission paragraph and 45-second recording plan are in [SUBMISSION.md](SUBMISSION.md).
