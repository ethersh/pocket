import SafariServices
import UIKit
import WebKit

final class WebViewController: UIViewController {
    private let config = PocketConfig.shared
    private let bridgeWorld = WKContentWorld.world(name: "PocketBridge")
    private let bridgeSource = (PocketConfig.resource("bridge", "js") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    private let userCSS = PocketConfig.resource("user", "css") ?? ""
    private let userJS = PocketConfig.resource("user", "js") ?? ""

    private var webView: WKWebView!
    private let topBar = UIView()
    private let progressBar = UIProgressView(progressViewStyle: .bar)
    private let launchCover = UIView()
    private var errorView: ErrorView?
    private var insetLayout: [NSLayoutConstraint] = []
    private var fullLayout: [NSLayoutConstraint] = []
    private var observations: [NSKeyValueObservation] = []
    private var downloads: [WKDownload: URL] = [:]

    private var edgeToEdge = false
    private var statusStyle: UIStatusBarStyle = .default
    private var lastState = ""

    override var preferredStatusBarStyle: UIStatusBarStyle { statusStyle }

    // MARK: Setup

    override func viewDidLoad() {
        super.viewDidLoad()
        let initial = config.themeColor.flatMap(UIColor.init(hex:))
        view.backgroundColor = initial ?? .systemBackground
        topBar.backgroundColor = initial ?? .systemBackground
        if let initial { statusStyle = initial.prefersLightContent ? .lightContent : .darkContent }

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .audio
        // Identify as mobile Safari; several sign-in providers refuse unknown embedded browsers.
        let version = UIDevice.current.systemVersion.split(separator: ".").prefix(2).joined(separator: ".")
        configuration.applicationNameForUserAgent = "Version/\(version) Mobile/15E148 Safari/604.1"
        configuration.userContentController.add(WeakMessageHandler(self), contentWorld: bridgeWorld, name: "pocket")

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.customUserAgent = config.userAgent
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.automaticallyAdjustsScrollIndicatorInsets = false
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        if config.pullToRefresh {
            let refresh = UIRefreshControl()
            refresh.addTarget(self, action: #selector(reload), for: .valueChanged)
            webView.scrollView.refreshControl = refresh
        }

        layoutViews()
        installScripts()
        observations.append(webView.observe(\.estimatedProgress) { [weak self] webView, _ in self?.showProgress(webView.estimatedProgress) })
        NotificationCenter.default.addObserver(self, selector: #selector(textSizeChanged), name: UIContentSizeCategory.didChangeNotification, object: nil)
        applyPageZoom()
        webView.load(URLRequest(url: config.url))
    }

    private func layoutViews() {
        for subview in [webView!, topBar, progressBar, launchCover] as [UIView] {
            subview.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(subview)
        }
        let safe = view.safeAreaLayoutGuide
        insetLayout = [
            webView.topAnchor.constraint(equalTo: safe.topAnchor), webView.bottomAnchor.constraint(equalTo: safe.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: safe.leadingAnchor), webView.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
        ]
        fullLayout = [
            webView.topAnchor.constraint(equalTo: view.topAnchor), webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor), webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ]
        NSLayoutConstraint.activate(insetLayout + [
            topBar.topAnchor.constraint(equalTo: view.topAnchor), topBar.bottomAnchor.constraint(equalTo: safe.topAnchor),
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor), topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            progressBar.topAnchor.constraint(equalTo: safe.topAnchor),
            progressBar.leadingAnchor.constraint(equalTo: view.leadingAnchor), progressBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            launchCover.topAnchor.constraint(equalTo: view.topAnchor), launchCover.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            launchCover.leadingAnchor.constraint(equalTo: view.leadingAnchor), launchCover.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        progressBar.trackTintColor = .clear
        progressBar.alpha = 0
        progressBar.isUserInteractionEnabled = false

        launchCover.backgroundColor = view.backgroundColor
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimating()
        launchCover.addSubview(spinner)
        NSLayoutConstraint.activate([spinner.centerXAnchor.constraint(equalTo: launchCover.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: launchCover.centerYAnchor)])
    }

    // MARK: Dynamic Type

    /// The user's Text Size as a multiplier of the default (Large) body size: 0.82 at XS, 1.0 at
    /// Large, 1.35 at XXXL and up to 3.12 at the largest accessibility size.
    private var textScale: Double {
        guard config.dynamicType != .off else { return 1 }
        // Read the app-wide category: when the change notification fires, this controller's own
        // trait collection still holds the previous size.
        let traits = UITraitCollection(preferredContentSizeCategory: UIApplication.shared.preferredContentSizeCategory)
        // The body style's own curve (14pt at XS … 17pt at Large … 53pt at AX5), relative to its default.
        let scaled = UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits).pointSize
        let clamped = min(max(Double(scaled) / 17, config.minTextScale), config.maxTextScale)
        return (clamped * 100).rounded() / 100
    }

    /// text-size-adjust is ignored by WebKit in iPad's desktop-class content mode, so iPads fall
    /// back to scaling the whole page.
    private var usesPageZoom: Bool {
        config.dynamicType == .zoom || (config.dynamicType == .text && traitCollection.userInterfaceIdiom == .pad)
    }

    private func applyPageZoom() {
        if usesPageZoom { webView.pageZoom = textScale }
    }

    @objc private func textSizeChanged() {
        applyPageZoom()
        installScripts()
        pushState()
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory { textSizeChanged() }
    }

    // MARK: Bridge

    private var bridgeState: [String: Any] {
        let insets = view.safeAreaInsets
        return ["textScale": textScale, "safeTop": insets.top, "safeBottom": insets.bottom, "safeLeft": insets.left, "safeRight": insets.right]
    }

    private func json(_ object: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return "{}" }
        // U+2028/2029 are valid in JSON but were line terminators in older JavaScript.
        return text.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    /// User scripts carry the current state so every new document (and iframe) starts at the right
    /// size with no flash; they are rebuilt whenever that state changes.
    private func installScripts() {
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        guard !bridgeSource.isEmpty else { return }
        var initial = bridgeState
        initial["mode"] = usesPageZoom ? "zoom" : config.dynamicType.rawValue
        initial["lockZoom"] = config.lockZoom
        initial["edges"] = config.edges.rawValue
        initial["hosts"] = config.internalHosts
        initial["userCSS"] = userCSS
        controller.addUserScript(WKUserScript(source: bridgeSource + "(" + json(initial) + ");", injectionTime: .atDocumentStart, forMainFrameOnly: false, in: bridgeWorld))
        if !userJS.isEmpty {
            let guarded = "(() => { const hosts = \(json(config.internalHosts)); if (!hosts.some((host) => location.hostname === host || location.hostname.endsWith('.' + host))) return;\n\(userJS)\n})();"
            controller.addUserScript(WKUserScript(source: guarded, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .page))
        }
    }

    private func pushState() {
        guard isViewLoaded else { return }
        let state = json(bridgeState)
        guard state != lastState else { return }
        lastState = state
        webView.evaluateJavaScript("window.__pocket ? window.__pocket.update(\(state)) : false", in: nil, in: bridgeWorld) { _ in }
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        installScripts()
        pushState()
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let raw = message.body as? String, raw.utf8.count <= 512,
              let chrome = try? JSONDecoder().decode(ChromeMessage.self, from: Data(raw.utf8)), chrome.type == "pocket-chrome",
              let top = UIColor(hex: chrome.top), let bottom = UIColor(hex: chrome.bottom) else { return }
        topBar.backgroundColor = top
        view.backgroundColor = bottom
        statusStyle = top.prefersLightContent ? .lightContent : .darkContent
        progressBar.progressTintColor = (top.prefersLightContent ? UIColor.white : UIColor.black).withAlphaComponent(0.55)
        setNeedsStatusBarAppearanceUpdate()
        setEdgeToEdge(chrome.edge)
        dismissLaunchCover()
    }

    private func setEdgeToEdge(_ enabled: Bool) {
        guard enabled != edgeToEdge else { return }
        edgeToEdge = enabled
        NSLayoutConstraint.deactivate(enabled ? insetLayout : fullLayout)
        NSLayoutConstraint.activate(enabled ? fullLayout : insetLayout)
        topBar.isHidden = enabled
    }

    // MARK: Chrome

    private func showProgress(_ progress: Double) {
        progressBar.setProgress(Float(progress), animated: progress > Double(progressBar.progress))
        UIView.animate(withDuration: 0.25, delay: progress >= 1 ? 0.2 : 0) { self.progressBar.alpha = progress >= 1 ? 0 : 1 }
    }

    private func dismissLaunchCover() {
        guard launchCover.superview != nil, launchCover.tag == 0 else { return }
        launchCover.tag = 1
        UIView.animate(withDuration: 0.2, animations: { self.launchCover.alpha = 0 }, completion: { _ in self.launchCover.removeFromSuperview() })
    }

    @objc private func reload() {
        errorView?.removeFromSuperview()
        errorView = nil
        if webView.url == nil { webView.load(URLRequest(url: config.url)) } else { webView.reload() }
    }

    private func fail(_ error: Error) {
        webView.scrollView.refreshControl?.endRefreshing()
        let code = (error as NSError).code
        // Cancelled loads and navigations that turned into downloads are not failures.
        if code == NSURLErrorCancelled || code == 102 { return }
        dismissLaunchCover()
        errorView?.removeFromSuperview()
        let errorView = ErrorView(message: error.localizedDescription) { [weak self] in self?.reload() }
        errorView.backgroundColor = view.backgroundColor
        errorView.frame = view.bounds
        errorView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(errorView)
        self.errorView = errorView
    }

    private func openOutside(_ url: URL) {
        if config.popups == .safari, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            present(SFSafariViewController(url: url), animated: true)
        } else {
            UIApplication.shared.open(url)
        }
    }
}

private struct ChromeMessage: Decodable {
    let type: String
    let top: String
    let bottom: String
    let edge: Bool
}

/// WKUserContentController retains its handlers; this keeps the controller out of that cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var owner: WebViewController?
    init(_ owner: WebViewController) { self.owner = owner }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { owner?.receive(message) }
}

