import SwiftUI

extension GleanStyle {
    static let background = Color(uiColor: .systemGroupedBackground)
    static let border = Color.primary.opacity(0.08)
    static let cardRadius: CGFloat = 20
}

private struct GleanAppAppearance: ViewModifier {
    func body(content: Content) -> some View {
        content
            .listStyle(.insetGrouped)
            .listSectionSpacing(16)
            .environment(\.defaultMinListRowHeight, 54)
            .scrollDismissesKeyboard(.interactively)
            .background(GleanStyle.background.ignoresSafeArea())
    }
}

extension View {
    func gleanAppAppearance() -> some View { modifier(GleanAppAppearance()) }
    func gleanInputSurface() -> some View {
        background(GleanStyle.panel, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(GleanStyle.border))
    }
}

struct GleanSymbolTile: View {
    let symbol: String
    var color = GleanStyle.blue
    var size: CGFloat = 34
    var body: some View {
        Image(systemName: symbol)
            .font(.body.weight(.semibold))
            .foregroundStyle(color)
            .frame(width: size, height: size)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            .accessibilityHidden(true)
    }
}

struct GleanNavigationRow: View {
    let title: String
    let symbol: String
    var subtitle: String? = nil
    var body: some View {
        HStack(spacing: 12) {
            GleanSymbolTile(symbol: symbol)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body.weight(.medium)).foregroundStyle(.primary)
                if let subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

struct GleanUnreadBadge: View {
    let count: Int
    var body: some View {
        Text(count > 99 ? "99+" : String(count))
            .font(.caption2.bold()).monospacedDigit()
            .foregroundStyle(.white)
            .padding(.horizontal, 7).padding(.vertical, 4)
            .frame(minWidth: 23, minHeight: 23)
            .background(GleanStyle.blue, in: Capsule())
            .accessibilityLabel("\(count) unread messages")
    }
}

struct GleanPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        let color = configuration.role == .destructive ? Color.red : GleanStyle.blue
        configuration.label
            .font(.headline)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(.white)
            .background(color.opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.4), in: RoundedRectangle(cornerRadius: 14))
    }
}

struct GleanFeedback: View {
    let message: String
    let failed: Bool
    var body: some View {
        Label {
            Text(message).font(.footnote).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: failed ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                .foregroundStyle(failed ? Color.red : Color.green)
        }
        .foregroundStyle(.primary)
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background((failed ? Color.red : Color.green).opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }
}

/// Static placeholders avoid extra timers or shimmer work on lower-end phones.
struct GleanLoadingState: View {
    let title: String
    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 18) {
                ForEach(0..<5) { index in
                    HStack(spacing: 12) {
                        Circle().fill(.quaternary).frame(width: 44, height: 44)
                        VStack(alignment: .leading, spacing: 8) {
                            RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(width: index % 2 == 0 ? 130 : 100, height: 12)
                            RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(maxWidth: .infinity).frame(height: 9)
                        }
                        Spacer(minLength: 12)
                    }
                }
            }.padding(18).background(GleanStyle.panel, in: RoundedRectangle(cornerRadius: GleanStyle.cardRadius))
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(GleanStyle.background)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading \(title)")
    }
}
