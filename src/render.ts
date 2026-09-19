import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Options } from './options.ts';
import { UsageError } from './options.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'template');
const MARKER = 'pocket.config.json';

/** Everything derived from the options plus what the site told us. */
export interface Plan {
  displayName: string;
  target: string;
  bundleId: string;
  outDir: string;
  themeColor?: string;
  internalHosts: string[];
  userCSS: string;
  userJS: string;
}

/** Xcode target / scheme / file name: letters and digits only, never starting with a digit. */
export function targetName(displayName: string): string {
  const words = displayName.normalize('NFKD').replace(/\p{M}/gu, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  return !joined ? 'PocketApp' : /^\d/.test(joined) ? `App${joined}` : joined;
}

/**
 * Bundle identifiers are one global namespace at Apple, and a free team can't register an id
 * another team already holds, so signed builds get the team appended.
 */
export function defaultBundleId(displayName: string, team = ''): string {
  const slug = displayName.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `app.pocket.${slug || 'app'}${team ? `.${team.toLowerCase()}` : ''}`;
}

/** The team a previous run signed this project with, so later runs don't need --team again. */
export async function rememberedTeam(outDir: string): Promise<string> {
  try {
    const marker = JSON.parse(await readFile(path.join(outDir, MARKER), 'utf8')) as { team?: unknown };
    return typeof marker.team === 'string' && /^[A-Z0-9]{10}$/.test(marker.team) ? marker.team : '';
  } catch { return ''; }
}

/** The start host without `www.` (so both spellings match), plus anything passed explicitly. */
export function internalHosts(url: URL, extra: string[]): string[] {
  return [...new Set([url.hostname.toLowerCase().replace(/^www\./, ''), ...extra])];
}

export async function readInjections(files: string[]): Promise<{ userCSS: string; userJS: string }> {
  const css: string[] = [];
  const js: string[] = [];
  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    if (extension !== '.css' && extension !== '.js') throw new UsageError(`--inject takes .css or .js files (got ${file})`);
    let text: string;
    try { text = await readFile(file, 'utf8'); } catch { throw new UsageError(`Can't read injection file ${file}`); }
    (extension === '.css' ? css : js).push(`/* ${path.basename(file)} */\n${text.trim()}\n`);
  }
  return { userCSS: css.join('\n'), userJS: js.join('\n') };
}

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ORIENTATIONS = {
  all: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  portrait: ['UIInterfaceOrientationPortrait'],
  landscape: ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
} as const;

export function renderInfoPlist(template: string, options: Options, plan: Plan): string {
  const orientations = ORIENTATIONS[options.orientation];
  // iPad multitasking requires all four orientations unless the app opts out of it.
  const ipad = options.orientation === 'all' ? [...orientations, 'UIInterfaceOrientationPortraitUpsideDown'] : orientations;
  const list = (values: readonly string[]) => values.map((value) => `\t\t<string>${value}</string>`).join('\n');
  const extra: string[] = [];
  if (options.orientation !== 'all') extra.push('\t<key>UIRequiresFullScreen</key>\n\t<true/>');
  if (options.url.protocol === 'http:') {
    extra.push('\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsArbitraryLoadsInWebContent</key>\n\t\t<true/>\n\t\t<key>NSAllowsLocalNetworking</key>\n\t\t<true/>\n\t</dict>');
  }
  if (options.camera) extra.push(`\t<key>NSCameraUsageDescription</key>\n\t<string>${xml(plan.displayName)} uses the camera when the site asks for it.</string>`);
  if (options.microphone) extra.push(`\t<key>NSMicrophoneUsageDescription</key>\n\t<string>${xml(plan.displayName)} uses the microphone when the site asks for it.</string>`);
  return template
    .replace('__DISPLAY_NAME__', xml(plan.displayName))
    .replace('__LAUNCH_SCREEN__', plan.themeColor ? '\t\t<key>UIColorName</key>\n\t\t<string>LaunchBackground</string>' : '')
    .replace('__ORIENTATIONS__', list(orientations))
    .replace('__ORIENTATIONS_IPAD__', list(ipad))
    .replace('__EXTRA_KEYS__', extra.join('\n'))
    .replace(/\n{2,}/g, '\n');
}

export function renderProject(template: string, options: Options, plan: Plan): string {
  const values: Record<string, string> = {
    __TARGET__: plan.target, __BUNDLE_ID__: plan.bundleId, __TEAM__: options.team, __VERSION__: options.version,
    __BUILD__: options.build, __MIN_IOS__: options.minIos, __DEVICE_FAMILY__: options.iphoneOnly ? '1' : '1,2',
  };
  return template.replace(/__[A-Z_]+__/g, (token) => values[token] ?? token);
}

