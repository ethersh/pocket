import UIKit
import WebKit

/// Native failure screen. Uses text styles so it follows Dynamic Type like the page does.
final class ErrorView: UIView {
    private let retry: () -> Void

    init(message: String, retry: @escaping () -> Void) {
        self.retry = retry
        super.init(frame: .zero)

        let title = UILabel()
        title.text = "Couldn’t load the page"
        title.font = .preferredFont(forTextStyle: .title2)
        let detail = UILabel()
        detail.text = message
        detail.font = .preferredFont(forTextStyle: .body)
        detail.textColor = .secondaryLabel
        for label in [title, detail] {
            label.adjustsFontForContentSizeCategory = true
            label.numberOfLines = 0
            label.textAlignment = .center
        }

        var configuration = UIButton.Configuration.filled()
        configuration.title = "Try again"
        configuration.buttonSize = .large
        let button = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in self?.retry() })

        let stack = UIStackView(arrangedSubviews: [title, detail, button])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 16
        stack.setCustomSpacing(28, after: detail)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor, constant: -16),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

extension WKWebView {
    /// Removes the ‹ › Done bar above the keyboard. WebKit has no public switch for it, so the
    /// content view is re-classed to a subclass whose inputAccessoryView is nil. Opt-in only.
    func hideKeyboardAccessoryBar() {
        guard let content = scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }),
              let current = object_getClass(content) else { return }
        let name = "\(current)_PocketNoAccessory"
        if String(describing: current).hasSuffix("_PocketNoAccessory") { return }
        if let existing = NSClassFromString(name) { object_setClass(content, existing); return }
        guard let subclass = objc_allocateClassPair(current, name, 0),
              let method = class_getInstanceMethod(NoAccessoryView.self, #selector(getter: NoAccessoryView.inputAccessoryView)) else { return }
        class_addMethod(subclass, #selector(getter: UIResponder.inputAccessoryView), method_getImplementation(method), method_getTypeEncoding(method))
        objc_registerClassPair(subclass)
        object_setClass(content, subclass)
    }
}

private final class NoAccessoryView: NSObject {
    @objc var inputAccessoryView: UIView? { nil }
}