// MARK: - Navigation

extension WebViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        if navigationAction.shouldPerformDownload { return decisionHandler(.download) }
        if navigationAction.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
        switch config.verdict(for: url, userInitiated: navigationAction.navigationType == .linkActivated) {
        case .web: decisionHandler(.allow)
        case .external: UIApplication.shared.open(url); decisionHandler(.cancel)
        case .blocked: decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        errorView?.removeFromSuperview()
        errorView = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.scrollView.refreshControl?.endRefreshing()
        if config.hideKeyboardBar { webView.hideKeyboardAccessoryBar() }
        dismissLaunchCover()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
}

// MARK: - Windows, dialogs, permissions

extension WebViewController: WKUIDelegate {
    /// window.open and target=_blank. There is only ever one webview: internal destinations (and
    /// everything, unless `popups` is `safari`) load in place, which keeps redirect-based sign-in working.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        switch config.verdict(for: url, userInitiated: true) {
        case .web where config.popups == .same || config.isInternal(host: url.host): webView.load(navigationAction.request)
        case .web, .external: openOutside(url)
        case .blocked: break
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: frame.request.url?.host, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        presentPanel(alert, otherwise: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: frame.request.url?.host, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        presentPanel(alert) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: frame.request.url?.host, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in completionHandler(alert?.textFields?.first?.text) })
        presentPanel(alert) { completionHandler(nil) }
    }

    private func presentPanel(_ alert: UIAlertController, otherwise: () -> Void) {
        if presentedViewController == nil, view.window != nil { present(alert, animated: true) } else { otherwise() }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let needsCamera = type == .camera || type == .cameraAndMicrophone
        let needsMicrophone = type == .microphone || type == .cameraAndMicrophone
        // Without the Info.plist usage strings iOS would kill the app, so undeclared capture is denied.
        if (needsCamera && !config.camera) || (needsMicrophone && !config.microphone) { return decisionHandler(.deny) }
        decisionHandler(config.isInternal(host: origin.host) ? .grant : .prompt)
    }
}

// MARK: - Downloads

extension WebViewController: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appendingPathComponent(suggestedFilename.isEmpty ? "download" : suggestedFilename)
        downloads[download] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: download), presentedViewController == nil else { return }
        let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = view
        share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
        present(share, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: download)
    }
}
