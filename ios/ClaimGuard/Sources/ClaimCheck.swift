import Foundation

/// On-device SHA claim pre-check, matching the Web app's claim-check.mjs. Rules come from the
/// Digital Health Agency's SHA claims submission guide: identifier formats, service dates inside
/// the billable period, a total that equals the item amounts, and a preauthorization reference
/// that matches the scan. Synthetic demo claims only.
struct ClaimDraft: Equatable, Sendable {
    var memberId: String
    var facilityId: String
    var practitionerId: String
    var serviceCode: String
    var requiresPreauth: Bool
    var billableStart: String
    var billableEnd: String
    var serviceStart: String
    var serviceEnd: String
    var itemAmounts: String
    var total: String
    var preauthReference: String

    static let demo = ClaimDraft(
        memberId: "CR10000000001-1", facilityId: "FID-21-100001-1", practitionerId: "PUID-1000001-1",
        serviceCode: "SHA-08-004", requiresPreauth: true,
        billableStart: "2026-11-02", billableEnd: "2026-11-06", serviceStart: "2026-11-03", serviceEnd: "2026-11-04",
        itemAmounts: "12000, 3500.50", total: "15500.50", preauthReference: "DEMO-PA-240817")

    static let demoWithErrors: ClaimDraft = {
        var claim = demo
        claim.memberId = "CR1000000001-1"
        claim.serviceEnd = "2026-11-08"
        claim.total = "15000"
        claim.preauthReference = "FID-21-100001-1"
        return claim
    }()
}

enum CheckStatus: String, Sendable { case pass, fail, pending }

struct ClaimCheckItem: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let status: CheckStatus
    let detail: String
}

struct ClaimCheckResult: Equatable, Sendable {
    enum Verdict: String, Sendable { case ready, pending, hold }
    let checks: [ClaimCheckItem]
    let verdict: Verdict
    let summary: String
}

