import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseOptions, type Options } from '../src/options.ts';
import { defaultBundleId, rememberedTeam } from '../src/render.ts';
import { chooseDevice, parseDevices, parseTeams, signingHint } from '../src/xcode.ts';

const raw = (name: string, overrides: { tunnel?: string; pairing?: string; developerMode?: string; platform?: string; reality?: string } = {}) => ({
  identifier: `ID-${name}`,
  hardwareProperties: { udid: `UDID-${name}`, platform: overrides.platform ?? 'iOS', marketingName: 'iPhone 17 Pro', reality: overrides.reality ?? 'physical' },
  deviceProperties: { name, developerModeStatus: overrides.developerMode ?? 'enabled' },
  connectionProperties: { pairingState: overrides.pairing ?? 'paired', tunnelState: overrides.tunnel ?? 'connected' },
});
const listing = (...devices: unknown[]) => ({ result: { devices } });

test('--device and --device-name both ask for a phone install', () => {
  assert.equal((parseOptions(['a.com', '--device']) as Options).device, true);
  assert.deepEqual([(parseOptions(['a.com', '--device-name', 'Pocket Phone']) as Options).device, (parseOptions(['a.com', '--device-name', 'Pocket Phone']) as Options).deviceName], [true, 'Pocket Phone']);
  assert.equal((parseOptions(['a.com']) as Options).device, false);
});

test('signed builds get a team-scoped bundle id, and the team is remembered per project', async () => {
  assert.equal(defaultBundleId('Hacker News'), 'app.pocket.hacker-news');
  assert.equal(defaultBundleId('Hacker News', 'ABCDE12345'), 'app.pocket.hacker-news.abcde12345');
  const work = await mkdtemp(path.join(os.tmpdir(), 'pocket-team-'));
  try {
    assert.equal(await rememberedTeam(work), '');
    await writeFile(path.join(work, 'pocket.config.json'), JSON.stringify({ team: 'ABCDE12345' }));
    assert.equal(await rememberedTeam(work), 'ABCDE12345');
    await writeFile(path.join(work, 'pocket.config.json'), JSON.stringify({ team: '"; rm -rf /' }));
    assert.equal(await rememberedTeam(work), '');
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('teams are read from Xcode\'s account preference, whatever its nesting', () => {
  assert.deepEqual(parseTeams({ 'me@example.com': [{ teamID: 'ABCDE12345', teamName: 'Me (Personal Team)', teamType: 'Personal Team', isFreeProvisioningTeam: 1 }, { teamID: 'ZYXWV98765', teamName: 'Percentile Labs LTD', isFreeProvisioningTeam: 0 }], 'dupe@example.com': [{ teamID: 'ZYXWV98765', teamName: 'Percentile Labs LTD' }, { teamID: 'not-a-team' }] }), [
    { id: 'ABCDE12345', name: 'Me (Personal Team)', free: true },
    { id: 'ZYXWV98765', name: 'Percentile Labs LTD', free: false },
  ]);
  assert.deepEqual(parseTeams(undefined), []);
  assert.deepEqual(parseTeams('garbage'), []);
});

test('only paired physical iOS devices count, reachable first', () => {
  const devices = parseDevices(listing(raw('Old Phone', { tunnel: 'unavailable' }), raw('My Phone'), raw('Watch', { platform: 'watchOS' }), raw('Stranger', { pairing: 'unpaired' }), raw('Simulator', { reality: 'virtual' }), { identifier: 'broken' }));
  assert.deepEqual(devices.map((device) => [device.name, device.available]), [['My Phone', true], ['Old Phone', false]]);
  assert.equal(devices[0]!.udid, 'UDID-My Phone');
  assert.deepEqual(parseDevices({}), []);
});

test('choosing a device explains exactly what is missing', () => {
  const one = parseDevices(listing(raw('My Phone')));
  assert.equal(chooseDevice(one, undefined).name, 'My Phone');
  assert.equal(chooseDevice(one, 'my phone').name, 'My Phone');
  assert.equal(chooseDevice(one, 'udid-my phone').name, 'My Phone');
  assert.throws(() => chooseDevice([], undefined), /No iPhone found/);
  assert.throws(() => chooseDevice(one, 'Other'), /No paired device called "Other".*Known: My Phone/);
  assert.throws(() => chooseDevice(parseDevices(listing(raw('My Phone', { tunnel: 'unavailable' }))), undefined), /paired but not reachable/);
  assert.throws(() => chooseDevice(parseDevices(listing(raw('My Phone', { developerMode: 'disabled' }))), undefined), /Developer Mode off[\s\S]*Privacy & Security/);
  const two = parseDevices(listing(raw('My Phone'), raw('iPad'), raw('Old Phone', { tunnel: 'unavailable' })));
  assert.throws(() => chooseDevice(two, undefined), /Several devices[\s\S]*My Phone[\s\S]*iPad/);
  assert.equal(chooseDevice(two, 'iPad').name, 'iPad');
});

test('Apple\'s signing errors are translated into what to do', () => {
  // Verbatim from Xcode 26.2 with no account signed in; the first error is the cause, the second a symptom.
  const noAccount = "Example.xcodeproj: error: No Accounts: Add a new account in Accounts settings. (in target 'Example')\nExample.xcodeproj: error: No profiles for 'app.pocket.example' were found: Xcode couldn't find any iOS App Development provisioning profiles";
  assert.match(signingHint(noAccount)!, /Add your Apple ID in Xcode/);
  assert.match(signingHint("error: No profiles for 'app.pocket.x' were found")!, /provisioning profile/);
  assert.match(signingHint('Your maximum number of apps for free development profiles has been reached.')!, /limited to 3/);
  assert.match(signingHint('Failed to register bundle identifier: The app identifier "app.pocket.x" cannot be registered to your development team')!, /--bundle-id/);
  assert.match(signingHint('The request to open "app.pocket.x" failed. Unable to launch because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.')!, /VPN & Device Management/);
  assert.equal(signingHint("error: cannot find 'foo' in scope"), undefined);
});
