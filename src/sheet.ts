/**
 * The owner's Google Sheet of directory submissions, kept in sync with the Worker.
 *
 * The sheet is shared "anyone with the link can view", so the Worker reads it without credentials: the HTML view lists
 * the tabs (name and gid), and each tab exports as CSV. Every tab with a header row starting with "ID" is imported into
 * sheet_backlinks (one row per sheet ID), so the admin page and the daily digest show the same picture as the sheet.
 * The sheet stays the place where the owner edits; the Worker only reads it (daily at 06:00 UTC and on "Sync now").
 */
import { getMeta, setMeta } from './db';

export interface SheetEnv {
  DB: D1Database;
  /** The spreadsheet id from its URL (…/spreadsheets/d/<id>/…). */
  BACKLINK_SHEET_ID?: string;
}

export interface SheetRow {
  sheet_id: number;
  tab: string;
  resource: string;
  status: string;
  resource_url: string;
  submission_url: string;
  listing_url: string;
  checked: string;
  batch: string;
  note: string;
  first_seen: string;
  updated_at: string;
  status_changed_at: string;
}

export interface SheetChange { sheet_id: number; resource: string; from: string; to: string; at: string }
export interface SheetSync { tabs: number; rows: number; changed: SheetChange[]; error?: string }

export const SHEET_SQL = `CREATE TABLE IF NOT EXISTS sheet_backlinks (sheet_id INTEGER PRIMARY KEY, tab TEXT NOT NULL DEFAULT '', resource TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', resource_url TEXT NOT NULL DEFAULT '', submission_url TEXT NOT NULL DEFAULT '', listing_url TEXT NOT NULL DEFAULT '', checked TEXT NOT NULL DEFAULT '', batch TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', first_seen TEXT NOT NULL, updated_at TEXT NOT NULL, status_changed_at TEXT NOT NULL)`;

/** The order statuses are shown in; anything else sorts last. */
export const SHEET_STATUSES = ['live', 'submitted', 'todo', 'skip', 'rejected'];

export function sheetUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
}

/** A small RFC 4180 reader: quoted cells, doubled quotes, newlines inside quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Rows of one tab: the header row starts with "ID"; data rows have a numeric ID. Columns are found by header name. */
export function parseTab(rows: string[][], tab: string): Omit<SheetRow, 'first_seen' | 'updated_at' | 'status_changed_at'>[] {
  const h = rows.findIndex((r) => (r[0] ?? '').trim().toLowerCase() === 'id');
  if (h < 0) return [];
  const head = rows[h].map((c) => c.trim().toLowerCase());
  // Only the directory layout (ID | Resource | Status | ...) is a submissions tab; the Worker's own outreach export and
  // the Data Sources tab live in the same workbook and must not be read back as directories.
  if (!head.includes('resource') || !head.includes('status') || head.includes('pitch sent')) return [];
  const col = (...names: string[]) => {
    for (const n of names) {
      const exact = head.indexOf(n);
      if (exact >= 0) return exact;
    }
    for (const n of names) {
      const loose = head.findIndex((c) => c.startsWith(n));
      if (loose >= 0) return loose;
    }
    return -1;
  };
  const ci = {
    resource: col('resource'),
    status: col('status'),
    resource_url: col('resource url', 'url', 'website'),
    submission_url: col('submission url', 'submit url'),
    listing_url: col('listing url', 'live url'),
    checked: col('checked', 'date'),
    batch: col('batch'),
    note: col('result / next action', 'result', 'next action', 'notes', 'note'),
  };
  const out: Omit<SheetRow, 'first_seen' | 'updated_at' | 'status_changed_at'>[] = [];
  for (const r of rows.slice(h + 1)) {
    const id = Number((r[0] ?? '').trim());
    if (!Number.isInteger(id) || id <= 0) continue;
    const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    const resource = get(ci.resource);
    if (!resource) continue;
    out.push({
      sheet_id: id,
      tab,
      resource: resource.slice(0, 120),
      status: (get(ci.status).toLowerCase() || 'todo').slice(0, 30),
      resource_url: get(ci.resource_url).slice(0, 500),
      submission_url: get(ci.submission_url).slice(0, 500),
      listing_url: get(ci.listing_url).slice(0, 500),
      checked: get(ci.checked).slice(0, 40),
      batch: get(ci.batch).slice(0, 60),
      note: get(ci.note).slice(0, 600),
    });
  }
  return out;
}

