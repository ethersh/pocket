import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from '@playwright/test';

const source = (await readFile(new URL('../template/bridge.js', import.meta.url), 'utf8')).trim();
/** Exactly what the native side evaluates. */
const bridge = (init: Record<string, unknown>) => `${source}(${JSON.stringify(init)});`;
const base = { mode: 'text', lockZoom: true, edges: 'auto', hosts: ['app.test'], userCSS: '', textScale: 1, safeTop: 0, safeBottom: 0, safeLeft: 0, safeRight: 0 };

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); });

async function open(url: string, html: string, options: { early?: Record<string, unknown> } = {}): Promise<{ page: Page; messages: Record<string, unknown>[] }> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const messages: Record<string, unknown>[] = [];
  await page.exposeFunction('capture', (value: string) => { messages.push(JSON.parse(value)); });
  await page.addInitScript('window.webkit = { messageHandlers: { pocket: { postMessage: (value) => window.capture(value) } } }');
  if (options.early) await page.addInitScript(bridge(options.early));
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url);
  return { page, messages };
}

const computed = (page: Page, selector: string, property: string) => page.locator(selector).first().evaluate((element, name) => getComputedStyle(element).getPropertyValue(name).trim(), property);

test('text mode scales every element, editors included, without touching fonts, drafts or root size', async () => {
  const { page, messages } = await open('https://app.test/chat', '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{-webkit-text-size-adjust:100%;text-size-adjust:100%}html,body{margin:0;background:rgb(12,9,11);font-family:Georgia}header{height:50px;background:rgb(30,40,50)}textarea{font-size:16px}.reset{text-size-adjust:none}</style></head><body><header>App</header><p>Sample</p><p class="reset">Reset</p><textarea>Preserve draft</textarea><div contenteditable="true"><p>Rich draft</p></div></body></html>');
  await page.evaluate(bridge({ ...base, textScale: 0.82, safeTop: 59, safeBottom: 34 }));
  assert.equal(await computed(page, 'p', 'text-size-adjust'), '82%');
  assert.equal(await computed(page, '.reset', 'text-size-adjust'), '82%');
  assert.equal(await computed(page, 'textarea', 'text-size-adjust'), '82%');
  assert.equal(await computed(page, '[contenteditable] p', 'text-size-adjust'), '82%');
  assert.equal(await computed(page, 'p', 'font-family'), 'Georgia');
  assert.equal(await computed(page, 'html', 'font-size'), '16px');
  assert.equal(await computed(page, 'html', '--pocket-text-scale'), '0.82');
  assert.equal(await computed(page, 'html', '--pocket-safe-top'), '59px');
  assert.equal(await computed(page, 'html', '--pocket-safe-bottom'), '34px');
  assert.equal(await page.locator('textarea').inputValue(), 'Preserve draft');
  assert.equal(await page.locator('meta[name=viewport]').getAttribute('content'), 'width=device-width, initial-scale=1, maximum-scale=1');
  await page.waitForFunction(() => true);
  assert.deepEqual(messages.at(-1), { type: 'pocket-chrome', top: '#1e2832', bottom: '#0c090b', edge: false });

  // A Text Size change arrives as an update: same style element, no reload, draft intact.
  await page.locator('textarea').fill('Edited draft');
  assert.equal(await page.evaluate(bridge({ ...base, textScale: 1.35 })), true);
  assert.equal(await page.locator('#pocket-bridge-style').count(), 1);
  assert.equal(await computed(page, 'p', 'text-size-adjust'), '135%');
  assert.equal(await page.locator('textarea').inputValue(), 'Edited draft');

  // Frameworks that own <head> may throw our style away; it comes back at the current size.
  await page.evaluate(() => document.getElementById('pocket-bridge-style')!.remove());
  await page.waitForFunction(() => !!document.getElementById('pocket-bridge-style'));
  assert.match(await page.locator('#pocket-bridge-style').textContent() ?? '', /135%/);

  // Garbage from a confused caller is ignored rather than rendered.
  await page.evaluate(bridge({ ...base, textScale: 'huge', safeTop: -5 }));
  assert.equal(await computed(page, 'p', 'text-size-adjust'), '135%');
  assert.equal(await computed(page, 'html', '--pocket-safe-top'), '0px');
  await page.close();
});

