// J-Inbox's sign-in window, for chat apps whose only sign-in is their own website (Beeper's cookies
// step: Instagram, for one). The connector starts it and writes one JSON line on its stdin:
//   {"title", "url", "userAgent"?, "expectedFinalURLRegex"?, "fields": [{"id", "name", "type"}], "extractJS"?}
// It shows the site in a window with that title. When the page's address matches
// expectedFinalURLRegex (any address when there is none), it collects exactly the fields asked for
// (cookies from the web view's cookie store, local storage keys, request headers the page sends;
// Beeper's extractJS is run as the docs say, as an opaque helper whose answer may hold some of
// the fields) and writes {"fields": {...}, "lastURL": "..."} as one line on stdout, then quits.
// Closing the window writes {"closed": true}. When its stdin closes (the connector stopped or
// cancelled the sign-in) it quits at once. Nothing is ever written to disk or to stderr: the web
// view's data store is not persistent, and the values only go to the connector, which hands them
// to Beeper. On stdout before the answer: {"event": "shown", "editKeys": [...]} once the window is
// on screen. Its menu bar has Edit (Cut, Copy, Paste, Select All, Undo, Redo) so pasting works.
import AppKit
import Foundation
import WebKit

struct Field: Decodable {
  let id: String
  let name: String
  let type: String
}

struct Request: Decodable {
  let title: String
  let url: String
  let userAgent: String?
  let expectedFinalURLRegex: String?
  let fields: [Field]
  let extractJS: String?
}

let out = FileHandle.standardOutput
var answered = false

func say(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
  out.write(data)
  out.write("\n".data(using: .utf8)!)
}

func finish(_ obj: [String: Any]) {
  if answered { return }
  answered = true
  say(obj)
  exit(0)
}

/** The first line of stdin, read off the main thread; then waits for its end (the connector went away). */
func readRequest(_ done: @escaping (Request?) -> Void) {
  DispatchQueue.global().async {
    var buf = Data()
    let input = FileHandle.standardInput
    var request: Request? = nil
    var delivered = false
    while true {
      let chunk = input.availableData
      if chunk.isEmpty { break }
      if delivered { continue }
      buf.append(chunk)
      if buf.count > 1_000_000 { break }
      if let nl = buf.firstIndex(of: 0x0A) {
        request = try? JSONDecoder().decode(Request.self, from: buf.subdata(in: buf.startIndex..<nl))
        delivered = true
        let r = request
        DispatchQueue.main.async { done(r) }
      }
    }
    // stdin closed: the connector cancelled the sign-in or stopped.
    DispatchQueue.main.async {
      if !delivered { done(nil) } else { exit(0) }
    }
  }
}

/** The page's request headers, by name (lowercase), for "header" fields: the page's own fetch and XHR calls. */
func headerScript(_ names: [String]) -> String {
  let list = (try? String(data: JSONSerialization.data(withJSONObject: names.map { $0.lowercased() }), encoding: .utf8)) ?? "[]"
  return """
  (() => {
    const want = new Set(\(list));
    const post = (k, v) => { try { if (want.has(String(k).toLowerCase())) window.webkit.messageHandlers.jinboxHeaders.postMessage([String(k).toLowerCase(), String(v)]); } catch (e) {} };
    const f = window.fetch;
    if (f) window.fetch = function (input, init) {
      try {
        const h = new Headers((init && init.headers) || (input && input.headers) || {});
        h.forEach((v, k) => post(k, v));
      } catch (e) {}
      return f.apply(this, arguments);
    };
    const set = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) { post(k, v); return set.apply(this, arguments); };
  })();
  """
}

