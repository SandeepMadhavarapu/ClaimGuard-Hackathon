# Devpost and demo material

Use the following paragraph when the iPhone and App Check checks in the iOS README are complete. Confirm the testing instructions include the actual path a judge can use to install and run the iOS build.

## Devpost paragraph

ClaimGuard helps Kenyan hospital billing clerks catch missing or conflicting payer preauthorization references before claims go out. On Chrome, Firebase AI Logic runs Gemini Nano on the scan. On iPhone, Vision reads the scan locally and Firebase AI Logic runs Apple Foundation Models on the resulting text. Both workflows highlight the evidence for a human to confirm and keep payer approval pending verification. A separate local-first hybrid policy explanation can fall back to Gemini under App Check. Its only input is a fixed public policy prompt, and the app shows the actual route reported by Firebase. Judges can try the same 12 synthetic scans and compare model results with the local OCR baseline.

## iPhone insert · 45 seconds

Cut or replace 45 seconds elsewhere if the complete video would exceed three minutes. Record the real iPhone with a second camera if the status indicators are hard to see. Show synthetic samples only.

| Time | On screen | Voiceover |
| --- | --- | --- |
| 0:00–0:07 | Open Control Center. Turn on Airplane Mode and verify Wi-Fi is off. Return to ClaimGuard. | “Here’s the same claim review on iPhone, with the network off.” |
| 0:07–0:20 | Choose Specialist referral. Tap Read with Apple Intelligence. Show the green line and open Runtime trace to show On-device. | “Vision reads the scan locally. Apple Foundation Models checks the text through Firebase AI Logic, and the matching reference is highlighted for the clerk.” |
| 0:20–0:31 | Choose Conflicting references. Tap Read with Apple Intelligence. Show the conflict message and withheld suggestion. | “This scan has two different payer references. ClaimGuard leaves the finding open for review.” |
| 0:31–0:38 | Keep Airplane Mode on. Tap Explain policy. Hold on the On-device label if it appears. | “The public policy explanation can also run on this iPhone while offline.” |
| 0:38–0:45 | Reconnect, then show recorded footage of Test App Check cloud route succeeding and the exact public prompt. | “On the cloud route, App Check protects the request. The only prompt is public policy.” |

Edit recorded wait times if needed and leave the final source labels visible. If any run returns an unknown source or fails, capture the successful device run before using the corresponding claim. Never show the App Check debug console or its token.
