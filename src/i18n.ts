/**
 * The Spanish site. Every page also exists under /es/ (home, quiz, results, supplement pages, the blog, how it works,
 * terms), served by the same handlers in src/index.ts with lang = 'es':
 *   - page chrome (navigation, buttons, labels, headings, meta descriptions, alt texts) is translated by
 *     localizeResponse(), an HTMLRewriter pass over the English page that looks every text node and attribute up in
 *     src/i18n/es.json (built once by /api/admin/translate/strings from the English strings) and rewrites internal
 *     links to /es/...; keys may hold {n} (a number) or {x} (any text) placeholders;
 *   - page content (supplement fields, articles) comes translated from the translations table (src/translate.ts);
 *   - every page carries hreflang links to its counterpart, and a language link is added to the footer.
 * Strings missing from the dictionary stay English, so a new label never breaks the Spanish site.
 */
import esDict from './i18n/es.json';

export type Lang = 'en' | 'es';
export const SITE_LANGS: readonly Lang[] = ['en', 'es'];
/** Languages content is translated into (everything but English). */
export const CONTENT_LANGS: readonly Lang[] = ['es'];
export const LANG_LABELS: Record<Lang, string> = { en: 'English', es: 'Español' };

type Dict = Record<string, string>;
interface Pattern {
  re: RegExp;
  out: string;
}

const DICTS: Record<Lang, Dict> = { en: {}, es: esDict as Dict };
const PATTERNS: Record<Lang, Pattern[]> = { en: [], es: compilePatterns(esDict as Dict) };

function compilePatterns(dict: Dict): Pattern[] {
  const out: Pattern[] = [];
  for (const [key, value] of Object.entries(dict)) {
    if (!/\{[nx]\}/.test(key)) continue;
    const source = key
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\{n\\\}/g, '(\\d[\\d.,]*)')
      .replace(/\\\{x\\\}/g, '(.+?)');
    out.push({ re: new RegExp(`^${source}$`), out: value });
  }
  return out;
}

export function asLang(value: unknown): Lang {
  return value === 'es' ? 'es' : 'en';
}

/** The language a request path is in: /es and /es/... are Spanish. */
export function langFromPath(path: string): Lang {
  return /^\/es(\/|$)/.test(path) ? 'es' : 'en';
}

/** /es/blog -> /blog, /es -> / */
export function englishPath(path: string): string {
  return path.replace(/^\/es(?=\/|$)/, '') || '/';
}

/** Paths that have no language version: APIs, assets, feeds, result pages (which follow their session's language). */
const UNLOCALIZED = /^\/(es(\/|$)|api\/|images\/|css\/|js\/|result\/|shelf\/[0-9a-f]+|feed\.xml|sitemap\.xml|llms\.txt|robots\.txt|[0-9a-f]{32}\.txt|__)/;

export function localizePath(path: string, lang: Lang): string {
  if (lang === 'en' || !path.startsWith('/') || path.startsWith('//') || UNLOCALIZED.test(path)) return path;
  return path === '/' ? '/es/' : `/es${path}`;
}

