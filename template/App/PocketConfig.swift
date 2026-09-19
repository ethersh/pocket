import UIKit

/// Everything the CLI decided at generation time. Lives in `pocket.json` so it can be tweaked in
/// Xcode without re-running the generator.
struct PocketConfig: Decodable {
    enum DynamicTypeMode: String, Decodable { case text, zoom, off }
    enum Edges: String, Decodable { case auto, inset, full }
    enum Popups: String, Decodable { case same, safari }

    let url: URL
    let internalHosts: [String]
    let dynamicType: DynamicTypeMode
    let minTextScale: Double
    let maxTextScale: Double
    let edges: Edges
    let popups: Popups
    let lockZoom: Bool
    let pullToRefresh: Bool
    let hideKeyboardBar: Bool
    let camera: Bool
    let microphone: Bool
    let allowInsecure: Bool
    let userAgent: String?
    let themeColor: String?

    static let shared: PocketConfig = {
        guard let file = Bundle.main.url(forResource: "pocket", withExtension: "json"),
              let data = try? Data(contentsOf: file) else { fatalError("pocket.json is missing from the app bundle") }
        do { return try JSONDecoder().decode(PocketConfig.self, from: data) } catch { fatalError("pocket.json is invalid: \(error)") }
    }()

    static func resource(_ name: String, _ ext: String) -> String? {
        guard let file = Bundle.main.url(forResource: name, withExtension: ext) else { return nil }
        return try? String(contentsOf: file, encoding: .utf8)
    }

    func isInternal(host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return internalHosts.contains { host == $0 || host.hasSuffix("." + $0) }
    }
}

enum NavigationVerdict { case web, external, blocked }

extension PocketConfig {
    /// Web content stays in the webview (OAuth redirects included), a short list of system
    /// schemes is handed to iOS, everything else is dropped.
    func verdict(for url: URL, userInitiated: Bool) -> NavigationVerdict {
        switch url.scheme?.lowercased() {
        case "https", "about", "blob": return .web
        case "http": return allowInsecure ? .web : .blocked
        case "mailto", "tel", "sms", "facetime", "facetime-audio", "maps", "itms-apps": return .external
        case "javascript", "file", "data", nil: return .blocked
        default: return userInitiated ? .external : .blocked
        }
    }
}

extension UIColor {
    convenience init?(hex: String) {
        guard hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }

    /// WCAG relative luminance; below 0.179 white status bar text has the better contrast.
    var prefersLightContent: Bool {
        var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        getRed(&r, green: &g, blue: &b, alpha: &a)
        let linear = [r, g, b].map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 < 0.179
    }
}