enum ClaimCheck {
    private struct Format { let name: String; let pattern: String; let example: String }
    private static let formats: [(String, Format)] = [
        ("member", Format(name: "client registry ID", pattern: #"^CR\d{11}-\d$"#, example: "CRxxxxxxxxxxx-x")),
        ("facility", Format(name: "facility ID (FID)", pattern: #"^FID-21-\d{6}-\d$"#, example: "FID-21-xxxxxx-x")),
        ("practitioner", Format(name: "practitioner ID (PUID)", pattern: #"^PUID-\d{7}-\d$"#, example: "PUID-xxxxxxx-x")),
        ("service", Format(name: "SHA intervention code", pattern: #"^SHA-\d{2}-\d{3}$"#, example: "SHA-08-004")),
    ]

    private static func matches(_ pattern: String, _ value: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }

    private static func clean(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

    private static func cents(_ text: String) -> Int? {
        let value = clean(text)
        guard matches(#"^\d+(\.\d{1,2})?$"#, value), let decimal = Decimal(string: value) else { return nil }
        return NSDecimalNumber(decimal: decimal * 100).intValue
    }

    private static func formatCheck(_ id: String, _ key: String, _ value: String) -> ClaimCheckItem {
        let format = formats.first { $0.0 == key }!.1
        let ok = matches(format.pattern, clean(value))
        let title = "\(format.name.prefix(1).uppercased())\(format.name.dropFirst()) format"
        return ClaimCheckItem(id: id, title: title, status: ok ? .pass : .fail,
                              detail: ok ? "\(clean(value)) matches \(format.example)."
                                         : "Expected \(format.example). Correct it before submitting.")
    }

    private static func validDate(_ text: String) -> Bool {
        guard matches(#"^\d{4}-\d{2}-\d{2}$"#, text) else { return false }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        return formatter.date(from: text) != nil
    }

    static func check(_ claim: ClaimDraft, confirmedReference: String?, scanOutcome: NextStepCode?) -> ClaimCheckResult {
        var checks = [
            formatCheck("member-id", "member", claim.memberId),
            formatCheck("facility-id", "facility", claim.facilityId),
            formatCheck("practitioner-id", "practitioner", claim.practitionerId),
            formatCheck("service-code", "service", claim.serviceCode),
        ]
        let dates = [claim.billableStart, claim.billableEnd, claim.serviceStart, claim.serviceEnd].map(clean)
        let (billStart, billEnd, serveStart, serveEnd) = (dates[0], dates[1], dates[2], dates[3])
        let datesValid = dates.allSatisfy(validDate)
        let ordered = serveStart <= serveEnd && billStart <= billEnd
        checks.append(ClaimCheckItem(id: "service-period", title: "Service start and end dates",
            status: datesValid && ordered ? .pass : .fail,
            detail: !datesValid ? "Each intervention needs a start and an end date (YYYY-MM-DD)."
                : !ordered ? "A period ends before it starts." : "Service \(serveStart) to \(serveEnd)."))
        let within = datesValid && serveStart >= billStart && serveEnd <= billEnd
        checks.append(ClaimCheckItem(id: "billable-period", title: "Service dates within the billable period",
            status: within ? .pass : .fail,
            detail: within ? "\(serveStart) to \(serveEnd) is inside \(billStart) to \(billEnd)."
                : datesValid ? "Service \(serveStart) to \(serveEnd) falls outside the billable period \(billStart) to \(billEnd)."
                : "Service dates must fall within the claim's billable period."))

        let items = claim.itemAmounts.split(separator: ",").map { cents(String($0)) }
        let itemCents = items.isEmpty || items.contains(where: { $0 == nil }) ? nil : items.compactMap { $0 }.reduce(0, +)
        let totalCents = cents(claim.total)
        let totalOk = itemCents != nil && totalCents != nil && itemCents == totalCents
        checks.append(ClaimCheckItem(id: "claim-total", title: "Claim total equals the sum of item amounts",
            status: totalOk ? .pass : .fail,
            detail: itemCents == nil ? "Enter each item's net amount, separated by commas."
                : totalOk ? "\(items.count) item(s) add up to \(String(format: "%.2f", Double(itemCents!) / 100))."
                : "Items add up to \(String(format: "%.2f", Double(itemCents!) / 100)), not \(clean(claim.total).isEmpty ? "an empty total" : clean(claim.total))."))

        var scanHold: (summary: String, detail: String)?
        if claim.requiresPreauth && confirmedReference == nil {
            switch scanOutcome {
            case .conflict: scanHold = ("Hold: conflicting payer references on the scan",
                                        "The scan has more than one payer reference. Ask the payer which one applies before submitting.")
            case .noReference: scanHold = ("Hold: no payer reference on the scan",
                                           "The scan shows no usable payer reference. Get the preauthorization from the payer before submitting.")
            default: break
            }
        }
        if claim.requiresPreauth {
            let onClaim = clean(claim.preauthReference)
            let wrongKind = formats.first { matches($0.1.pattern, onClaim) }?.1
            var status = CheckStatus.fail
            let detail: String
            if let scanHold { detail = scanHold.detail }
            else if onClaim.isEmpty { detail = "This service requires preauthorization, but the claim has no reference." }
            else if let wrongKind { detail = "\(onClaim) looks like a \(wrongKind.name), not a payer preauthorization reference." }
            else if let confirmedReference {
                if onClaim == confirmedReference {
                    status = .pass
                    detail = "\(onClaim) matches the reference confirmed on the scan."
                } else {
                    detail = "The claim says \(onClaim), but the scan shows \(confirmedReference). Check every O, 0, I and 1."
                }
            } else {
                status = .pending
                detail = "Confirm the reference on the supporting scan first."
            }
            checks.append(ClaimCheckItem(id: "preauth-reference", title: "Preauthorization reference matches the scan",
                                         status: status, detail: detail))
        }
        let failed = checks.filter { $0.status == .fail }.count
        let pending = checks.filter { $0.status == .pending }.count
        let others = failed - (scanHold == nil ? 0 : 1)
        let summary: String
        if let scanHold { summary = scanHold.summary + (others > 0 ? " (+\(others) more issue\(others == 1 ? "" : "s"))" : "") }
        else if failed > 0 { summary = "Hold: \(failed) issue\(failed == 1 ? "" : "s") to fix before submitting" }
        else if pending > 0 { summary = "Almost ready: confirm the preauthorization reference on the scan" }
        else { summary = "Ready to submit. Payer approval still needs verification." }
        return ClaimCheckResult(checks: checks, verdict: failed > 0 ? .hold : pending > 0 ? .pending : .ready, summary: summary)
    }
}