/** Site-relative links and absolute links to this site move under /es/; links to other sites (iHerb, PubMed) are left alone. */
function localizeUrl(href: string, lang: Lang, origin: string): string {
  if (href.startsWith('/')) return localizePath(href, lang);
  if (!/^https?:\/\//i.test(href)) return href;
  try {
    const url = new URL(href);
    const site = new URL(origin);
    if (url.host !== site.host && url.host !== 'aiww.io' && url.host !== 'www.aiww.io') return href;
    url.pathname = localizePath(url.pathname, lang);
    return url.toString();
  } catch {
    return href;
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

export function normalizeKey(text: string): string {
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

/** The dictionary translation of a string, or null when there is none. */
export function translateString(text: string, lang: Lang): string | null {
  if (lang === 'en') return null;
  const key = normalizeKey(text);
  if (!key) return null;
  const direct = DICTS[lang][key];
  if (direct) return direct;
  for (const p of PATTERNS[lang]) {
    const m = p.re.exec(key);
    if (m) {
      let i = 0;
      return p.out.replace(/\{[nx]\}/g, () => m[++i] ?? '');
    }
  }
  return null;
}

export interface PageContext {
  origin: string;
  /** The English path of the page, e.g. /blog/melatonin-dosage. */
  path: string;
  /** Add hreflang links and the footer language link (default true; false for pages that exist in one language only). */
  alternates?: boolean;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function alternateLinks(ctx: PageContext): string {
  const en = `${ctx.origin}${ctx.path}`;
  return (
    `\n  <link rel="alternate" hreflang="en" href="${escapeAttr(en)}">` +
    CONTENT_LANGS.map((l) => `\n  <link rel="alternate" hreflang="${l}" href="${escapeAttr(`${ctx.origin}${localizePath(ctx.path, l)}`)}">`).join('') +
    `\n  <link rel="alternate" hreflang="x-default" href="${escapeAttr(en)}">`
  );
}

const ATTRIBUTES: [selector: string, attr: string][] = [
  ['[alt]', 'alt'],
  ['[placeholder]', 'placeholder'],
  ['[title]', 'title'],
  ['[aria-label]', 'aria-label'],
  ['[data-wait]', 'data-wait'],
  ['input[type="submit"]', 'value'],
  ['meta[name="description"]', 'content'],
  ['meta[property="og:description"]', 'content'],
  ['meta[name="twitter:description"]', 'content'],
  ['meta[property="og:title"]', 'content'],
  ['meta[name="twitter:title"]', 'content'],
];

/**
 * The English page as its `lang` version: chrome strings from the dictionary, internal links under /es/, canonical
 * and hreflang links, the language link in the footer. With lang 'en' only the hreflang links are added.
 */
export function localizeResponse(res: Response, lang: Lang, ctx: PageContext): Response {
  const rw = new HTMLRewriter();
  const alternates = ctx.alternates ?? true;
  if (alternates) rw.on('head', { element: (el) => { el.append(alternateLinks(ctx), { html: true }); } });
  const other = lang === 'en' ? CONTENT_LANGS[0] : 'en';
  if (alternates && other) {
    const href = lang === 'en' ? localizePath(ctx.path, other) : ctx.path;
    rw.on('.frame-221', { element: (el) => { el.append(`<a href="${escapeAttr(href)}" class="text-58 ww-footer-link ww-lang-link" hreflang="${other}" lang="${other}">${LANG_LABELS[other]}</a>`, { html: true }); } });
  }
  if (lang === 'en') return rw.transform(res);

  rw.on('html', { element: (el) => { el.setAttribute('lang', lang); } });
  rw.on('a', { element: (el) => rewriteAttr(el, 'href') });
  rw.on('form', { element: (el) => rewriteAttr(el, 'action') });
  rw.on('link[rel="canonical"]', { element: (el) => rewriteAttr(el, 'href') });
  for (const [selector, attr] of ATTRIBUTES) {
    rw.on(selector, {
      element(el) {
        const value = el.getAttribute(attr);
        if (!value) return;
        const translated = translateString(value, lang);
        if (translated) el.setAttribute(attr, translated);
      },
    });
  }
  // Text nodes: script and style content is left alone; everything else is looked up whole (a node can arrive in
  // several chunks, the last of them empty, so the chunks are gathered and the node is written back once).
  let skip = 0;
  let buffer = '';
  const guard = { element: (el: Element) => { skip++; el.onEndTag(() => { skip--; }); } };
  rw.on('script', guard);
  rw.on('style', guard);
  rw.on('*', {
    text(chunk) {
      if (skip > 0) return;
      buffer += chunk.text;
      if (!chunk.lastInTextNode) {
        chunk.remove();
        return;
      }
      const raw = buffer;
      buffer = '';
      if (!raw) return;
      const translated = raw.trim() ? translateString(raw, lang) : null;
      if (translated === null) {
        chunk.replace(raw, { html: true });
        return;
      }
      const lead = /^\s*/.exec(raw)?.[0] ?? '';
      const trail = /\s*$/.exec(raw)?.[0] ?? '';
      chunk.replace(lead + translated + trail, { html: false });
    },
  });
  return rw.transform(res);

  function rewriteAttr(el: Element, attr: string): void {
    const value = el.getAttribute(attr);
    if (value) el.setAttribute(attr, localizeUrl(value, lang, ctx.origin));
  }
}

export async function localizeHtml(html: string, lang: Lang, ctx: PageContext): Promise<string> {
  return localizeResponse(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }), lang, ctx).text();
}
