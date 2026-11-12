// Beam — a tiny projection-mapping app for macOS.
// Native shell: two WKWebViews (editor + output) bridged through a "pm" message handler.
// Owns everything the web layer can't do: windows on specific displays, display hot-plug,
// mirroring, keeping the projector awake, file pickers and Finder drag-and-drop.

import Cocoa
import WebKit
import UniformTypeIdentifiers
import IOKit.pwr_mgt

// Borderless windows can't become key by default; the output window needs keys (Esc).
final class KeyWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

// WKWebView that hands dropped files/folders to native code so JS gets real file:// URLs
// (JS drop events only expose anonymous File objects and can't see folders' paths).
final class DropWebView: WKWebView {
    var onFiles: (([URL], CGPoint) -> Void)?
    var onLink: ((String, CGPoint) -> Void)?

    private func fileURLs(_ info: NSDraggingInfo) -> [URL] {
        let opts: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        return (info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: opts) as? [URL]) ?? []
    }
    /// http(s) links dragged in from a browser's address bar or a YouTube page.
    private func webLink(_ info: NSDraggingInfo) -> String? {
        let urls = (info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL]) ?? []
        return urls.first { $0.scheme == "http" || $0.scheme == "https" }?.absoluteString
    }
    private func wants(_ s: NSDraggingInfo) -> Bool {
        (onFiles != nil && !fileURLs(s).isEmpty) || (onLink != nil && webLink(s) != nil)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        wants(sender) ? .copy : super.draggingEntered(sender)
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        wants(sender) ? .copy : super.draggingUpdated(sender)
    }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        wants(sender) ? true : super.prepareForDragOperation(sender)
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let p = convert(sender.draggingLocation, from: nil)
        let pt = CGPoint(x: p.x, y: isFlipped ? p.y : bounds.height - p.y)
        let urls = fileURLs(sender)
        if let cb = onFiles, !urls.isEmpty { cb(urls, pt); return true }
        if let cb = onLink, let link = webLink(sender) { cb(link, pt); return true }
        return super.performDragOperation(sender)
    }
}

/// A deliberately tiny HTTP server on 127.0.0.1 that serves exactly one static page: web/yt.html.
/// Why: YouTube refuses to play embeds whose page has no http(s) origin/Referer (error 153), and
/// Beam's UI is loaded from file://. Wrapping the player in a page served from localhost gives it
/// a real origin. It binds to loopback only (unreachable from the network), reads no files after
/// launch, and never echoes request data back, so it exposes nothing beyond that one public page.
final class LocalPageServer {
    private(set) var port: UInt16 = 0
    private let page: Data
    private var fd: Int32 = -1
    private var source: DispatchSourceRead?
    private let queue = DispatchQueue(label: "beam.pageserver")

    init?(page: Data) {
        self.page = page
        fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0 // let the OS pick a free port
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0, listen(fd, 16) == 0 else { close(fd); return nil }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
        }
        port = UInt16(bigEndian: addr.sin_port)
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        src.setEventHandler { [weak self] in self?.acceptOne() }
        src.resume()
        source = src
    }

    private func acceptOne() {
        let c = accept(fd, nil, nil)
        guard c >= 0 else { return }
        var one: Int32 = 1
        setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        var tv = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var buf = [UInt8](repeating: 0, count: 4096)
        let n = read(c, &buf, buf.count)
        let head = n > 0 ? String(decoding: buf[0..<n], as: UTF8.self) : ""
        let target = head.split(separator: " ", maxSplits: 2).dropFirst().first.map(String.init) ?? ""
        let path = target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? ""
        let ok = head.hasPrefix("GET ") && path == "/yt.html"
        let body = ok ? page : Data("Not found".utf8)
        var resp = Data(("HTTP/1.1 \(ok ? "200 OK" : "404 Not Found")\r\n" +
            "Content-Type: \(ok ? "text/html; charset=utf-8" : "text/plain")\r\n" +
            "Content-Length: \(body.count)\r\nCache-Control: no-store\r\n" +
            "Referrer-Policy: strict-origin-when-cross-origin\r\nConnection: close\r\n\r\n").utf8)
        resp.append(body)
        resp.withUnsafeBytes { p in
            var off = 0
            while off < p.count {
                let w = write(c, p.baseAddress! + off, p.count - off)
                if w <= 0 { break }
                off += w
            }
        }
        close(c)
    }
}

