/**
 * News feeds for the "Discoveries this week" thread on X (src/social/content.ts): regulators, public health bodies,
 * evidence reviewers and the news desks of the leading journals. Only primary or editorially checked sources; no
 * press-release aggregators and no preprints. Each feed is plain RSS or Atom, read without a key.
 */
export interface FeedItem {
  /** Stable key within one run, e.g. "F3-2". */
  id: string;
  source: string;
  title: string;
  link: string;
  date: string;
  summary: string;
}

export const FEEDS: { name: string; url: string }[] = [
  { name: 'FDA (press announcements)', url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml' },
  { name: 'FDA (drug safety, MedWatch)', url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/medwatch/rss.xml' },
  { name: 'NIH (news releases)', url: 'https://www.nih.gov/news-releases/feed.xml' },
  { name: 'WHO (news)', url: 'https://www.who.int/rss-feeds/news-english.xml' },
  { name: 'CDC (newsroom)', url: 'https://tools.cdc.gov/api/v2/resources/media/132608.rss' },
  { name: 'European Medicines Agency (news)', url: 'https://www.ema.europa.eu/en/news.xml' },
  { name: 'MHRA (UK medicines regulator)', url: 'https://www.gov.uk/government/organisations/medicines-and-healthcare-products-regulatory-agency.atom' },
  { name: 'EFSA (European Food Safety Authority)', url: 'https://www.efsa.europa.eu/en/all/rss' },
  { name: 'Cochrane (news and new reviews)', url: 'https://www.cochrane.org/rss.xml' },
  { name: 'Nature (news)', url: 'https://www.nature.com/nature.rss' },
  { name: 'Nature Medicine (new papers)', url: 'https://www.nature.com/nm.rss' },
  { name: 'Science (news)', url: 'https://www.science.org/rss/news_current.xml' },
  { name: 'The BMJ (latest)', url: 'https://www.bmj.com/rss/recent.xml' },
  { name: 'NEJM (current articles)', url: 'https://www.nejm.org/action/showFeed?jc=nejm&type=etoc&feed=rss' },
  { name: 'JAMA (current issue)', url: 'https://jamanetwork.com/rss/site_3/67.xml' },
];

/** The site names itself to the feeds it reads, as it does to PubMed. */
const CLIENT = { 'user-agent': 'WellnessWhizz/1.0 (+https://aiww.io)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' };

const strip = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;|&#x27;|&rsquo;|&#8217;/g, "'").replace(/&quot;|&#8220;|&#8221;/g, '"').replace(/&#\d+;|&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

function tag(block: string, names: string[]): string {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m && m[1].trim()) return m[1];
  }
  return '';
}

function parse(xml: string, source: string, key: string, since: number, max: number): FeedItem[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const out: FeedItem[] = [];
  for (const b of blocks) {
    const title = strip(tag(b, ['title']));
    const link = strip(tag(b, ['link'])) || (b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? '');
    const dateText = strip(tag(b, ['pubDate', 'dc:date', 'updated', 'published', 'prism:coverDate']));
    const when = Date.parse(dateText);
    if (!title || !/^https?:\/\//.test(link)) continue;
    const secure = link.replace(/^http:\/\//, 'https://');
    if (Number.isFinite(when) && when < since) continue;
    out.push({ id: `${key}-${out.length + 1}`, source, title: title.slice(0, 220), link: secure, date: Number.isFinite(when) ? new Date(when).toISOString().slice(0, 10) : '', summary: strip(tag(b, ['description', 'summary', 'content:encoded', 'content'])).slice(0, 600) });
    if (out.length >= max) break;
  }
  return out;
}

/** The last `days` days of every feed, at most `perFeed` items each, with a report of which feeds answered. */
export async function feedItems(days = 8, perFeed = 8): Promise<{ items: FeedItem[]; report: { name: string; ok: boolean; count: number; note: string }[] }> {
  const since = Date.now() - days * 86_400_000;
  const results = await Promise.all(FEEDS.map(async (f, i) => {
    try {
      const res = await fetch(f.url, { headers: CLIENT, signal: AbortSignal.timeout(9000) });
      if (!res.ok) return { name: f.name, ok: false, count: 0, note: `HTTP ${res.status}`, items: [] as FeedItem[] };
      const xml = await res.text();
      if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) return { name: f.name, ok: false, count: 0, note: 'not a feed', items: [] as FeedItem[] };
      const items = parse(xml, f.name.replace(/ \(.*\)$/, ''), `F${i + 1}`, since, perFeed);
      return { name: f.name, ok: true, count: items.length, note: '', items };
    } catch (err) {
      return { name: f.name, ok: false, count: 0, note: String(err).slice(0, 80), items: [] as FeedItem[] };
    }
  }));
  return { items: results.flatMap((r) => r.items), report: results.map(({ name, ok, count, note }) => ({ name, ok, count, note })) };
}
