import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UsageError, parseOptions, parseUrl, type Options } from '../src/options.ts';
import { defaultBundleId, internalHosts, readInjections, renderConfig, renderInfoPlist, renderProject, targetName, writeProject, type Plan } from '../src/render.ts';
import { nameFromHost, nameFromTitle, normalizeHex, parseHtml, parseManifest } from '../src/site.ts';

const options = (...argv: string[]) => parseOptions(argv) as Options;

test('urls: scheme is optional, only web schemes are accepted', () => {
  assert.equal(parseUrl('news.ycombinator.com').href, 'https://news.ycombinator.com/');
  assert.equal(parseUrl('http://localhost:3000/app').href, 'http://localhost:3000/app');
  assert.throws(() => parseUrl('file:///etc/passwd'), UsageError);
  assert.throws(() => parseUrl('javascript://alert(1)'), UsageError);
  assert.throws(() => parseUrl('https://'), UsageError);
});

test('options: defaults favour Dynamic Type and reject bad values', () => {
  const parsed = options('https://example.com');
  assert.equal(parsed.dynamicType, 'text');
  assert.equal(parsed.edges, 'auto');
  assert.equal(parsed.lockZoom, true);
  assert.deepEqual([parsed.minTextScale, parsed.maxTextScale], [0.8, 3.2]);
  assert.equal(parseOptions(['--help']), 'help');
  assert.equal(options('example.com', '--allow-zoom').lockZoom, false);
  assert.deepEqual(options('example.com', '--internal-hosts', 'Auth.Example.com, cdn.example.com').internalHosts, ['auth.example.com', 'cdn.example.com']);
  for (const bad of [['--dynamic-type', 'huge'], ['--theme-color', 'red'], ['--bundle-id', 'nodots'], ['--team', 'abc'], ['--max-text-scale', '9'], ['--min-text-scale', '2', '--max-text-scale', '1'], ['--nope']]) {
    assert.throws(() => parseOptions(['example.com', ...bad]), UsageError, bad.join(' '));
  }
  assert.throws(() => parseOptions([]), UsageError);
  assert.throws(() => parseOptions(['a.com', 'b.com']), UsageError);
});

test('names: targets are identifier-safe, bundle ids are valid, hosts drop www', () => {
  assert.equal(targetName('Hacker News'), 'HackerNews');
  assert.equal(targetName('Café 24/7!'), 'Cafe247');
  assert.equal(targetName('2048'), 'App2048');
  assert.equal(targetName('日本語'), 'PocketApp');
  assert.equal(defaultBundleId('Hacker News'), 'app.pocket.hacker-news');
  assert.equal(defaultBundleId('日本語'), 'app.pocket.app');
  assert.deepEqual(internalHosts(new URL('https://www.Example.com/x'), ['auth.example.com', 'example.com']), ['example.com', 'auth.example.com']);
  assert.equal(nameFromHost('www.github.com'), 'Github');
  assert.equal(nameFromHost('app.linear.app'), 'Linear');
  assert.equal(nameFromHost('127.0.0.1'), 'App');
  assert.equal(nameFromHost('localhost'), 'Localhost');
  assert.equal(nameFromTitle('GitHub · Change is constant. GitHub keeps you ahead.'), 'GitHub');
  assert.equal(nameFromTitle('Capy - Build and ship faster'), 'Capy');
  assert.equal(nameFromTitle('A very long marketing headline with no separator at all'), undefined);
});

test('site metadata: explicit names, largest bitmap icons, plain hex colours', () => {
  const page = parseHtml(`<html><head><title>Acme &amp; Co — Home</title>
    <meta name="apple-mobile-web-app-title" content="Acme">
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000">
    <meta name='theme-color' content='#AbC'>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="icon" sizes="32x32" href="/favicon-32.png">
    <link rel="apple-touch-icon" sizes="120x120" href="touch-120.png">
    <link rel="apple-touch-icon-precomposed" sizes="180x180" href="https://cdn.acme.test/touch-180.png">
    <link rel=manifest href=/site.webmanifest>
    <link rel="icon" href="javascript:alert(1)"></head></html>`, 'https://acme.test/app/');
  assert.equal(page.name, 'Acme');
  assert.equal(page.titleName, 'Acme & Co');
  assert.equal(page.themeColor, '#aabbcc');
  assert.equal(page.manifestUrl, 'https://acme.test/site.webmanifest');
  assert.deepEqual(page.icons, ['https://cdn.acme.test/touch-180.png', 'https://acme.test/app/touch-120.png', 'https://acme.test/favicon-32.png']);

  const manifest = parseManifest(JSON.stringify({
    name: 'Acme Incorporated', short_name: 'Acme', theme_color: 'rebeccapurple', background_color: '#101113',
    icons: [{ src: 'i/192.png', sizes: '192x192' }, { src: 'i/512.png', sizes: '512x512' }, { src: 'i/512m.png', sizes: '512x512', purpose: 'maskable' }, { src: 'i/mono.png', sizes: '1024x1024', purpose: 'monochrome' }, { src: 'i/logo.svg', sizes: 'any' }],
  }), 'https://acme.test/site.webmanifest');
  assert.equal(manifest.name, 'Acme');
  assert.equal(manifest.themeColor, '#101113');
  assert.deepEqual(manifest.icons, ['https://acme.test/i/512m.png', 'https://acme.test/i/512.png', 'https://acme.test/i/192.png']);
  assert.deepEqual(parseManifest('<html>not json', 'https://acme.test/m'), { icons: [] });
  assert.equal(normalizeHex('rgb(0,0,0)'), undefined);
});

