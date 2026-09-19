import { parseArgs } from 'node:util';

export type DynamicTypeMode = 'text' | 'zoom' | 'off';
export type Edges = 'auto' | 'inset' | 'full';
export type Popups = 'same' | 'safari';
export type Orientation = 'all' | 'portrait' | 'landscape';

export interface Options {
  url: URL;
  name?: string;
  bundleId?: string;
  icon?: string;
  out?: string;
  themeColor?: string;
  dynamicType: DynamicTypeMode;
  minTextScale: number;
  maxTextScale: number;
  edges: Edges;
  popups: Popups;
  orientation: Orientation;
  internalHosts: string[];
  inject: string[];
  userAgent?: string;
  lockZoom: boolean;
  pullToRefresh: boolean;
  hideKeyboardBar: boolean;
  camera: boolean;
  microphone: boolean;
  iphoneOnly: boolean;
  team: string;
  version: string;
  build: string;
  minIos: string;
  force: boolean;
  offline: boolean;
  run: boolean;
  simulator?: string;
  device: boolean;
  deviceName?: string;
  ipa: boolean;
  open: boolean;
}

export const HELP = `pocket — turn any URL into a native iOS app that respects Dynamic Type

Usage
  pocket <url> [options]

App
  --name <name>              App name under the icon (default: from the site)
  --bundle-id <id>           Bundle identifier (default: app.pocket.<name>)
  --icon <file|url>          PNG/JPEG/ICO icon (default: the site's own, else a monogram)
  --theme-color <#rrggbb>    Launch + initial edge colour (default: from the site)
  --out <dir>                Where to write the Xcode project (default: ./<Name>)
  --version <x.y.z>          Marketing version (default: 1.0.0)
  --build <n>                Build number (default: 1)
  --team <id>                Apple development team (default: the one Xcode is signed into)
  --min-ios <version>        Deployment target (default: 16.0)
  --iphone-only              Skip iPad support
  --orientation <mode>       all | portrait | landscape (default: all)

Dynamic Type
  --dynamic-type <mode>      text: scale text only (default) · zoom: scale the page · off
  --min-text-scale <n>       Lower clamp for the multiplier (default: 0.8)
  --max-text-scale <n>       Upper clamp; AX5 is 3.12 (default: 3.2, i.e. unclamped)

Behaviour
  --edges <mode>             auto: edge-to-edge when the page declares viewport-fit=cover
                             (default) · inset: always inside the safe area · full: always
  --popups <mode>            same: window.open/_blank load in place (default) · safari:
                             external hosts open in an in-app Safari sheet
  --internal-hosts <a,b>     Extra hosts treated as part of the app (subdomains included)
  --inject <file>            .css or .js injected on internal hosts; repeatable
  --user-agent <ua>          Override the Safari-like default
  --allow-zoom               Keep pinch zoom (and iOS's focus zoom on small inputs)
  --pull-to-refresh          Pull down to reload
  --hide-keyboard-bar        Remove the ‹ › Done bar above the keyboard
  --camera, --microphone     Declare capture permissions for getUserMedia

Build
  --run                      Build, install and launch in the iOS Simulator
  --simulator <name>         Simulator to use with --run (default: booted, else newest iPhone)
  --device                   Build, sign and install on a connected iPhone (cable or Wi-Fi)
  --device-name <name>       Which iPhone, when several are connected (name or UDID)
  --ipa                      Build an unsigned .ipa (sign it with your sideloading tool)
  --open                     Open the project in Xcode
  --offline                  Don't fetch the site for its name, icon and colour
  --force                    Write into a non-empty directory Pocket didn't create
  -h, --help
`;

export class UsageError extends Error {}

function oneOf<T extends string>(flag: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`--${flag} must be one of ${allowed.join(', ')} (got "${value}")`);
  return value as T;
}

function scale(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0.5 || number > 4) throw new UsageError(`--${flag} must be a number between 0.5 and 4`);
  return number;
}

