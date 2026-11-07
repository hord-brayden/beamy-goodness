// Renders the Beam app icon (1024×1024 PNG). Usage: swift tools/make_icon.swift out.png
import Cocoa

let S: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: Int(S), height: Int(S), bitsPerComponent: 8, bytesPerRow: 0,
                    space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
// Flip so y grows downward (easier to think in).
ctx.translateBy(x: 0, y: S); ctx.scaleBy(x: 1, y: -1)

func rgb(_ h: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((h >> 16) & 255) / 255, green: CGFloat((h >> 8) & 255) / 255, blue: CGFloat(h & 255) / 255, alpha: a)
}
func grad(_ cols: [CGColor], _ locs: [CGFloat]) -> CGGradient {
    CGGradient(colorsSpace: cs, colors: cols as CFArray, locations: locs)!
}

// 1. Squircle-ish tile (Apple icon grid: 824pt tile, ~185 radius, centered).
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = CGPath(roundedRect: tile, cornerWidth: 186, cornerHeight: 186, transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: rgb(0x000000, 0.45))
ctx.addPath(tilePath); ctx.setFillColor(rgb(0x0d0f16)); ctx.fillPath()
ctx.restoreGState()
ctx.saveGState()
ctx.addPath(tilePath); ctx.clip()
ctx.drawLinearGradient(grad([rgb(0x1f2333), rgb(0x0a0b11)], [0, 1]),
                       start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])
// subtle dot grid
ctx.setFillColor(rgb(0xffffff, 0.05))
var gy: CGFloat = 140
while gy < 924 { var gx: CGFloat = 140; while gx < 924 { ctx.fillEllipse(in: CGRect(x: gx, y: gy, width: 6, height: 6)); gx += 44 }; gy += 44 }

// 2. The warped target surface (perspective quad on the right).
let q = [CGPoint(x: 548, y: 262), CGPoint(x: 828, y: 214), CGPoint(x: 836, y: 806), CGPoint(x: 540, y: 744)]
let quad = CGMutablePath(); quad.addLines(between: q); quad.closeSubpath()

// 3. Light beam from the lens to the quad's left edge region.
let lens = CGPoint(x: 252, y: 548)
let beam = CGMutablePath()
beam.move(to: lens); beam.addLine(to: q[0]); beam.addLine(to: q[1]); beam.addLine(to: q[2]); beam.addLine(to: q[3]); beam.closeSubpath()
ctx.saveGState()
ctx.addPath(beam); ctx.clip()
ctx.drawRadialGradient(grad([rgb(0xffffff, 0.55), rgb(0x8fb4ff, 0.22), rgb(0x5b8cff, 0.0)], [0, 0.35, 1]),
                       startCenter: lens, startRadius: 0, endCenter: lens, endRadius: 640, options: [])
ctx.restoreGState()

// quad fill: diagonal gradient cyan → violet → pink → gold
ctx.saveGState()
ctx.setShadow(offset: .zero, blur: 60, color: rgb(0xff4fa3, 0.55))
ctx.addPath(quad); ctx.setFillColor(rgb(0x7c4dff)); ctx.fillPath()
ctx.restoreGState()
ctx.saveGState()
ctx.addPath(quad); ctx.clip()
ctx.drawLinearGradient(grad([rgb(0x00e5ff), rgb(0x7c4dff), rgb(0xff4fa3), rgb(0xffd34f)], [0, 0.38, 0.72, 1]),
                       start: CGPoint(x: 540, y: 214), end: CGPoint(x: 836, y: 806), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
// perspective grid lines inside the quad (bilinear interpolation of the corners)
func lerp(_ a: CGPoint, _ b: CGPoint, _ t: CGFloat) -> CGPoint { CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t) }
ctx.setStrokeColor(rgb(0xffffff, 0.35)); ctx.setLineWidth(4)
for i in 1..<4 {
    let t = CGFloat(i) / 4
    ctx.move(to: lerp(q[0], q[1], t)); ctx.addLine(to: lerp(q[3], q[2], t))
    ctx.move(to: lerp(q[0], q[3], t)); ctx.addLine(to: lerp(q[1], q[2], t))
}
ctx.strokePath()
ctx.restoreGState()
ctx.addPath(quad); ctx.setStrokeColor(rgb(0xffffff, 0.9)); ctx.setLineWidth(7); ctx.setLineJoin(.round); ctx.strokePath()
// corner handles
for p in q {
    ctx.setFillColor(rgb(0xffffff)); ctx.fillEllipse(in: CGRect(x: p.x - 20, y: p.y - 20, width: 40, height: 40))
    ctx.setFillColor(rgb(0x5b8cff)); ctx.fillEllipse(in: CGRect(x: p.x - 10, y: p.y - 10, width: 20, height: 20))
}

// 4. Lens (projector) with glow.
ctx.drawRadialGradient(grad([rgb(0xffffff, 0.9), rgb(0x8fb4ff, 0.35), rgb(0x5b8cff, 0)], [0, 0.4, 1]),
                       startCenter: lens, startRadius: 0, endCenter: lens, endRadius: 150, options: [])
ctx.setFillColor(rgb(0x14161e)); ctx.fillEllipse(in: CGRect(x: lens.x - 78, y: lens.y - 78, width: 156, height: 156))
ctx.setStrokeColor(rgb(0x3a4157)); ctx.setLineWidth(10); ctx.strokeEllipse(in: CGRect(x: lens.x - 78, y: lens.y - 78, width: 156, height: 156))
ctx.drawRadialGradient(grad([rgb(0xffffff), rgb(0xbfe9ff), rgb(0x5b8cff)], [0, 0.45, 1]),
                       startCenter: CGPoint(x: lens.x - 10, y: lens.y - 12), startRadius: 0, endCenter: lens, endRadius: 46, options: [])
ctx.restoreGState()

let img = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: img)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