const plan = (outDir: string, extra: Partial<Plan> = {}): Plan => ({
  displayName: 'Tom & Jerry <3', target: 'TomJerry3', bundleId: 'app.pocket.tom-jerry-3', outDir,
  internalHosts: ['example.com'], userCSS: '', userJS: '', ...extra,
});

test('rendering: plist is escaped and conditional keys follow the options', () => {
  const template = '<string>__DISPLAY_NAME__</string>\n<dict>\n__LAUNCH_SCREEN__\n</dict>\n__ORIENTATIONS__\n~\n__ORIENTATIONS_IPAD__\n__EXTRA_KEYS__\n';
  const secure = renderInfoPlist(template, options('https://example.com'), plan('/tmp/x'));
  assert.match(secure, /Tom &amp; Jerry &lt;3/);
  assert.doesNotMatch(secure, /NSAppTransportSecurity|UsageDescription|UIColorName|UIRequiresFullScreen|__[A-Z_]+__/);
  assert.match(secure.split('~')[1]!, /PortraitUpsideDown/);

  const loose = renderInfoPlist(template, options('http://192.168.1.4:3000', '--camera', '--microphone', '--orientation', 'portrait'), plan('/tmp/x', { themeColor: '#ff6600' }));
  assert.match(loose, /NSAllowsArbitraryLoadsInWebContent/);
  assert.match(loose, /NSCameraUsageDescription/);
  assert.match(loose, /NSMicrophoneUsageDescription/);
  assert.match(loose, /LaunchBackground/);
  assert.match(loose, /UIRequiresFullScreen/);
  assert.doesNotMatch(loose, /Landscape/);

  const project = renderProject('__TARGET__ __BUNDLE_ID__ "__TEAM__" __VERSION__ __BUILD__ __MIN_IOS__ "__DEVICE_FAMILY__"', options('example.com', '--team', 'ABCDE12345', '--iphone-only', '--version', '2.1'), plan('/tmp/x'));
  assert.equal(project, 'TomJerry3 app.pocket.tom-jerry-3 "ABCDE12345" 2.1 1 16.0 "1"');

  const config = JSON.parse(renderConfig(options('http://localhost:3000', '--edges', 'full', '--popups', 'safari', '--user-agent', 'X'), plan('/tmp/x')));
  assert.deepEqual([config.url, config.allowInsecure, config.edges, config.popups, config.userAgent, config.themeColor], ['http://localhost:3000/', true, 'full', 'safari', 'X', undefined]);
});

test('writing: produces a complete project, regenerates in place, never clobbers foreign folders', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'pocket-test-'));
  try {
    const css = path.join(work, 'a.css');
    const js = path.join(work, 'b.js');
    await writeFile(css, 'body { color: red }');
    await writeFile(js, 'console.log("hi")');
    const injections = await readInjections([css, js]);
    assert.match(injections.userCSS, /a\.css[\s\S]*color: red/);
    assert.match(injections.userJS, /console\.log/);
    await assert.rejects(readInjections([path.join(work, 'x.txt')]), UsageError);
    await assert.rejects(readInjections([path.join(work, 'missing.css')]), UsageError);

    const out = path.join(work, 'App One');
    await writeProject(options('https://example.com'), plan(out, { ...injections, themeColor: '#ff6600' }), Buffer.from('png'));
    const files = (await readdir(out, { recursive: true })).sort();
    for (const expected of ['Info.plist', 'pocket.config.json', 'TomJerry3.xcodeproj/project.pbxproj', 'App/bridge.js', 'App/pocket.json', 'App/user.css', 'App/user.js', 'App/WebViewController.swift', 'App/Assets.xcassets/AppIcon.appiconset/icon.png', 'App/Assets.xcassets/LaunchBackground.colorset/Contents.json']) {
      assert.ok(files.includes(expected), `missing ${expected}`);
    }
    assert.doesNotMatch(await readFile(path.join(out, 'TomJerry3.xcodeproj/project.pbxproj'), 'utf8'), /__[A-Z_]+__/);
    assert.match(await readFile(path.join(out, 'App/Assets.xcassets/LaunchBackground.colorset/Contents.json'), 'utf8'), /"red": "0xFF"[\s\S]*"green": "0x66"/);

    // Regenerating over our own output is fine, keeps unrelated files, and drops the stale launch colour.
    await writeFile(path.join(out, 'NOTES.md'), 'mine');
    await writeProject(options('https://example.com'), plan(out), Buffer.from('png'));
    assert.equal(await readFile(path.join(out, 'NOTES.md'), 'utf8'), 'mine');
    assert.ok(!(await readdir(path.join(out, 'App/Assets.xcassets'))).includes('LaunchBackground.colorset'));

    const foreign = path.join(work, 'foreign');
    await mkdir(foreign);
    await writeFile(path.join(foreign, 'thesis.docx'), 'important');
    await assert.rejects(writeProject(options('https://example.com'), plan(foreign), Buffer.from('png')), UsageError);
    assert.deepEqual(await readdir(foreign), ['thesis.docx']);
  } finally { await rm(work, { recursive: true, force: true }); }
});