/** The tabs of a public sheet, from its HTML view (name and gid of each). */
export async function listTabs(id: string): Promise<{ name: string; gid: string }[]> {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/htmlview`, { headers: { accept: 'text/html' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`sheet html view: ${res.status}`);
  const html = await res.text();
  const tabs: { name: string; gid: string }[] = [];
  for (const m of html.matchAll(/items\.push\(\{name: "((?:[^"\\]|\\.)*)",[^}]*?gid: "(\d+)"/g)) {
    tabs.push({ name: m[1].replace(/\\(.)/g, '$1').slice(0, 80), gid: m[2] });
  }
  return tabs;
}

async function fetchTab(id: string, gid: string): Promise<string> {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=csv&gid=${encodeURIComponent(gid)}`, { headers: { accept: 'text/csv' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`sheet tab ${gid}: ${res.status}`);
  return res.text();
}

/** Read every tab and upsert the rows; rows that left the sheet are removed once every tab was read without error. */
export async function syncSheet(env: SheetEnv): Promise<SheetSync> {
  const id = (env.BACKLINK_SHEET_ID ?? '').trim();
  if (!id) return { tabs: 0, rows: 0, changed: [], error: 'BACKLINK_SHEET_ID is not set' };
  await env.DB.prepare(SHEET_SQL).run();
  const tabs = await listTabs(id);
  const before = new Map((await env.DB.prepare('SELECT sheet_id, status, resource FROM sheet_backlinks').all<{ sheet_id: number; status: string; resource: string }>()).results.map((r) => [r.sheet_id, r]));
  const now = new Date().toISOString();
  const changed: SheetChange[] = [];
  const seen = new Set<number>();
  const stmts: D1PreparedStatement[] = [];
  let complete = true;
  for (const tab of tabs) {
    let rows: ReturnType<typeof parseTab>;
    try {
      rows = parseTab(parseCsv(await fetchTab(id, tab.gid)), tab.name);
    } catch (err) {
      console.error(`sheet tab "${tab.name}" failed: ${String(err)}`);
      complete = false;
      continue;
    }
    for (const r of rows) {
      if (seen.has(r.sheet_id)) continue;
      seen.add(r.sheet_id);
      const prev = before.get(r.sheet_id);
      if (!prev || prev.status !== r.status) changed.push({ sheet_id: r.sheet_id, resource: r.resource, from: prev?.status ?? '', to: r.status, at: now });
      stmts.push(
        env.DB.prepare(
          `INSERT INTO sheet_backlinks (sheet_id, tab, resource, status, resource_url, submission_url, listing_url, checked, batch, note, first_seen, updated_at, status_changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(sheet_id) DO UPDATE SET tab = excluded.tab, resource = excluded.resource, status = excluded.status, resource_url = excluded.resource_url,
             submission_url = excluded.submission_url, listing_url = excluded.listing_url, checked = excluded.checked, batch = excluded.batch, note = excluded.note,
             updated_at = excluded.updated_at,
             status_changed_at = CASE WHEN sheet_backlinks.status != excluded.status THEN excluded.updated_at ELSE sheet_backlinks.status_changed_at END`,
        ).bind(r.sheet_id, r.tab, r.resource, r.status, r.resource_url, r.submission_url, r.listing_url, r.checked, r.batch, r.note, now, now, now),
      );
    }
  }
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  if (complete && seen.size) {
    const gone = [...before.keys()].filter((k) => !seen.has(k));
    for (let i = 0; i < gone.length; i += 90) {
      const chunk = gone.slice(i, i + 90);
      await env.DB.prepare(`DELETE FROM sheet_backlinks WHERE sheet_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).run();
    }
  }
  const result: SheetSync = { tabs: tabs.length, rows: seen.size, changed, error: complete ? undefined : 'one or more tabs could not be read' };
  await setMeta(env.DB, 'sheet:last', JSON.stringify({ at: now, tabs: tabs.length, rows: seen.size, changed: changed.length, error: result.error ?? null }));
  return result;
}

export async function sheetCounts(env: SheetEnv): Promise<Record<string, number>> {
  await env.DB.prepare(SHEET_SQL).run();
  const r = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM sheet_backlinks GROUP BY status').all<{ status: string; n: number }>();
  const out: Record<string, number> = {};
  for (const row of r.results) out[row.status] = row.n;
  return out;
}

export async function sheetRows(env: SheetEnv): Promise<SheetRow[]> {
  await env.DB.prepare(SHEET_SQL).run();
  return (await env.DB.prepare('SELECT * FROM sheet_backlinks ORDER BY sheet_id').all<SheetRow>()).results;
}

/** Rows whose status changed (or that appeared) in the last `hours`. */
export async function sheetChanges(env: SheetEnv, hours = 24): Promise<SheetChange[]> {
  await env.DB.prepare(SHEET_SQL).run();
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = (await env.DB.prepare('SELECT sheet_id, resource, status, status_changed_at, first_seen FROM sheet_backlinks WHERE status_changed_at > ? ORDER BY status_changed_at DESC LIMIT 50').bind(since).all<{ sheet_id: number; resource: string; status: string; status_changed_at: string; first_seen: string }>()).results;
  return rows.map((r) => ({ sheet_id: r.sheet_id, resource: r.resource, from: r.first_seen === r.status_changed_at ? '' : '?', to: r.status, at: r.status_changed_at }));
}

export async function sheetLastSync(env: SheetEnv): Promise<{ at: string; tabs: number; rows: number; changed: number; error: string | null } | null> {
  const raw = await getMeta(env.DB, 'sheet:last');
  if (!raw) return null;
  try { return JSON.parse(raw) as { at: string; tabs: number; rows: number; changed: number; error: string | null }; } catch { return null; }
}

/** One line for the daily digest: counts by status and today's status changes. Empty when the sheet is not configured. */
export async function sheetDigestLine(env: SheetEnv): Promise<string> {
  if (!(env.BACKLINK_SHEET_ID ?? '').trim()) return '';
  const counts = await sheetCounts(env);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return '';
  const parts = SHEET_STATUSES.filter((s) => counts[s]).map((s) => `${counts[s]} ${s === 'todo' ? 'to do' : s === 'skip' ? 'skipped' : s}`);
  const changes = await sheetChanges(env, 24);
  const moved = changes.filter((c) => c.from !== '').slice(0, 8).map((c) => `${c.resource} → ${c.to}`);
  const added = changes.filter((c) => c.from === '').length;
  return `Directory sheet: ${parts.join(', ')} (${total} rows).${moved.length ? ` Changed today: ${moved.join('; ')}.` : ''}${added ? ` ${added} new row${added === 1 ? '' : 's'}.` : ''}`;
}

/** A read-only token for the CSV export the owner's sheet pulls with =IMPORTDATA, derived from STATS_KEY. */
export async function exportToken(statsKey: string): Promise<string> {
  if (!statsKey) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`backlinks-export:${statsKey}`));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