export function parseUrl(input: string): URL {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try { url = new URL(candidate); } catch { throw new UsageError(`"${input}" is not a valid URL`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError('Only http and https URLs can be wrapped');
  if (!url.hostname) throw new UsageError(`"${input}" has no host`);
  return url;
}

export function parseOptions(argv: string[]): Options | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        name: { type: 'string' }, 'bundle-id': { type: 'string' }, icon: { type: 'string' }, out: { type: 'string' },
        'theme-color': { type: 'string' }, 'dynamic-type': { type: 'string' }, 'min-text-scale': { type: 'string' },
        'max-text-scale': { type: 'string' }, edges: { type: 'string' }, popups: { type: 'string' }, orientation: { type: 'string' },
        'internal-hosts': { type: 'string' }, inject: { type: 'string', multiple: true }, 'user-agent': { type: 'string' },
        'allow-zoom': { type: 'boolean' }, 'pull-to-refresh': { type: 'boolean' }, 'hide-keyboard-bar': { type: 'boolean' },
        camera: { type: 'boolean' }, microphone: { type: 'boolean' }, 'iphone-only': { type: 'boolean' }, team: { type: 'string' },
        version: { type: 'string' }, build: { type: 'string' }, 'min-ios': { type: 'string' }, force: { type: 'boolean' },
        offline: { type: 'boolean' }, run: { type: 'boolean' }, simulator: { type: 'string' }, device: { type: 'boolean' },
        'device-name': { type: 'string' }, ipa: { type: 'boolean' },
        open: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) { throw new UsageError((error as Error).message); }
  const { values, positionals } = parsed;
  if (values.help) return 'help';
  if (positionals.length !== 1) throw new UsageError(positionals.length ? 'Pass exactly one URL' : 'Pass the URL to wrap, e.g. pocket https://news.ycombinator.com');

  const themeColor = values['theme-color'];
  if (themeColor !== undefined && !/^#[0-9a-f]{6}$/i.test(themeColor)) throw new UsageError('--theme-color must look like #1a2b3c');
  if (values['bundle-id'] !== undefined && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(values['bundle-id'])) throw new UsageError('--bundle-id must look like com.example.app');
  if (values.team !== undefined && !/^[A-Z0-9]{10}$/.test(values.team)) throw new UsageError('--team must be a 10-character Apple team ID');
  for (const flag of ['version', 'min-ios'] as const) {
    if (values[flag] !== undefined && !/^\d+(\.\d+){0,2}$/.test(values[flag])) throw new UsageError(`--${flag} must look like 1.0.0`);
  }
  if (values.build !== undefined && !/^\d+(\.\d+){0,2}$/.test(values.build)) throw new UsageError('--build must be a number');
  const minTextScale = scale('min-text-scale', values['min-text-scale'], 0.8);
  const maxTextScale = scale('max-text-scale', values['max-text-scale'], 3.2);
  if (minTextScale > maxTextScale) throw new UsageError('--min-text-scale cannot exceed --max-text-scale');

  return {
    url: parseUrl(positionals[0]!),
    name: values.name?.trim() || undefined,
    bundleId: values['bundle-id'],
    icon: values.icon,
    out: values.out,
    themeColor: themeColor?.toLowerCase(),
    dynamicType: oneOf('dynamic-type', values['dynamic-type'], ['text', 'zoom', 'off'], 'text'),
    minTextScale,
    maxTextScale,
    edges: oneOf('edges', values.edges, ['auto', 'inset', 'full'], 'auto'),
    popups: oneOf('popups', values.popups, ['same', 'safari'], 'same'),
    orientation: oneOf('orientation', values.orientation, ['all', 'portrait', 'landscape'], 'all'),
    internalHosts: (values['internal-hosts'] ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
    inject: values.inject ?? [],
    userAgent: values['user-agent'],
    lockZoom: !values['allow-zoom'],
    pullToRefresh: !!values['pull-to-refresh'],
    hideKeyboardBar: !!values['hide-keyboard-bar'],
    camera: !!values.camera,
    microphone: !!values.microphone,
    iphoneOnly: !!values['iphone-only'],
    team: values.team ?? '',
    version: values.version ?? '1.0.0',
    build: values.build ?? '1',
    minIos: values['min-ios'] ?? '16.0',
    force: !!values.force,
    offline: !!values.offline,
    run: !!values.run,
    simulator: values.simulator,
    device: !!values.device || values['device-name'] !== undefined,
    deviceName: values['device-name'],
    ipa: !!values.ipa,
    open: !!values.open,
  };
}