/// Encode any Swift string as a safe JS string literal (no string-splicing injection).
func jsString(_ s: String) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: [s], options: [])) ?? Data("[\"\"]".utf8)
    let arr = String(data: data, encoding: .utf8) ?? "[\"\"]"
    return String(arr.dropFirst().dropLast())
}

func displayID(_ s: NSScreen) -> CGDirectDisplayID {
    (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
}

func onlineDisplays() -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    guard CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetOnlineDisplayList(count, &ids, &count) == .success else { return [] }
    return Array(ids.prefix(Int(count)))
}

/// Displays that are currently mirroring another display (i.e. the projector is just copying the laptop).
func mirroringDisplays() -> [CGDirectDisplayID] {
    onlineDisplays().filter { CGDisplayMirrorsDisplay($0) != kCGNullDirectDisplay }
}

enum OutputMode { case window, hidden, display(CGDirectDisplayID) }

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, NSWindowDelegate {
    var editorWindow: NSWindow!
    var outputWindow: KeyWindow!
    var editor: DropWebView!
    var output: DropWebView!
    var lastState: String?
    var outputReady = false
    var pendingSplash: String?
    var mode: OutputMode = .window
    var knownDisplays = Set<CGDirectDisplayID>()
    var sleepAssertion: IOPMAssertionID = 0
    var pageServer: LocalPageServer?
    var beamCopyCount = -1 // NSPasteboard.changeCount when Beam last copied something internally

    lazy var supportDir: URL = {
        let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Beam", isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }()
    var autosaveURL: URL { supportDir.appendingPathComponent("autosave.json") }
    var webDir: URL { Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true) }

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        buildMenu()
        if let page = try? Data(contentsOf: webDir.appendingPathComponent("yt.html")) {
            pageServer = LocalPageServer(page: page)
        }

        var boot = "window.__PM_TUTORIAL_SEEN = \(UserDefaults.standard.bool(forKey: "tutorialSeen") ? "true" : "false");"
        if let s = try? String(contentsOf: autosaveURL, encoding: .utf8) {
            boot += "window.__PM_AUTOSAVE = \(jsString(s));"
        }
        editor = makeWebView(mode: "editor", extraBoot: boot)
        editor.onFiles = { [weak self] urls, pt in self?.sendMedia(urls, at: pt) }
        editor.onLink = { [weak self] link, pt in
            guard let self else { return }
            self.call(self.editor, "PM.onLink(link, x, y)", ["link": link, "x": Double(pt.x), "y": Double(pt.y)])
        }

        editorWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 880),
                                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                                backing: .buffered, defer: false)
        editorWindow.title = "Beam"
        editorWindow.contentView = editor
        editorWindow.minSize = NSSize(width: 1000, height: 620)
        editorWindow.backgroundColor = NSColor(calibratedWhite: 0.055, alpha: 1)
        editorWindow.isReleasedWhenClosed = false
        editorWindow.delegate = self
        editorWindow.center()
        editorWindow.setFrameAutosaveName("BeamEditor")
        editorWindow.makeKeyAndOrderFront(nil)

        output = makeWebView(mode: "output")
        outputWindow = KeyWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 540),
                                 styleMask: [.titled, .closable, .resizable, .miniaturizable],
                                 backing: .buffered, defer: false)
        outputWindow.title = "Beam Output (preview)"
        outputWindow.contentView = output
        outputWindow.backgroundColor = .black
        outputWindow.isReleasedWhenClosed = false
        outputWindow.delegate = self

        knownDisplays = Set(NSScreen.screens.map(displayID))
        if let ext = externalScreen() {
            mode = .display(displayID(ext))
            pendingSplash = ext.localizedName
        } else {
            mode = .window
        }
        applyOutput()

        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.screensChanged() }
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { setKeepAwake(false) }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === outputWindow { mode = .hidden; applyOutput(); return false }
        return true
    }
    func windowWillClose(_ notification: Notification) {
        if (notification.object as? NSWindow) === editorWindow { NSApp.terminate(nil) }
    }

    func makeWebView(mode: String, extraBoot: String = "") -> DropWebView {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "pm")
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let port = pageServer.map { Int($0.port) } ?? 0
        let src = "window.__PM_MODE = \(jsString(mode)); window.__PM_WEBPORT = \(port);" + extraBoot
        cfg.userContentController.addUserScript(
            WKUserScript(source: src, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let wv = DropWebView(frame: .zero, configuration: cfg)
        wv.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { wv.isInspectable = true }
        // Read access to "/" so media layers can reference files anywhere on disk via file:// URLs.
        wv.loadFileURL(webDir.appendingPathComponent("index.html"),
                       allowingReadAccessTo: URL(fileURLWithPath: "/"))
        return wv
    }

    // MARK: JS bridge

    func call(_ wv: WKWebView, _ body: String, _ args: [String: Any] = [:]) {
        wv.callAsyncJavaScript(body, arguments: args, in: nil, in: .page, completionHandler: nil)
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }

        if message.webView === output {
            switch type {
            case "outputReady":
                outputReady = true
                pushState()
                if let name = pendingSplash { pendingSplash = nil; call(output, "PM.splash(name)", ["name": name]) }
            case "exitFullscreen":
                if case .display = mode { mode = .window; applyOutput() }
            default: break
            }
            return
        }

        switch type {
        case "ready": sendScreens()
        case "state":
            if let j = body["json"] as? String { lastState = j; pushState() }
        case "autosave":
            if let j = body["json"] as? String { try? j.write(to: autosaveURL, atomically: true, encoding: .utf8) }
        case "setOutput":
            if let n = body["screen"] as? NSNumber { setOutputFromUI(n.intValue) }
        case "pickMedia": pickMedia()
        case "save":
            if let j = body["json"] as? String { saveProject(j) }
        case "open": openProject()
        case "unmirror": unmirror()
        case "displaySettings":
            if let u = URL(string: "x-apple.systempreferences:com.apple.Displays-Settings.extension") { NSWorkspace.shared.open(u) }
        case "tutorialSeen": UserDefaults.standard.set(true, forKey: "tutorialSeen")
        case "copied": beamCopyCount = NSPasteboard.general.changeCount
        case "pasteRequest":
            // Hand JS the system clipboard's text only if it's newer than Beam's own last copy,
            // so ⌘V pastes whichever thing you copied most recently.
            let pb = NSPasteboard.general
            let text = pb.changeCount != beamCopyCount ? (pb.string(forType: .string) ?? "") : ""
            call(editor, "PM.onPaste(text)", ["text": String(text.prefix(4096))])
        default: break
        }
    }

    func pushState() {
        guard outputReady, let j = lastState else { return }
        call(output, "PM.applyState(json)", ["json": j])
    }

    func toast(_ msg: String) { call(editor, "PM.toast(msg)", ["msg": msg]) }

    // MARK: displays

    /// The first screen that isn't the one the editor lives on — i.e. the projector.
    func externalScreen() -> NSScreen? {
        let ed = editorWindow.screen ?? NSScreen.main
        return NSScreen.screens.first { $0 != ed }
    }

    func screen(for id: CGDirectDisplayID) -> NSScreen? { NSScreen.screens.first { displayID($0) == id } }

    func sendScreens() {
        let current: Int
        switch mode {
        case .hidden: current = -2
        case .window: current = -1
        case .display(let id): current = NSScreen.screens.firstIndex { displayID($0) == id } ?? -1
        }
        let list: [[String: Any]] = NSScreen.screens.enumerated().map { i, s in
            ["index": i, "name": s.localizedName, "w": Int(s.frame.width), "h": Int(s.frame.height),
             "editor": s == editorWindow.screen, "builtin": CGDisplayIsBuiltin(displayID(s)) != 0]
        }
        call(editor, "PM.setScreens(list, current, mirrored)",
             ["list": list, "current": current, "mirrored": !mirroringDisplays().isEmpty])
    }

    func screensChanged() {
        let now = Set(NSScreen.screens.map(displayID))
        let added = now.subtracting(knownDisplays)
        knownDisplays = now
        // Plug-and-play: a newly connected display (that isn't hosting the editor) becomes the output.
        if let id = added.first(where: { screen(for: $0) != editorWindow.screen }), let sc = screen(for: id) {
            mode = .display(id)
            applyOutput()
            call(output, "PM.splash(name)", ["name": sc.localizedName])
            toast("Projector connected: \(sc.localizedName) — Beam is now projecting on it")
            NSSound(named: "Glass")?.play()
            return
        }
        if case .display(let id) = mode, screen(for: id) == nil {
            mode = .window
            toast("Projector disconnected — output moved to a preview window")
        }
        applyOutput()
    }

    func setOutputFromUI(_ i: Int) {
        let screens = NSScreen.screens
        if i == -2 { mode = .hidden }
        else if i >= 0 && i < screens.count { mode = .display(displayID(screens[i])) }
        else { mode = .window }
        applyOutput()
        if case .display = mode, i >= 0, i < screens.count {
            call(output, "PM.splash(name)", ["name": screens[i].localizedName])
        }
    }

    func applyOutput() {
        switch mode {
        case .hidden:
            outputWindow.orderOut(nil)
            setKeepAwake(false)
        case .display(let id):
            guard let sc = screen(for: id) else { mode = .window; applyOutput(); return }
            outputWindow.styleMask = [.borderless]
            outputWindow.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 1)
            outputWindow.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            outputWindow.setFrame(sc.frame, display: true)
            outputWindow.hasShadow = false
            if sc == editorWindow.screen {
                outputWindow.makeKeyAndOrderFront(nil) // so Esc works when it covers the editor
            } else {
                outputWindow.orderFrontRegardless()
                editorWindow.makeKey()
            }
            setKeepAwake(true)
        case .window:
            outputWindow.styleMask = [.titled, .closable, .resizable, .miniaturizable]
            outputWindow.level = .normal
            outputWindow.collectionBehavior = []
            outputWindow.hasShadow = true
            let base = (editorWindow.screen ?? NSScreen.main ?? NSScreen.screens[0]).visibleFrame
            outputWindow.setFrame(NSRect(x: base.maxX - 500, y: base.minY + 30, width: 480, height: 270), display: true)
            outputWindow.title = "Beam Output (preview)"
            outputWindow.orderFront(nil)
            setKeepAwake(false)
        }
        sendScreens()
    }

    /// Turn off mirroring so the projector becomes its own display. Only affects this login session.
    func unmirror() {
        let mirrored = mirroringDisplays()
        guard !mirrored.isEmpty else { sendScreens(); return }
        var cfg: CGDisplayConfigRef?
        guard CGBeginDisplayConfiguration(&cfg) == .success else { toast("Couldn't change display settings"); return }
        for id in mirrored { CGConfigureDisplayMirrorOfDisplay(cfg, id, kCGNullDirectDisplay) }
        if CGCompleteDisplayConfiguration(cfg, .forSession) != .success {
            toast("macOS refused the change — open Displays settings and pick “Extended display”")
        } else {
            toast("Mirroring off — switching to projector…")
        }
        // screensChanged() fires when macOS finishes reconfiguring and auto-projects onto the new display.
    }

    /// Keep the display (and projector) from sleeping while we're projecting.
    func setKeepAwake(_ on: Bool) {
        if on, sleepAssertion == 0 {
            var id: IOPMAssertionID = 0
            let r = IOPMAssertionCreateWithName(kIOPMAssertionTypeNoDisplaySleep as CFString,
                                                IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                                "Beam is projecting" as CFString, &id)
            if r == kIOReturnSuccess { sleepAssertion = id }
        } else if !on, sleepAssertion != 0 {
            IOPMAssertionRelease(sleepAssertion)
            sleepAssertion = 0
        }
    }

    // MARK: files

    func mediaFiles(in dir: URL) -> [URL] {
        guard let en = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.isRegularFileKey],
                                                      options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
        var out: [URL] = []
        for case let f as URL in en {
            if (try? f.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true { out.append(f) }
            if out.count >= 1000 { break }
        }
        return out.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
    }

    func sendMedia(_ urls: [URL], at pt: CGPoint?) {
        var files: [String] = []
        var folders: [[String: Any]] = []
        for u in urls {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir), isDir.boolValue {
                folders.append(["name": u.lastPathComponent, "urls": mediaFiles(in: u).map { $0.absoluteString }])
            } else {
                files.append(u.absoluteString)
            }
        }
        let x: Any = pt.map { NSNumber(value: Double($0.x)) } ?? NSNull()
        let y: Any = pt.map { NSNumber(value: Double($0.y)) } ?? NSNull()
        call(editor, "PM.onMedia(urls, x, y, folders)", ["urls": files, "x": x, "y": y, "folders": folders])
    }

    func pickMedia() {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = true
        p.canChooseDirectories = true
        p.canChooseFiles = true
        p.allowedContentTypes = [.image, .movie, .audiovisualContent, .folder]
        p.message = "Choose images, GIFs, videos — or whole folders. Hold ⌘ or ⇧ to pick many."
        p.prompt = "Add"
        p.beginSheetModal(for: editorWindow) { [weak self] r in
            guard let self else { return }
            if r == .OK { self.sendMedia(p.urls, at: nil) } else { self.call(self.editor, "PM.pickCancelled()") }
        }
    }

    func saveProject(_ json: String) {
        let p = NSSavePanel()
        p.allowedContentTypes = [.json]
        p.nameFieldStringValue = "Untitled Mapping.json"
        p.beginSheetModal(for: editorWindow) { [weak self] r in
            guard r == .OK, let u = p.url else { return }
            do { try json.write(to: u, atomically: true, encoding: .utf8); self?.toast("Saved \(u.lastPathComponent)") }
            catch { self?.toast("Save failed: \(error.localizedDescription)") }
        }
    }

    func openProject() {
        let p = NSOpenPanel()
        p.allowedContentTypes = [.json]
        p.beginSheetModal(for: editorWindow) { [weak self] r in
            guard let self, r == .OK, let u = p.url else { return }
            guard let s = try? String(contentsOf: u, encoding: .utf8) else { self.toast("Couldn't read that file"); return }
            self.call(self.editor, "PM.loadProject(text)", ["text": s])
        }
    }

    // MARK: menu

    func buildMenu() {
        let main = NSMenu()

        func sub(_ title: String, _ items: [NSMenuItem]) {
            let holder = NSMenuItem()
            let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }
            holder.submenu = m
            main.addItem(holder)
        }
        func cmd(_ title: String, _ key: String, _ name: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.representedObject = name
            i.target = self
            return i
        }
        func std(_ title: String, _ sel: Selector, _ key: String) -> NSMenuItem {
            NSMenuItem(title: title, action: sel, keyEquivalent: key)
        }

        sub("Beam", [
            std("About Beam", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            .separator(),
            std("Hide Beam", #selector(NSApplication.hide(_:)), "h"),
            std("Quit Beam", #selector(NSApplication.terminate(_:)), "q"),
        ])
        sub("File", [
            cmd("New Surface", "n", "addSurface"),
            cmd("Add Media…", "i", "addMedia"),
            cmd("Play Video or Link…", "l", "playUrl"),
            .separator(),
            cmd("Open Project…", "o", "open"),
            cmd("Save Project…", "s", "save"),
            .separator(),
            std("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        sub("Edit", [
            cmd("Undo", "z", "undo"),
            cmd("Redo", "z", "redo", [.command, .shift]),
            .separator(),
            std("Cut", #selector(NSText.cut(_:)), "x"),
            std("Copy", #selector(NSText.copy(_:)), "c"),
            std("Paste", #selector(NSText.paste(_:)), "v"),
            std("Select All", #selector(NSText.selectAll(_:)), "a"),
            .separator(),
            cmd("Duplicate Surface", "d", "duplicate"),
        ])
        sub("View", [
            cmd("Calibration Grid", "g", "calibrate"),
            cmd("Show / Hide Output", "o", "toggleOutput", [.command, .shift]),
        ])
        sub("Window", [
            std("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
        ])
        sub("Help", [
            cmd("Beam Tutorial", "/", "tutorial"),
            cmd("Load Demo Scene", "", "demo"),
        ])
        NSApp.mainMenu = main
    }

    @objc func menuAction(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        if name == "toggleOutput" {
            if outputWindow.isVisible { mode = .hidden } else if let ext = externalScreen() { mode = .display(displayID(ext)) } else { mode = .window }
            applyOutput()
            return
        }
        call(editor, "PM.menu(name)", ["name": name])
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
}
