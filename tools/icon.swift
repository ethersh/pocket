// Renders a 1024×1024 opaque app icon. Run with `xcrun swift icon.swift <out.png> <letter> <#hex|-> [source image]`.
// With a readable source image the site's own icon is used; otherwise a monogram is drawn.
// Exits 2 when a source was given but could not be decoded, so the caller can try the next candidate.
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let arguments = CommandLine.arguments
guard arguments.count >= 4 else { FileHandle.standardError.write(Data("usage: icon.swift <out.png> <letter> <#hex|-> [source]\n".utf8)); exit(64) }
let output = URL(fileURLWithPath: arguments[1])
let letter = String(arguments[2].prefix(1)).uppercased()
let side = 1024
let space = CGColorSpace(name: CGColorSpace.sRGB)!

func color(hex: String) -> CGColor? {
    guard hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
    return CGColor(colorSpace: space, components: [CGFloat((value >> 16) & 0xff) / 255, CGFloat((value >> 8) & 0xff) / 255, CGFloat(value & 0xff) / 255, 1])
}

/// The largest frame in the file; .ico files carry several.
func largestImage(at path: String) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return (0..<CGImageSourceGetCount(source)).compactMap { CGImageSourceCreateImageAtIndex(source, $0, nil) }.max { $0.width < $1.width }
}

struct Pixels {
    let data: [UInt8]
    let size: Int
    func rgba(_ x: Int, _ y: Int) -> (r: Double, g: Double, b: Double, a: Double) {
        let i = (y * size + x) * 4
        return (Double(data[i]) / 255, Double(data[i + 1]) / 255, Double(data[i + 2]) / 255, Double(data[i + 3]) / 255)
    }
}

func pixels(of image: CGImage, size: Int = 64) -> Pixels? {
    var data = [UInt8](repeating: 0, count: size * size * 4)
    guard let context = CGContext(data: &data, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    context.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
    return Pixels(data: data, size: size)
}

guard let canvas = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { exit(1) }
canvas.interpolationQuality = .high
let full = CGRect(x: 0, y: 0, width: side, height: side)

if arguments.count >= 5 {
    guard let image = largestImage(at: arguments[4]), let sample = pixels(of: image) else { exit(2) }
    let corners = [sample.rgba(1, 1), sample.rgba(62, 1), sample.rgba(1, 62), sample.rgba(62, 62)]
    let opaque = corners.allSatisfy { $0.a > 0.98 }
    if opaque {
        // Already a full-bleed tile: extend its own corner colour and only pad when upscaling would blur.
        let c = corners[0]
        canvas.setFillColor(CGColor(colorSpace: space, components: [c.r, c.g, c.b, 1])!)
        canvas.fill(full)
        let scale: CGFloat = image.width >= 256 ? 1 : 0.62
        let inset = CGFloat(side) * (1 - scale) / 2
        canvas.draw(image, in: full.insetBy(dx: inset, dy: inset))
    } else {
        // A cut-out logo: centre it on white, or on near-black when the logo itself is light.
        var (sum, weight) = (0.0, 0.0)
        for y in 0..<sample.size { for x in 0..<sample.size {
            let p = sample.rgba(x, y)
            guard p.a > 0.05 else { continue }
            sum += (0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b); weight += p.a
        } }
        let light = weight > 0 && sum / weight > 0.8
        canvas.setFillColor(light ? CGColor(colorSpace: space, components: [0.07, 0.07, 0.08, 1])! : CGColor(colorSpace: space, components: [1, 1, 1, 1])!)
        canvas.fill(full)
        let inset = CGFloat(side) * 0.17
        canvas.draw(image, in: full.insetBy(dx: inset, dy: inset))
    }
} else {
    let seed = arguments[2].unicodeScalars.reduce(UInt32(7)) { ($0 &* 31) &+ $1.value }
    let hue = CGFloat(seed % 360) / 360
    let background = color(hex: arguments[3]) ?? {
        // HSL(hue, 55%, 45%) → RGB
        let (s, l): (CGFloat, CGFloat) = (0.55, 0.45)
        let q = l + s - l * s, p = 2 * l - q
        func channel(_ t: CGFloat) -> CGFloat {
            let t = t < 0 ? t + 1 : t > 1 ? t - 1 : t
            if t < 1 / 6 { return p + (q - p) * 6 * t }
            if t < 1 / 2 { return q }
            if t < 2 / 3 { return p + (q - p) * (2 / 3 - t) * 6 }
            return p
        }
        return CGColor(colorSpace: space, components: [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3), 1])!
    }()
    canvas.setFillColor(background)
    canvas.fill(full)
    let components = background.components ?? [0, 0, 0, 1]
    let luminance = 0.2126 * components[0] + 0.7152 * components[1] + 0.0722 * components[2]
    let ink = luminance > 0.6 ? CGColor(colorSpace: space, components: [0.07, 0.07, 0.08, 1])! : CGColor(colorSpace: space, components: [1, 1, 1, 1])!
    let font = CTFontCreateUIFontForLanguage(.emphasizedSystem, 600, nil) ?? CTFontCreateWithName("Helvetica-Bold" as CFString, 600, nil)
    let text = NSAttributedString(string: letter.isEmpty ? "•" : letter, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): ink,
    ])
    let line = CTLineCreateWithAttributedString(text)
    let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
    canvas.textPosition = CGPoint(x: (CGFloat(side) - bounds.width) / 2 - bounds.minX, y: (CGFloat(side) - bounds.height) / 2 - bounds.minY)
    CTLineDraw(line, canvas)
}

guard let result = canvas.makeImage(), let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(destination, result, nil)
exit(CGImageDestinationFinalize(destination) ? 0 : 1)