test('zoom and off modes expose the scale but leave text-size-adjust alone', async () => {
  for (const mode of ['zoom', 'off']) {
    const { page } = await open('https://app.test/', '<html><head><style>p{text-size-adjust:100%}</style></head><body><p>Text</p></body></html>');
    await page.evaluate(bridge({ ...base, mode, textScale: 1.5 }));
    assert.equal(await computed(page, 'p', 'text-size-adjust'), '100%', mode);
    assert.equal(await computed(page, 'html', '--pocket-text-scale'), '1.5', mode);
    await page.close();
  }
});

test('edge colours resolve modern colour syntax and alpha, and follow theme changes', async () => {
  const { page, messages } = await open('https://app.test/', '<html><head><style>html,body{margin:0;background:oklch(0% 0 0)}header{background:color-mix(in oklab,white 50%,black);height:44px}</style></head><body><header>Header</header></body></html>');
  await page.evaluate(bridge(base));
  assert.deepEqual(messages.at(-1), { type: 'pocket-chrome', top: '#636363', bottom: '#000000', edge: false });
  await page.evaluate(() => { document.querySelector('header')!.style.backgroundColor = 'oklch(100% 0 0 / 0.5)'; });
  await page.waitForTimeout(350);
  const blended = String(messages.at(-1)!.top);
  for (const offset of [1, 3, 5]) assert.ok(Math.abs(parseInt(blended.slice(offset, offset + 2), 16) - 128) <= 1, blended);
  // Nothing but validated-shape colour messages ever leaves the page.
  for (const message of messages) assert.deepEqual(Object.keys(message).sort(), ['bottom', 'edge', 'top', 'type']);
  await page.close();
});

test('viewport guard starts at document start, keeps site settings, repairs replacements, and --allow-zoom disables it', async () => {
  const html = '<html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=5"></head><body><input autofocus></body></html>';
  const { page, messages } = await open('https://app.test/', html, { early: base });
  await page.waitForFunction(() => document.querySelector<HTMLMetaElement>('meta[name=viewport]')?.content.endsWith('maximum-scale=1'));
  assert.equal(await page.locator('meta[name=viewport]').getAttribute('content'), 'width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1');
  // auto edges: the page asked for viewport-fit=cover, so it gets the whole screen.
  await page.waitForTimeout(350);
  assert.equal(messages.at(-1)!.edge, true);
  await page.evaluate(() => {
    document.querySelectorAll('meta[name=viewport]').forEach((meta) => meta.remove());
    const meta = document.createElement('meta'); meta.name = 'viewport'; meta.content = 'width=device-width, user-scalable=yes, maximum-scale=10'; document.head.appendChild(meta);
  });
  await page.waitForFunction(() => document.querySelector<HTMLMetaElement>('meta[name=viewport]')?.content.endsWith('maximum-scale=1'));
  assert.equal(await page.locator('meta[name=viewport]').count(), 1);
  await page.waitForTimeout(350);
  assert.equal(messages.at(-1)!.edge, false, 'the replacement meta dropped viewport-fit=cover');
  await page.close();

  const free = await open('https://app.test/', html, { early: { ...base, lockZoom: false } });
  await free.page.waitForTimeout(100);
  assert.match(await free.page.locator('meta[name=viewport]').getAttribute('content') ?? '', /maximum-scale=5/);
  await free.page.close();

  // A desktop-only page with no viewport meta keeps its desktop layout.
  const legacy = await open('https://app.test/', '<html><head></head><body>1999</body></html>', { early: base });
  await legacy.page.waitForTimeout(100);
  assert.equal(await legacy.page.locator('meta[name=viewport]').count(), 0);
  await legacy.page.close();
});

