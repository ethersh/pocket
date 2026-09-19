# Pocket

Pocket turns any URL into a native iOS app, like [Pake](https://github.com/tw93/Pake) does for
desktop. By default, an iOS web view ignores the system Text Size setting (Dynamic Type). Pocket
apps follow it, so page text resizes when the user changes their text size.

```sh
pocket https://news.ycombinator.com --run
```

This command reads the site for its name, icon, and theme color. It then writes a Swift and  
WKWebView Xcode project to `./HackerNews`, builds it, and launches it in the iOS Simulator. The  
generated app has no third-party dependencies, and an unsigned release build is about 110 KB.

## Install

Pocket requires macOS, Xcode 16 or later, and Node.js 22.18 or later.

```sh
npm install && npm run build && npm link
```



## Features



### Dynamic Type

Pocket maps the iOS Text Size setting onto the curve of the iOS body text style: 0.82× at XS, 1× at
Large (the default), 1.35× at XXXL, and 3.12× at AX5, the largest accessibility size. The per-app
Text Size control in Control Center works too. When the user changes the setting, the app resizes
the open page without a reload, so the user doesn't lose a draft.

Set the mode with `--dynamic-type`:

- `text` (default): Scales text with `text-size-adjust`. Every font size scales, whatever unit the
site uses, and fixed `px` line heights scale with it. Font families, the root font size, `rem`
spacing, and layout breakpoints don't change. Inputs and `contenteditable` regions scale too.
This mode also applies to iframes and to external pages, such as sign-in providers.
- `zoom`: Scales the whole page with `WKWebView.pageZoom`. iPads use this mode automatically,
because WebKit ignores `text-size-adjust` in the iPad desktop-class content mode.
- `off`: Ignores the Text Size setting.

To limit scaling on a site whose layout breaks at large sizes, use `--min-text-scale` and
`--max-text-scale`. Injected CSS can read the current multiplier from `--pocket-text-scale`.

### Edge colors

Pocket samples the colors under the status bar and the home indicator from the live page, and
sets the status bar text to light or dark for contrast. Sampling accepts any CSS color syntax and
composites transparent layers.

Pages that declare `viewport-fit=cover` run edge to edge and get real `env(safe-area-inset-*)`
values. All other pages stay inside the safe area, so a fixed footer doesn't overlap the home
indicator.

### Focus zoom

iOS zooms the page when the user focuses an input whose text is smaller than 16 px. Pocket prevents
this with a viewport guard that runs at document start. The guard adds `maximum-scale=1`, keeps the
site's other viewport settings, and repairs the tag if the page replaces it. The guard also turns
off pinch zoom. To keep both kinds of zoom, pass `--allow-zoom`.

### App behavior

- Cookies persist between launches.
- Swiping navigates back and forward.
- The user agent matches Safari, so sign-in providers don't reject the app.
- Redirect-based OAuth completes inside the app.
- `mailto:` and `tel:` links open in iOS.
- JavaScript `alert`, `confirm`, and `prompt` dialogs work, and so do file uploads.
- Downloads open in a share sheet.
- A thin progress bar shows page loads. If a load fails, a native screen offers a retry.
- The app reloads the page if iOS ends the web content process.
- The launch screen uses the site's theme color.



### Injection

To add your own CSS and JavaScript, pass `--inject app.css --inject app.js`. Pocket applies
injected files only on the app's own hosts.

### Icon

Pocket uses the site's icon from its web app manifest or its `apple-touch-icon`, flattened to an
opaque 1024 px tile. If the site has no usable icon, Pocket draws a monogram.

## Options

For the full list, run `pocket --help`. Common options:


| Flag                                                                   | Default                             | Description                                                                                               |
| ---------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--name`, `--icon`, `--bundle-id`, `--theme-color`                     | From the site                       | App identity                                                                                              |
| `--dynamic-type text\|zoom\|off`                                         | `text`                              | How the app applies Text Size                                                                             |
| `--edges auto\|inset\|full`                                              | `auto`                              | `auto` follows `viewport-fit=cover`. `full` forces edge to edge on internal hosts.                        |
| `--popups same\|safari`                                                 | `same`                              | Where `window.open` and `_blank` links to other sites open                                                |
| `--internal-hosts a.com,b.com`                                         | The start host and its subdomains   | Hosts that get your injections                                                                            |
| `--pull-to-refresh`, `--hide-keyboard-bar`, `--camera`, `--microphone` | Off                                 | Optional behaviors                                                                                        |
| `--run`, `--device`, `--ipa`, `--open`                                 | None                                | Run in the Simulator, install on your iPhone, build an unsigned `.ipa` file, or open the project in Xcode |
| `--team ABCDE12345`                                                    | The team that Xcode is signed in to | Signing team for device builds                                                                            |


`http://` URLs also work. For these apps, Pocket relaxes App Transport Security for web content
only. For example, to try a local dev server as an app, run
`pocket http://192.168.1.20:3000 --run`.

## Install on an iPhone

```sh
pocket https://news.ycombinator.com --device
```

This command builds, signs, installs, and opens the app on your iPhone, over a cable or the same
Wi-Fi network.

Before you run it for the first time, complete this setup. Apple requires every step.

1. In Xcode, select **Settings > Accounts** and add your Apple ID. A free Apple ID works.
2. Connect the iPhone, unlock it, and tap **Trust**.
3. On the iPhone, go to **Settings > Privacy & Security > Developer Mode** and turn it on. The
  iPhone restarts once.

After the first install with a free Apple ID, go to **Settings > General > VPN & Device
Management** on the iPhone, select your Apple ID, and tap **Trust**.

Pocket finds the signing team from Xcode and finds the connected iPhone. If Xcode has several
teams, or several devices are connected, choose one with `--team` or `--device-name`. Pocket
remembers the team for each project. If a setup step is missing, Pocket tells you which one.

Signed builds get a bundle ID that includes the team, such as `app.pocket.hacker-news.<team>`,
because all Apple bundle IDs share one global namespace.

With a free Apple ID, the app stops opening after 7 days, and you can install up to 3 apps at a
time. To renew the app, run the same command again. Your login inside the app is kept. With a paid
developer account, the app lasts a year.

Alternatives:

- `--open` opens the project in Xcode so that you can sign and run it yourself.
- `--ipa` builds an unsigned `.ipa` file that tools such as AltStore and Sideloadly can sign.



## Edit the generated project

The output is a regular Xcode project that you can edit. Behavior settings are in
`App/pocket.json`, and injections are in `App/user.css` and `App/user.js`.

If you run `pocket` again with the same `--out` directory, Pocket regenerates the files it owns and
leaves everything else alone. Pocket doesn't write into a folder that it didn't create unless you
pass `--force`.

## How it works


| Path                       | Contents                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/`                     | The CLI: options, site metadata, the project renderer, and the `xcodebuild`, `simctl`, and `devicectl` wrappers |
| `template/App/`            | The Swift app: UIKit and one `WKWebView`, about 450 lines                                                       |
| `template/bridge.js`       | The page bridge: Dynamic Type, the viewport guard, and edge colors                                              |
| `template/project.pbxproj` | A hand-written Xcode project. It uses a file-system-synchronized group, so it needs no per-file entries.        |
| `tools/icon.swift`         | Icon flattening and the monogram, run with the Xcode toolchain                                                  |


The bridge runs at document start inside an isolated `WKContentWorld`, so page scripts can't see it
or reach the native message handler. The bridge doesn't read page text, form values, or cookies. It
sends only two validated hex colors and a Boolean to native code, and only from the top frame.

Navigation is limited to `https`, plus `http` if you wrapped an `http` URL. Pocket drops top-level  
navigations to `javascript:`, `file:`, and `data:` URLs, and opens unknown app schemes only when  
the user taps a link.

