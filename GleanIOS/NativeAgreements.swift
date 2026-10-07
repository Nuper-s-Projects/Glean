import SwiftUI

private struct NativeTermSection: Identifiable {
    let title: String
    let paragraphs: [String]
    var id: String { title }
}

struct NativeSignUpView: View {
    @ObservedObject var auth: AuthStore
    @State private var username = ""
    @State private var password = ""
    @State private var grade = "no_response"
    @State private var school = "no_response"
    private var passwordsValid: Bool { password.count >= 10 }
    private var schoolSelectionValid: Bool { (grade == "no_response") == (school == "no_response") }
    var body: some View {
        Form {
            Section("Account") {
                TextField("Username", text: $username).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("Password (10 characters minimum)", text: $password).textContentType(.newPassword)
            }
            Section("School (optional)") {
                Picker("Grade", selection: $grade) { ForEach(NativeCatalog.grades, id: \.id) { Text($0.name).tag($0.id) } }
                Picker("School", selection: $school) { ForEach(NativeCatalog.schools, id: \.id) { Text($0.name).tag($0.id) } }
                Text("Choose both, or leave both as Prefer not to say.").font(.footnote).foregroundStyle(.secondary)
            }
            if let error = auth.error { Text(error).foregroundStyle(.red) }
            Section {
                Button { Task { await auth.signUp(username, password: password, grade: grade, school: school) } } label: {
                    HStack { Spacer(); if auth.busy { ProgressView() }; Text(auth.busy ? "Creating account…" : "Create account").fontWeight(.semibold); Spacer() }
                }.disabled(auth.busy || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !passwordsValid || !schoolSelectionValid)
                Text("By continuing, you’ll be asked to review Glean’s terms and the UISD Student Code of Conduct.").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Create account")
    }
}

struct NativeAgreementView: View {
    @ObservedObject var auth: AuthStore
    let agreement: Record
    let onAccepted: () -> Void
    @State private var termsAccepted = false
    @State private var conductAccepted = false
    @State private var waitRemaining = 5
    @State private var conductText: String?
    @State private var documentError: String?
    @State private var saving = false
    @State private var errorMessage: String?
    private let terms = [
        NativeTermSection(title: "1. Who can use Glean", paragraphs: ["Use Glean only when you are allowed to do so by applicable law and the school or district rules that apply to you. Glean’s availability outside school hours does not give permission to use it at school.", "If a parent, guardian, or school must give permission before you use an online service, get that permission first. Clicking this agreement records the signed-in user’s choice only. It is not parent or guardian consent, and it is not approval from UISD or another school."]),
        NativeTermSection(title: "2. Your account", paragraphs: ["Give your account a username that does not pretend to be another person. Keep your password private, use your own account, and tell Glean if you think someone else has accessed it.", "You are responsible for messages and other content you send through your account. To the extent permitted by applicable law, you may be held accountable for your conduct and for harm caused by your content. These terms do not make you responsible for more than the law allows or remove rights that cannot legally be waived."]),
        NativeTermSection(title: "3. Be safe and respectful", paragraphs: ["Do not send or post content that is abusive, threatening, harassing, discriminatory, sexually exploitative, or otherwise offensive or harmful. Do not bully, impersonate, deliberately target someone, share another person’s private information without permission, endanger a minor, or encourage violence or illegal activity.", "Do not spam, disrupt Glean, break into accounts or systems, evade a safety restriction, or upload content you do not have permission to share. By accepting these terms, you agree to follow Glean’s rules, the UISD Student Code of Conduct when it applies to you, and the rules of each server you join."]),
        NativeTermSection(title: "4. Direct-message privacy", paragraphs: ["Direct messages and their attachments are encrypted on your device before they are sent. Glean stores and delivers the encrypted content and does not have the private keys needed to read it in normal operation. Glean’s automatic server-side content moderation does not scan direct-message contents.", "Glean can still process limited information needed to operate and secure DMs, such as the accounts in a conversation, delivery times, and encrypted attachment sizes. A person you message can copy, capture, or share what you send. Someone with access to an unlocked or compromised device may also see messages, and losing your encryption keys may prevent you from reading older messages. Do not send anything you would not want the recipient to keep or share."]),
        NativeTermSection(title: "5. Content you share", paragraphs: ["You keep ownership of content you create. To provide Glean, you give Glean a limited permission to store, display, and transmit the content to the people and places you choose to share it with. This permission is only for operating the service; it does not make your content Glean’s property.", "Only share content that you have the right to share. Do not post private, confidential, or identifying information unless you have a good reason and permission."]),
        NativeTermSection(title: "6. Safety tools and moderation", paragraphs: ["Some Glean servers may use automatic content filters. Filters can miss harmful content or make mistakes. Use blocking, reporting, and moderation tools when available, and do not rely on Glean to prevent every unsafe interaction.", "Glean or server moderators may remove content or restrict an account when they reasonably believe it is needed to address a safety issue, a rule violation, or misuse of the service."]),
        NativeTermSection(title: "7. The school document is separate", paragraphs: ["The UISD Student Code of Conduct remains a school district document. Agreeing to these Glean terms does not sign or submit the parent/guardian receipt form in the PDF, replace any school process, or change the district’s rules or authority."]),
        NativeTermSection(title: "8. Changes and availability", paragraphs: ["Glean may change features or temporarily be unavailable. If Glean makes a material change to these terms, it may ask you to review and accept the new version before you continue using your account."])
    ]
    private var canAccept: Bool { termsAccepted && conductAccepted && waitRemaining == 0 && !saving }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("REQUIRED BEFORE CONTINUING").font(.caption.weight(.bold)).tracking(1.2).foregroundStyle(GleanStyle.blue)
                        Text("Review Glean’s terms").font(.largeTitle.bold())
                        Text("Please review Glean’s Terms of Service and the UISD Student Code of Conduct.").foregroundStyle(.secondary)
                        ForEach(terms) { section in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(section.title).font(.headline)
                                ForEach(section.paragraphs, id: \.self) { Text($0).font(.subheadline).fixedSize(horizontal: false, vertical: true) }
                            }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(GleanStyle.panel, in: RoundedRectangle(cornerRadius: 14))
                        }
                        VStack(alignment: .leading, spacing: 10) {
                            HStack { Text("UISD Student Code of Conduct").font(.headline); Spacer(); Link("Open PDF", destination: URL(string: "https://d3bdx5il6w3di0.cloudfront.net/documents/uisd-student-code-of-conduct-2026-27.pdf#page=13&view=FitH")!).font(.subheadline) }
                            if let conductText { Text(conductText).font(.caption).textSelection(.enabled).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading) }
                            else if let documentError { Text(documentError).font(.footnote).foregroundStyle(.red) }
                            else { ProgressView("Loading the district document…") }
                        }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(GleanStyle.panel, in: RoundedRectangle(cornerRadius: 14))
                        Toggle("I agree to Glean’s Terms of Service and will follow its safety and conduct rules.", isOn: $termsAccepted)
                        Toggle("I have reviewed the UISD Student Code of Conduct and agree to follow it when it applies to me.", isOn: $conductAccepted)
                        if let errorMessage { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                    }.padding(20)
                }
                HStack(spacing: 14) {
                    Button("Sign out", role: .destructive) { Task { await auth.signOut() } }.disabled(saving)
                    Spacer()
                    if waitRemaining > 0 { Text("Please wait \(waitRemaining) seconds").font(.caption).foregroundStyle(.secondary) }
                    Button { Task { await accept() } } label: { if saving { ProgressView().tint(.white) } else { Text("Accept and continue") } }
                        .buttonStyle(.borderedProminent).disabled(!canAccept)
                }.padding(16).background(.bar)
            }
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled()
        }
        .task {
            for value in stride(from: waitRemaining, through: 1, by: -1) { waitRemaining = value; try? await Task.sleep(for: .seconds(1)) }
            waitRemaining = 0
            await loadConductText()
        }
    }
    private func loadConductText() async {
        do {
            let url = try await auth.media("/documents/uisd-student-code-of-conduct-2026-27.txt")
            defer { try? FileManager.default.removeItem(at: url) }
            conductText = try String(contentsOf: url, encoding: .utf8)
        } catch { documentError = "Open the PDF to review the district document." }
    }
    private func accept() async {
        saving = true; errorMessage = nil; defer { saving = false }
        do {
            _ = try await auth.request("api/account/agreements", body: ["termsAccepted": true, "conductAccepted": true, "termsVersion": agreement.text("termsVersion"), "conductVersion": agreement.text("conductVersion")])
            onAccepted()
        } catch { errorMessage = error.localizedDescription }
    }
}