test('edges: full forces cover on internal hosts only; inset never goes edge-to-edge', async () => {
  const html = '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>Page</body></html>';
  const internal = await open('https://www.app.test/', html, { early: { ...base, edges: 'full' } });
  await internal.page.waitForFunction(() => document.querySelector<HTMLMetaElement>('meta[name=viewport]')?.content.includes('viewport-fit=cover'));
  await internal.page.waitForTimeout(250);
  assert.equal(internal.messages.at(-1)!.edge, true);
  await internal.page.close();

  const external = await open('https://accounts.example.org/login', html, { early: { ...base, edges: 'full' } });
  await external.page.waitForTimeout(250);
  assert.doesNotMatch(await external.page.locator('meta[name=viewport]').getAttribute('content') ?? '', /viewport-fit/);
  assert.equal(external.messages.at(-1)!.edge, false);
  await external.page.close();

  const inset = await open('https://app.test/', '<html><head><meta name="viewport" content="width=device-width, viewport-fit=cover"></head><body>Page</body></html>', { early: { ...base, edges: 'inset' } });
  await inset.page.waitForTimeout(250);
  assert.equal(inset.messages.at(-1)!.edge, false);
  await inset.page.close();
});

test('user CSS applies on internal hosts and subdomains, never on external pages; Dynamic Type applies everywhere', async () => {
  const init = { ...base, textScale: 1.2, userCSS: 'body { outline: 3px solid rgb(255, 0, 0) }' };
  const html = '<html><body><p>Page</p></body></html>';
  for (const [url, styled] of [['https://app.test/', true], ['https://docs.app.test/', true], ['https://evilapp.test/', false], ['https://app.test.evil.example/', false]] as const) {
    const { page } = await open(url, html);
    await page.evaluate(bridge(init));
    assert.equal(await page.locator('#pocket-user-style').count(), styled ? 1 : 0, url);
    assert.equal(await computed(page, 'p', 'text-size-adjust'), '120%', url);
    await page.close();
  }
});

test('subframes get the text scale but never report colours or touch their viewport', async () => {
  const { page, messages } = await open('https://app.test/', '<html><body><p>Top</p><iframe src="https://embed.example.org/widget"></iframe></body></html>');
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
  await frame.waitForLoadState();
  const before = messages.length;
  await frame.evaluate(bridge({ ...base, textScale: 1.5 }));
  assert.equal(await frame.evaluate(() => getComputedStyle(document.body).getPropertyValue('text-size-adjust')), '150%');
  assert.equal(await frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pocket-safe-top')), '');
  await page.waitForTimeout(250);
  assert.equal(messages.length, before);
  await page.close();
});

test('edge-to-edge layout: a live backdrop stays one canvas while injected CSS insets the controls', async () => {
  const fixture = await readFile(new URL('./edge-layout.html', import.meta.url), 'utf8');
  // Site CSS of the kind --inject is for: feed the native insets to the page's own variables, let the
  // backdrop reach the top of the display, and keep the navigation button below the notch.
  const userCSS = `
    :root { --safe-top: var(--pocket-safe-top) !important; --safe-bottom: 12px !important; }
    [data-slot="sidebar-wrapper"] { padding-top: 0 !important; }
    [data-slot="sidebar-panel"] main > div { padding-top: var(--safe-top); box-sizing: border-box; }
    [data-slot="sidebar-panel"] main > div > [class~="top-1.5"] { top: calc(var(--safe-top) + 0.375rem) !important; }`;
  const { page, messages } = await open('https://app.test/new', fixture);
  await page.evaluate('window.originalCanvas = document.querySelector("canvas")');
  await page.evaluate(bridge({ ...base, textScale: 0.82, safeTop: 59, userCSS }));
  assert.equal(messages.at(-1)!.edge, true);
  assert.equal((await page.locator('canvas').boundingBox())!.y, 0);
  assert.equal((await page.locator('button').first().boundingBox())!.y, 65);
  await page.evaluate('window.paintTheme("#8649bd"); document.querySelector("aside").hidden = false');
  assert.equal((await page.locator('aside').boundingBox())!.y, 0);
  assert.equal((await page.locator('aside header').boundingBox())!.y, 59);
  assert.equal(await page.evaluate('window.originalCanvas === document.querySelector("canvas")'), true);
  assert.equal(await computed(page, 'html', '--safe-bottom'), '12px');
  await page.close();
});