final class SignIn: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  let req: Request
  let window: NSWindow
  let web: WKWebView
  let address = NSTextField(labelWithString: "")
  var headers: [String: String] = [:]
  var collecting = false
  var timer: Timer?
  var urlWatch: NSKeyValueObservation?
  let finalURL: NSRegularExpression?

  init(_ req: Request) {
    self.req = req
    finalURL = req.expectedFinalURLRegex.flatMap { try? NSRegularExpression(pattern: $0) }
    let config = WKWebViewConfiguration()
    // Nothing of the site (cookies, storage, cache) is kept on disk.
    config.websiteDataStore = WKWebsiteDataStore.nonPersistent()
    let headerNames = req.fields.filter { $0.type == "header" }.map { $0.name }
    let controller = WKUserContentController()
    config.userContentController = controller
    web = WKWebView(frame: .zero, configuration: config)
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 720), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    super.init()
    if !headerNames.isEmpty {
      controller.addUserScript(WKUserScript(source: headerScript(headerNames), injectionTime: .atDocumentStart, forMainFrameOnly: false))
      controller.add(self, name: "jinboxHeaders")
    }
    if let ua = req.userAgent, !ua.isEmpty { web.customUserAgent = ua }
    web.navigationDelegate = self
    web.uiDelegate = self

    window.title = req.title
    window.isReleasedWhenClosed = false
    window.delegate = self
    address.font = NSFont.systemFont(ofSize: 12)
    address.textColor = .secondaryLabelColor
    address.alignment = .center
    address.lineBreakMode = .byTruncatingMiddle
    let bar = NSStackView(views: [address])
    bar.orientation = .horizontal
    bar.edgeInsets = NSEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
    let stack = NSStackView(views: [bar, web])
    stack.orientation = .vertical
    stack.spacing = 0
    stack.alignment = .width
    window.contentView = stack
    window.center()
    urlWatch = web.observe(\.url, options: [.new]) { [weak self] _, _ in
      DispatchQueue.main.async { self?.check() }
    }
  }

  func start() {
    guard let url = URL(string: req.url), url.scheme == "https" || (url.scheme == "http" && (url.host == "127.0.0.1" || url.host == "localhost")) else {
      finish(["error": "bad url"])
      return
    }
    showAddress(url)
    web.load(URLRequest(url: url))
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    window.orderFrontRegardless()
    // The site may set what Beeper needs a little after the page loads.
    timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.check() }
  }

  func showAddress(_ url: URL?) {
    guard let url = url else { return }
    address.stringValue = (url.scheme == "https" ? "🔒 " : "") + (url.host ?? "")
  }

  func atFinalURL() -> Bool {
    guard let s = web.url?.absoluteString else { return false }
    guard let re = finalURL else { return true }
    return re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
  }

  func check() {
    showAddress(web.url)
    if collecting || answered || !atFinalURL() { return }
    collecting = true
    collect { values in
      self.collecting = false
      let wanted = Set(self.req.fields.map { $0.id })
      let got = values.filter { wanted.contains($0.key) && !$0.value.isEmpty }
      if got.count == wanted.count {
        finish(["fields": got, "lastURL": self.web.url?.absoluteString ?? ""])
      }
    }
  }

  func collect(_ done: @escaping ([String: String]) -> Void) {
    var values: [String: String] = [:]
    let group = DispatchGroup()
    // Beeper's extract script first: whatever it answers for the fields asked for counts.
    if let js = req.extractJS, !js.isEmpty {
      group.enter()
      web.callAsyncJavaScript("return await (\(js));", arguments: [:], in: nil, in: .page) { result in
        if case .success(let v) = result, let dict = v as? [String: Any] {
          for (k, x) in dict { if let s = x as? String { values[k] = s } }
        }
        group.leave()
      }
    }
    let cookieFields = req.fields.filter { $0.type == "cookie" }
    if !cookieFields.isEmpty {
      group.enter()
      web.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
        let host = self.web.url?.host ?? ""
        for f in cookieFields {
          let named = cookies.filter { $0.name == f.name }
          let best = named.first { c in let d = c.domain.hasPrefix(".") ? String(c.domain.dropFirst()) : c.domain; return host == d || host.hasSuffix("." + d) } ?? named.first
          if let c = best, values[f.id] == nil { values[f.id] = c.value }
        }
        group.leave()
      }
    }
    for f in req.fields where f.type == "local_storage" {
      group.enter()
      web.callAsyncJavaScript("return window.localStorage.getItem(key);", arguments: ["key": f.name], in: nil, in: .page) { result in
        if case .success(let v) = result, let s = v as? String, values[f.id] == nil { values[f.id] = s }
        group.leave()
      }
    }
    for f in req.fields where f.type == "header" {
      if let v = headers[f.name.lowercased()], values[f.id] == nil { values[f.id] = v }
    }
    group.notify(queue: .main) { done(values) }
  }

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    if let pair = message.body as? [String], pair.count == 2 { headers[pair[0]] = pair[1] }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { check() }

  // A site's own pop-up (a "Continue with ..." button): shown in this window.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { webView.load(URLRequest(url: url)) }
    return nil
  }

  var shown = false
  func windowDidChangeOcclusionState(_ notification: Notification) {
    if !shown && window.occlusionState.contains(.visible) {
      shown = true
      say(["event": "shown", "onScreen": true, "editKeys": editKeys()])
    }
  }

  func windowWillClose(_ notification: Notification) { finish(["closed": true]) }
}

/**
 * The menu bar: Close and Quit, and Edit with the standard commands. A web view gets Cmd+V, Cmd+C,
 * Cmd+X, Cmd+A and Cmd+Z only through the main menu's key equivalents: without this menu a pasted
 * password or code never arrives.
 */
func mainMenu() -> NSMenu {
  let main = NSMenu()
  let appItem = NSMenuItem()
  main.addItem(appItem)
  let appMenu = NSMenu(title: "J-Inbox Sign-in")
  appMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
  appMenu.addItem(.separator())
  appMenu.addItem(withTitle: "Quit J-Inbox Sign-in", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
  appItem.submenu = appMenu
  let editItem = NSMenuItem()
  main.addItem(editItem)
  let edit = NSMenu(title: "Edit")
  edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
  edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z").keyEquivalentModifierMask = [.command, .shift]
  edit.addItem(.separator())
  edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
  edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
  edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
  edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
  editItem.submenu = edit
  return main
}

/** The Edit menu's key equivalents (the "shown" event names them, so a test sees the menu is there). */
func editKeys() -> [String] {
  guard let edit = NSApp.mainMenu?.items.first(where: { $0.submenu?.title == "Edit" })?.submenu else { return [] }
  return edit.items.filter { !$0.keyEquivalent.isEmpty && $0.action != nil }.map { ($0.keyEquivalentModifierMask.contains(.shift) ? "shift+" : "") + $0.keyEquivalent }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.mainMenu = mainMenu()
// Quit is the same as closing the window: the connector hears {"closed": true}.
NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { _ in finish(["closed": true]) }
var signIn: SignIn?
readRequest { req in
  guard let req = req, !req.fields.isEmpty else {
    finish(["error": "no request"])
    return
  }
  signIn = SignIn(req)
  signIn?.start()
}
app.run()
