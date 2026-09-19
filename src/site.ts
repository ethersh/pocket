/** What the site says about itself: used for the default app name, icon and launch colour. */
export interface SiteInfo {
  name?: string;
  /** Guess from <title>; weaker than anything the site declares explicitly. */
  titleName?: string;
  themeColor?: string;
  manifestUrl?: string;
  /** Best first. */
  icons: string[];
}

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    result[match[1]!.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

export function normalizeHex(value: string | undefined): string | undefined {
  const text = value?.trim().toLowerCase() ?? '';
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text)) return '#' + [...text.slice(1)].map((digit) => digit + digit).join('');
  return undefined;
}

function largestSize(sizes: string | undefined): number {
  return Math.max(0, ...(sizes ?? '').split(/\s+/).map((size) => parseInt(size, 10) || 0));
}

function resolve(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch { return undefined; }
}

const isVector = (href: string, type?: string) => type === 'image/svg+xml' || /\.svg(\?|#|$)/i.test(href);

/** A page title is usually "Product — tagline"; keep the product. */
export function nameFromTitle(title: string): string | undefined {
  const first = title.split(/\s+[|–—·:•-]\s+|\s*[|–—·•]\s*/)[0]?.trim() ?? '';
  return first.length >= 2 && first.length <= 24 ? first : undefined;
}

export function nameFromHost(hostname: string): string {
  const labels = hostname.replace(/^www\./, '').split('.');
  const label = (labels.length > 1 ? labels[labels.length - 2] : labels[0]) || 'App';
  return /^\d+$/.test(label) ? 'App' : label.charAt(0).toUpperCase() + label.slice(1);
}

export function parseHtml(html: string, pageUrl: string): SiteInfo {
  const head = html.slice(0, 400_000);
  const base = resolve(attributes(head.match(/<base\b[^>]*>/i)?.[0] ?? '').href, pageUrl) ?? pageUrl;
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((match) => attributes(match[0]));
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((match) => attributes(match[0]));
  const meta = (key: string) => metas.find((entry) => (entry.name ?? entry.property)?.toLowerCase() === key)?.content?.trim() || undefined;
  const title = decodeEntities(head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();

  const ranked: { href: string; score: number }[] = [];
  for (const link of links) {
    const rel = (link.rel ?? '').toLowerCase().split(/\s+/);
    const href = resolve(link.href, base);
    if (!href || isVector(href, link.type)) continue;
    const size = largestSize(link.sizes);
    if (rel.some((value) => value.startsWith('apple-touch-icon'))) ranked.push({ href, score: 10_000 + (size || 180) });
    else if (rel.includes('icon')) ranked.push({ href, score: size || 16 });
  }

  return {
    name: meta('apple-mobile-web-app-title') ?? meta('application-name') ?? meta('og:site_name'),
    titleName: nameFromTitle(title),
    themeColor: normalizeHex(metas.find((entry) => entry.name?.toLowerCase() === 'theme-color' && !entry.media)?.content ?? meta('theme-color')),
    manifestUrl: resolve(links.find((link) => (link.rel ?? '').toLowerCase().split(/\s+/).includes('manifest'))?.href, base),
    icons: ranked.sort((a, b) => b.score - a.score).map((entry) => entry.href),
  };
}

interface Manifest {
  name?: unknown; short_name?: unknown; theme_color?: unknown; background_color?: unknown;
  icons?: { src?: unknown; sizes?: unknown; type?: unknown; purpose?: unknown }[];
}

export function parseManifest(text: string, manifestUrl: string): SiteInfo {
  let manifest: Manifest;
  try { manifest = JSON.parse(text) as Manifest; } catch { return { icons: [] }; }
  if (!manifest || typeof manifest !== 'object') return { icons: [] };
  const text_ = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const icons = (Array.isArray(manifest.icons) ? manifest.icons : [])
    .map((icon) => ({ href: resolve(text_(icon?.src), manifestUrl), type: text_(icon?.type), size: largestSize(text_(icon?.sizes)), purpose: text_(icon?.purpose) ?? 'any' }))
    .filter((icon): icon is typeof icon & { href: string } => !!icon.href && !isVector(icon.href, icon.type) && icon.purpose !== 'monochrome')
    // Maskable icons are full-bleed with a safe zone, which is exactly what an iOS icon wants.
    .sort((a, b) => (b.size + (b.purpose.includes('maskable') ? 1 : 0)) - (a.size + (a.purpose.includes('maskable') ? 1 : 0)));
  return {
    name: text_(manifest.short_name) ?? text_(manifest.name),
    themeColor: normalizeHex(text_(manifest.background_color)) ?? normalizeHex(text_(manifest.theme_color)),
    icons: icons.map((icon) => icon.href),
  };
}

async function get(url: string, accept: string): Promise<Response> {
  const response = await fetch(url, { headers: { 'user-agent': SAFARI, accept }, redirect: 'follow', signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  return response;
}

/** Never throws: a site that can't be reached just means monogram icon and hostname-derived name. */
export async function inspectSite(url: URL): Promise<SiteInfo & { warning?: string }> {
  const fallbackIcons = [new URL('/apple-touch-icon.png', url).href, new URL('/favicon.ico', url).href];
  try {
    const response = await get(url.href, 'text/html,application/xhtml+xml');
    const page = parseHtml(await response.text(), response.url || url.href);
    let manifest: SiteInfo = { icons: [] };
    if (page.manifestUrl) {
      try { manifest = parseManifest(await (await get(page.manifestUrl, 'application/manifest+json,application/json')).text(), page.manifestUrl); } catch { /* optional */ }
    }
    const touch = page.icons.filter((_, index) => index < 1);
    return {
      name: page.name ?? manifest.name ?? page.titleName,
      themeColor: manifest.themeColor ?? page.themeColor,
      manifestUrl: page.manifestUrl,
      // Large manifest icons beat a 180px touch icon, which beats favicons.
      icons: [...new Set([...manifest.icons.slice(0, 2), ...touch, ...page.icons, ...fallbackIcons])],
    };
  } catch (error) {
    return { icons: fallbackIcons, warning: `Couldn't read ${url.host} (${(error as Error).message}); using defaults.` };
  }
}

export async function download(url: string): Promise<Buffer> {
  const response = await get(url, 'image/png,image/*;q=0.8');
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('svg') || type.includes('html')) throw new Error(`not a bitmap (${type})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 64 || bytes.length > 20_000_000) throw new Error('unreasonable size');
  return bytes;
}
