/**
 * The articles the site shows: the ones bundled with the Worker (src/blog/posts, listed in ./index.ts) plus the ones
 * written on the live site by the article pipeline (src/articles.ts) and published from the blog_posts table. A
 * published table row with the same slug as a bundled article replaces it, so an old guide can be revised without
 * a deploy. Reads are cached per isolate for a minute; the pipeline calls invalidatePosts() after every change.
 */
import { POSTS } from './index';
import type { BlogPost } from './types';

export type ArticleStatus = 'queued' | 'drafting' | 'draft' | 'published' | 'failed';
export type ArticleKind = 'dosage' | 'comparison' | 'best' | 'guide';
export const ARTICLE_KINDS: readonly ArticleKind[] = ['dosage', 'comparison', 'best', 'guide'];

export interface ArticleRow {
  id: number;
  slug: string;
  status: ArticleStatus;
  kind: ArticleKind;
  /** What was asked for ("berberine dosage", "magnesium vs zinc for sleep"). */
  topic: string;
  /** Change requests from the owner waiting for the next drafting round. */
  notes: string;
  /** The live article (status published). */
  post_json: string;
  /** The latest draft waiting for review (empty once published and unchanged). */
  draft_json: string;
  issues_json: string;
  /** Secret in the review links sent by email; the owner key works as well. */
  token: string;
  attempts: number;
  error: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CACHE_MS = 60_000;
let cache: { at: number; posts: BlogPost[] } | null = null;

export function invalidatePosts(): void {
  cache = null;
}

export function parsePost(json: string): BlogPost | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as BlogPost;
    return p && typeof p.slug === 'string' && typeof p.html === 'string' ? p : null;
  } catch {
    return null;
  }
}

/** Published rows from the table, newest first. */
export async function publishedRows(db: D1Database): Promise<ArticleRow[]> {
  const { results } = await db.prepare("SELECT * FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC").all<ArticleRow>();
  return results;
}

/** Every live article, newest first: table rows first for a slug both have. */
export async function allPosts(db: D1Database): Promise<BlogPost[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.posts;
  let fromDb: BlogPost[] = [];
  try {
    fromDb = (await publishedRows(db)).map((r) => parsePost(r.post_json)).filter((p): p is BlogPost => !!p);
  } catch (err) {
    console.error(`blog_posts unavailable, bundled articles only: ${String(err)}`);
  }
  const seen = new Set(fromDb.map((p) => p.slug));
  const posts = [...fromDb, ...POSTS.filter((p) => !seen.has(p.slug))].sort((a, b) => b.date.localeCompare(a.date));
  cache = { at: Date.now(), posts };
  return posts;
}

export async function findPost(db: D1Database, slug: string): Promise<BlogPost | undefined> {
  return (await allPosts(db)).find((p) => p.slug === slug);
}

export async function getArticleRow(db: D1Database, slug: string): Promise<ArticleRow | null> {
  return db.prepare('SELECT * FROM blog_posts WHERE slug = ?').bind(slug).first<ArticleRow>();
}

export async function listArticleRows(db: D1Database, limit = 100): Promise<ArticleRow[]> {
  const { results } = await db.prepare('SELECT * FROM blog_posts ORDER BY updated_at DESC LIMIT ?').bind(limit).all<ArticleRow>();
  return results;
}
