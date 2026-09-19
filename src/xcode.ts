import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { download } from './site.ts';
import { ROOT, type Plan } from './render.ts';

interface Result { code: number; stdout: string; stderr: string }

function run(command: string, args: string[], cwd?: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function must(command: string, args: string[], cwd?: string): Promise<string> {
  const result = await run(command, args, cwd);
  if (result.code !== 0) throw new Error(`${command} ${args.slice(0, 3).join(' ')}… failed:\n${(result.stderr || result.stdout).trim().split('\n').slice(-25).join('\n')}`);
  return result.stdout;
}

export async function assertXcode(): Promise<void> {
  const result = await run('xcrun', ['--find', 'xcodebuild']).catch(() => ({ code: 1 }) as Result);
  if (result.code !== 0) throw new Error('Xcode is required. Install it from the App Store, then run `sudo xcode-select -s /Applications/Xcode.app`.');
}

/**
 * Tries each candidate (a local path or URL) until one decodes, then falls back to a monogram.
 * Returns the PNG and a description of where it came from.
 */
export async function makeIcon(candidates: string[], letter: string, themeColor: string | undefined): Promise<{ png: Buffer; source: string }> {
  const work = await mkdtemp(path.join(os.tmpdir(), 'pocket-icon-'));
  const script = path.join(ROOT, 'tools', 'icon.swift');
  const output = path.join(work, 'icon.png');
  try {
    for (const [index, candidate] of candidates.entries()) {
      let source = candidate;
      if (/^https?:\/\//i.test(candidate)) {
        source = path.join(work, `source-${index}`);
        try { await writeFile(source, await download(candidate)); } catch { continue; }
      } else if (!existsSync(candidate)) continue;
      const result = await run('xcrun', ['swift', script, output, letter, '-', source]);
      if (result.code === 0) return { png: await readFile(output), source: candidate };
    }
    await must('xcrun', ['swift', script, output, letter, themeColor ?? '-']);
    return { png: await readFile(output), source: 'monogram' };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function xcodebuild(plan: Plan, extra: string[]): Promise<string> {
  return must('xcrun', ['xcodebuild', '-project', `${plan.target}.xcodeproj`, '-scheme', plan.target, '-derivedDataPath', 'build', '-quiet', ...extra], plan.outDir);
}

interface Simulator { udid: string; name: string; state: string; runtime: string }

async function simulators(): Promise<Simulator[]> {
  const listing = JSON.parse(await must('xcrun', ['simctl', 'list', 'devices', 'available', '--json'])) as { devices: Record<string, Omit<Simulator, 'runtime'>[]> };
  return Object.entries(listing.devices)
    .filter(([runtime]) => runtime.includes('iOS'))
    .flatMap(([runtime, devices]) => devices.map((device) => ({ ...device, runtime })));
}

export async function pickSimulator(requested: string | undefined): Promise<Simulator> {
  const all = await simulators();
  if (requested) {
    const match = all.find((device) => device.udid === requested) ?? all.filter((device) => device.name.toLowerCase() === requested.toLowerCase()).sort((a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true }))[0];
    if (!match) throw new Error(`No simulator called "${requested}". Available: ${[...new Set(all.map((device) => device.name))].join(', ')}`);
    return match;
  }
  const booted = all.find((device) => device.state === 'Booted');
  if (booted) return booted;
  const iphones = all.filter((device) => device.name.startsWith('iPhone')).sort((a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true }));
  if (!iphones[0]) throw new Error('No iOS simulators are installed. Add one in Xcode → Settings → Components.');
  return iphones[0];
}

export async function runInSimulator(plan: Plan, requested: string | undefined, log: (line: string) => void): Promise<void> {
  const device = await pickSimulator(requested);
  log(`Building for ${device.name}…`);
  await xcodebuild(plan, ['-configuration', 'Debug', '-destination', `platform=iOS Simulator,id=${device.udid}`, 'build']);
  const app = path.join(plan.outDir, 'build/Build/Products/Debug-iphonesimulator', `${plan.target}.app`);
  if (device.state !== 'Booted') await must('xcrun', ['simctl', 'boot', device.udid]);
  await run('open', ['-a', 'Simulator']);
  await must('xcrun', ['simctl', 'install', device.udid, app]);
  await must('xcrun', ['simctl', 'launch', device.udid, plan.bundleId]);
  log(`Running on ${device.name}. Try Dynamic Type: xcrun simctl ui ${device.udid} content_size extra-extra-extra-large`);
}

/** An unsigned device build zipped as Payload/<App>.app, the input sideloading tools re-sign. */
export async function buildIpa(plan: Plan, log: (line: string) => void): Promise<string> {
  log('Building for iOS devices (unsigned)…');
  await xcodebuild(plan, ['-configuration', 'Release', '-destination', 'generic/platform=iOS', 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=', 'build']);
  const app = path.join(plan.outDir, 'build/Build/Products/Release-iphoneos', `${plan.target}.app`);
  const staging = await mkdtemp(path.join(os.tmpdir(), 'pocket-ipa-'));
  const ipa = path.join(plan.outDir, `${plan.target}.ipa`);
  try {
    await mkdir(path.join(staging, 'Payload'));
    await must('ditto', [app, path.join(staging, 'Payload', `${plan.target}.app`)]);
    await rm(ipa, { force: true });
    await must('ditto', ['-c', '-k', '--norsrc', '--keepParent', path.join(staging, 'Payload'), ipa]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return ipa;
}

export async function openInXcode(plan: Plan): Promise<void> {
  await must('open', [path.join(plan.outDir, `${plan.target}.xcodeproj`)]);
}

// MARK: Physical devices

export interface Team { id: string; name: string; free: boolean }

/** Pulls teams out of Xcode's IDEProvisioningTeams preference: { "<apple id>": [{ teamID, teamName, isFreeProvisioningTeam }] }. */
export function parseTeams(preference: unknown): Team[] {
  const teams = new Map<string, Team>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const entry = value as Record<string, unknown>;
    if (typeof entry.teamID === 'string' && /^[A-Z0-9]{10}$/.test(entry.teamID)) {
      const free = entry.isFreeProvisioningTeam === true || entry.isFreeProvisioningTeam === 1 || entry.teamType === 'Personal Team';
      teams.set(entry.teamID, { id: entry.teamID, name: typeof entry.teamName === 'string' ? entry.teamName : entry.teamID, free });
    } else Object.values(entry).forEach(visit);
  };
  visit(preference);
  return [...teams.values()];
}

/** The signing teams of the Apple IDs added in Xcode → Settings → Accounts. */
export async function xcodeTeams(): Promise<Team[]> {
  const work = await mkdtemp(path.join(os.tmpdir(), 'pocket-teams-'));
  try {
    const plist = path.join(work, 'xcode.plist');
    if ((await run('defaults', ['export', 'com.apple.dt.Xcode', plist])).code !== 0) return [];
    const extracted = await run('plutil', ['-extract', 'IDEProvisioningTeams', 'json', '-o', '-', plist]);
    return extracted.code === 0 ? parseTeams(JSON.parse(extracted.stdout)) : [];
  } catch { return []; } finally { await rm(work, { recursive: true, force: true }); }
}

const SIGN_IN = 'Add your Apple ID in Xcode → Settings → Accounts (a free one works), then run this again.';

export async function resolveTeam(explicit: string, remembered: string): Promise<Team> {
  if (explicit) return { id: explicit, name: explicit, free: false };
  const teams = await xcodeTeams();
  const match = teams.find((team) => team.id === remembered);
  if (match) return match;
  if (remembered) return { id: remembered, name: remembered, free: false };
  if (teams.length === 1) return teams[0]!;
  if (!teams.length) throw new Error(`Installing on a phone needs a signing team, and Xcode isn't signed into an Apple ID.\n${SIGN_IN}`);
  throw new Error(`Xcode knows several teams; pick one with --team:\n${teams.map((team) => `  ${team.id}  ${team.name}${team.free ? ' (free)' : ''}`).join('\n')}`);
}

export interface Device { identifier: string; udid: string; name: string; model: string; available: boolean; developerMode: boolean }

interface RawDevice {
  identifier?: string;
  hardwareProperties?: { udid?: string; platform?: string; marketingName?: string; deviceType?: string; reality?: string };
  deviceProperties?: { name?: string; developerModeStatus?: string };
  connectionProperties?: { pairingState?: string; tunnelState?: string };
}

/** Paired, physical iOS/iPadOS devices from `devicectl list devices`, reachable ones first. */
export function parseDevices(listing: unknown): Device[] {
  const raw = (listing as { result?: { devices?: RawDevice[] } })?.result?.devices ?? [];
  return raw
    .filter((device) => device.hardwareProperties?.platform === 'iOS' && device.hardwareProperties?.reality !== 'virtual' && device.connectionProperties?.pairingState === 'paired')
    .filter((device) => device.identifier && device.hardwareProperties?.udid)
    .map((device) => ({
      identifier: device.identifier!,
      udid: device.hardwareProperties!.udid!,
      name: device.deviceProperties?.name ?? 'iPhone',
      model: device.hardwareProperties?.marketingName ?? device.hardwareProperties?.deviceType ?? 'iOS device',
      available: device.connectionProperties?.tunnelState !== 'unavailable',
      developerMode: device.deviceProperties?.developerModeStatus === 'enabled',
    }))
    .sort((a, b) => Number(b.available) - Number(a.available));
}

const CONNECT = 'Plug the iPhone in (or put it on the same Wi-Fi), unlock it and tap Trust if asked.';
const DEVELOPER_MODE = 'turn on Settings → Privacy & Security → Developer Mode on the phone (it restarts once), then run this again. The switch appears after the phone has been connected to this Mac with Xcode open';

export function chooseDevice(devices: Device[], requested: string | undefined): Device {
  const wanted = requested?.toLowerCase();
  const pool = wanted ? devices.filter((device) => device.name.toLowerCase() === wanted || device.udid.toLowerCase() === wanted || device.identifier.toLowerCase() === wanted) : devices;
  if (wanted && !pool.length) throw new Error(`No paired device called "${requested}".${devices.length ? ` Known: ${devices.map((device) => device.name).join(', ')}.` : ''} ${CONNECT}`);
  if (!pool.length) throw new Error(`No iPhone found. ${CONNECT}`);
  const reachable = pool.filter((device) => device.available);
  if (!reachable.length) throw new Error(`${pool[0]!.name} is paired but not reachable right now. ${CONNECT}`);
  if (reachable.length > 1) throw new Error(`Several devices are connected; choose one with --device-name:\n${reachable.map((device) => `  ${device.name}  (${device.model})`).join('\n')}`);
  const device = reachable[0]!;
  if (!device.developerMode) throw new Error(`${device.name} has Developer Mode off, so iOS won't run apps installed from a Mac. To fix it, ${DEVELOPER_MODE}.`);
  return device;
}

/** Finds the iPhone to install on, or explains what's missing. */
export async function findDevice(requested: string | undefined): Promise<Device> {
  return chooseDevice(await connectedDevices(), requested);
}

async function connectedDevices(): Promise<Device[]> {
  const work = await mkdtemp(path.join(os.tmpdir(), 'pocket-devices-'));
  try {
    const file = path.join(work, 'devices.json');
    await must('xcrun', ['devicectl', 'list', 'devices', '--json-output', file, '--timeout', '15']);
    return parseDevices(JSON.parse(await readFile(file, 'utf8')));
  } finally { await rm(work, { recursive: true, force: true }); }
}

/** Apple's tools explain these in a paragraph of jargon; say what to actually do. */
export function signingHint(output: string): string | undefined {
  const hints: [RegExp, string][] = [
    [/No Accounts?\b|No Account for Team|Unable to log in|no account with/i, SIGN_IN],
    [/maximum number of (installed )?apps|maximum number of App IDs/i, 'Free Apple IDs are limited to 3 installed apps and 10 new app ids per week. Delete one of the apps you installed this way from the phone, or wait, or use a paid developer account.'],
    [/Failed to register bundle identifier|cannot be registered to your development team|bundle identifier .* is not available/i, 'That bundle id belongs to someone else at Apple. Pass a different --bundle-id.'],
    [/Developer Mode/i, `Developer Mode is off: ${DEVELOPER_MODE}.`],
    [/device is locked|passcode protected|unlock/i, 'Unlock the phone and run this again.'],
    [/not been explicitly trusted|invalid code signature, inadequate entitlements or its profile has not been/i, 'The app is installed. To open it, trust yourself once on the phone: Settings → General → VPN & Device Management → your Apple ID → Trust.'],
    [/No profiles for|requires a provisioning profile|Provisioning profile .* doesn't include/i, 'Xcode could not create a provisioning profile. Make sure the phone is unlocked and connected, and that the team is right (--team).'],
    [/Timed out|CoreDeviceError|connection (was )?(interrupted|invalid)|tunnel/i, `Lost the connection to the phone. ${CONNECT}`],
  ];
  return hints.find(([pattern]) => pattern.test(output))?.[1];
}

async function withHint<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    const message = (error as Error).message;
    const hint = signingHint(message);
    throw hint ? new Error(`${hint}\n\n${message}`) : error;
  }
}

export async function runOnDevice(plan: Plan, team: Team, device: Device, log: (line: string) => void): Promise<void> {
  log(`Building and signing for ${device.name} (${device.model}) as ${team.name}…`);
  await withHint(() => xcodebuild(plan, ['-configuration', 'Release', '-destination', `platform=iOS,id=${device.udid}`, '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', `DEVELOPMENT_TEAM=${team.id}`, 'build']));
  const app = path.join(plan.outDir, 'build/Build/Products/Release-iphoneos', `${plan.target}.app`);
  log('Installing…');
  await withHint(() => must('xcrun', ['devicectl', 'device', 'install', 'app', '--device', device.identifier, app]));
  const launch = await run('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device.identifier, plan.bundleId]);
  if (launch.code === 0) log(`${plan.displayName} is open on ${device.name}.`);
  else log(`${plan.displayName} is installed on ${device.name}, but iOS wouldn't open it yet.\n${signingHint(launch.stderr + launch.stdout) ?? 'Unlock the phone and tap the icon.'}`);
  if (team.free) log('Signed with a free Apple ID: the app stops opening after 7 days. Re-run the same command to renew it (your login inside the app is kept).');
}