export function renderConfig(options: Options, plan: Plan): string {
  return JSON.stringify({
    url: options.url.href,
    internalHosts: plan.internalHosts,
    dynamicType: options.dynamicType,
    minTextScale: options.minTextScale,
    maxTextScale: options.maxTextScale,
    edges: options.edges,
    popups: options.popups,
    lockZoom: options.lockZoom,
    pullToRefresh: options.pullToRefresh,
    hideKeyboardBar: options.hideKeyboardBar,
    camera: options.camera,
    microphone: options.microphone,
    allowInsecure: options.url.protocol === 'http:',
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    ...(plan.themeColor ? { themeColor: plan.themeColor } : {}),
  }, null, 2) + '\n';
}

function colorSet(hex: string): string {
  const channel = (offset: number) => `0x${hex.slice(offset, offset + 2).toUpperCase()}`;
  return JSON.stringify({
    colors: [{ idiom: 'universal', color: { 'color-space': 'srgb', components: { red: channel(1), green: channel(3), blue: channel(5), alpha: '1.000' } } }],
    info: { author: 'xcode', version: 1 },
  }, null, 2) + '\n';
}

/** Refuses to write into a directory that has content Pocket didn't put there. */
export async function assertWritable(outDir: string, force: boolean): Promise<void> {
  if (!existsSync(outDir)) return;
  if (!(await stat(outDir)).isDirectory()) throw new UsageError(`${outDir} exists and is not a directory`);
  const entries = (await readdir(outDir)).filter((entry) => entry !== '.DS_Store');
  if (entries.length && !entries.includes(MARKER) && !force) {
    throw new UsageError(`${outDir} already has files that Pocket didn't create. Choose another --out, or pass --force to write into it.`);
  }
}

/** Writes the Xcode project. Only files Pocket owns are replaced; nothing else in outDir is touched. */
export async function writeProject(options: Options, plan: Plan, iconPng: Buffer): Promise<void> {
  const app = path.join(plan.outDir, 'App');
  const assets = path.join(app, 'Assets.xcassets');
  await assertWritable(plan.outDir, options.force);
  await mkdir(path.join(plan.outDir, `${plan.target}.xcodeproj`), { recursive: true });
  await cp(path.join(TEMPLATE, 'App'), app, { recursive: true, force: true });
  await mkdir(path.join(assets, 'AppIcon.appiconset'), { recursive: true });

  const write = (relative: string, content: string | Buffer) => writeFile(path.join(plan.outDir, relative), content);
  await write(`${plan.target}.xcodeproj/project.pbxproj`, renderProject(await readFile(path.join(TEMPLATE, 'project.pbxproj'), 'utf8'), options, plan));
  await write('Info.plist', renderInfoPlist(await readFile(path.join(TEMPLATE, 'Info.plist'), 'utf8'), options, plan));
  await write('App/pocket.json', renderConfig(options, plan));
  await write('App/bridge.js', await readFile(path.join(TEMPLATE, 'bridge.js')));
  await write('App/user.css', plan.userCSS || '/* CSS injected on internal hosts. --pocket-text-scale and --pocket-safe-{top,bottom,left,right} are available. */\n');
  await write('App/user.js', plan.userJS);
  await write('App/Assets.xcassets/Contents.json', JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2) + '\n');
  await write('App/Assets.xcassets/AppIcon.appiconset/icon.png', iconPng);
  await write('App/Assets.xcassets/AppIcon.appiconset/Contents.json', JSON.stringify({
    images: [{ filename: 'icon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
    info: { author: 'xcode', version: 1 },
  }, null, 2) + '\n');
  const launch = path.join(assets, 'LaunchBackground.colorset');
  if (plan.themeColor) {
    await mkdir(launch, { recursive: true });
    await writeFile(path.join(launch, 'Contents.json'), colorSet(plan.themeColor));
  } else {
    await rm(launch, { recursive: true, force: true });
  }
  await write('.gitignore', 'build/\n*.ipa\nxcuserdata/\n.DS_Store\n');
  await write(MARKER, JSON.stringify({ generator: 'pocket', url: options.url.href, name: plan.displayName, bundleId: plan.bundleId, target: plan.target, ...(options.team ? { team: options.team } : {}) }, null, 2) + '\n');
}
