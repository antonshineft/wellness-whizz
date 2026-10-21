-- Supplements: replaces the Webflow "Supplements" CMS collection.
CREATE TABLE IF NOT EXISTS supplements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,          -- normalised name used to match recommendations to existing rows
  category TEXT NOT NULL DEFAULT 'Other',
  form_type TEXT NOT NULL DEFAULT 'capsule',       -- capsule | softgel | small_softgel | tablet | powder | gummy | bar | drops
  fda_status TEXT NOT NULL DEFAULT 'probably_ok',  -- approved | probably_ok | not_approved
  safety_status TEXT NOT NULL DEFAULT 'safe',      -- safe | ok | not_safe | prescription
  effectivity INTEGER NOT NULL DEFAULT 3,          -- 1..5
  safety INTEGER NOT NULL DEFAULT 3,               -- 1..5
  summary TEXT NOT NULL DEFAULT '',
  benefits_html TEXT NOT NULL DEFAULT '',
  contraindications_html TEXT NOT NULL DEFAULT '',
  enhancing_html TEXT NOT NULL DEFAULT '',
  interactions_html TEXT NOT NULL DEFAULT '',
  why_consider TEXT NOT NULL DEFAULT '',
  holistic_html TEXT NOT NULL DEFAULT '',
  studies_html TEXT NOT NULL DEFAULT '',
  products_json TEXT NOT NULL DEFAULT '[]',        -- [{"name","brand","url","image"}]
  source TEXT NOT NULL DEFAULT 'cms',              -- cms (imported/seeded) | ai (created by the quiz pipeline)
  image TEXT NOT NULL DEFAULT '',                  -- generated illustration path for supplements without product photos
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generated illustrations (small WebP files) served from /images/generated/<key>.webp.
CREATE TABLE IF NOT EXISTS images (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions: one row per quiz submission (replaces the Webflow "Results" collection + Make scenario state).
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  sex TEXT NOT NULL,
  age TEXT NOT NULL,
  activity TEXT NOT NULL,
  diet TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | ready | failed
  error TEXT,
  ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_ip_created ON sessions(ip_hash, created_at);

-- Funnel measurement: page views, quiz views and outbound (shop) clicks. No personal data beyond a hashed IP.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL,                 -- home_view | quiz_view | result_view | supplement_view | outbound_click
  slug TEXT,                          -- supplement slug, when applicable
  product TEXT,                       -- product name, for outbound clicks
  page TEXT,                          -- path the event happened on
  referrer TEXT,                      -- external referrer host for views
  target TEXT,                        -- destination host for outbound clicks
  session_id TEXT,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);

-- Bookkeeping, e.g. which version of the bundled data/*.json has been loaded.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The 5 supplements recommended for a session, with the personalised reason shown on the card.
CREATE TABLE IF NOT EXISTS session_supplements (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  supplement_id INTEGER NOT NULL REFERENCES supplements(id),
  reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, position)
);

-- Email capture: "email me my results" on the result page and the newsletter box on the blog.
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'newsletter',     -- results | newsletter
  session_id TEXT,                               -- the result page they asked to receive, if any
  ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_sent_at TEXT,
  unsubscribed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_subscribers_created ON subscribers(created_at);

-- Social posting queue (X for now): what to post, when, and what happened.
CREATE TABLE IF NOT EXISTS social_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL DEFAULT 'x',
  kind TEXT NOT NULL,                              -- article | fact | research
  ref TEXT NOT NULL DEFAULT '',                    -- slug / pmid the post is about
  thread_json TEXT NOT NULL,                       -- JSON array of tweet texts (1 = single post)
  status TEXT NOT NULL DEFAULT 'queued',           -- queued | posted | failed | skipped
  scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
  posted_at TEXT,
  external_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_social_status ON social_posts(status, scheduled_at);

-- Research notes: new trials and reviews found on PubMed for catalogue supplements, summarised in plain language.
CREATE TABLE IF NOT EXISTS research_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pmid TEXT NOT NULL UNIQUE,
  supplement_id INTEGER NOT NULL REFERENCES supplements(id),
  title TEXT NOT NULL,
  journal TEXT NOT NULL DEFAULT '',
  pub_date TEXT NOT NULL DEFAULT '',
  pub_type TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  takeaway TEXT NOT NULL DEFAULT '',
  tweet TEXT NOT NULL DEFAULT '',
  queued INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_research_created ON research_notes(created_at);

-- Reddit digest (src/reddit.ts): every F5Bot mention received by the email handler, the threads already suggested,
-- and the keywords F5Bot capped on a given day.
CREATE TABLE IF NOT EXISTS reddit_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  message_id TEXT,
  keyword TEXT NOT NULL,
  subreddit TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  post_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reddit_mentions_received ON reddit_mentions(received_at);
CREATE INDEX IF NOT EXISTS reddit_mentions_post ON reddit_mentions(post_id);
CREATE TABLE IF NOT EXISTS reddit_used (
  post_id TEXT PRIMARY KEY,
  used_at TEXT NOT NULL,
  note TEXT
);
-- Screening scores (0-3) per thread, written by the hourly cron so the morning digest has little left to score.
CREATE TABLE IF NOT EXISTS reddit_scores (
  post_id TEXT PRIMARY KEY,
  score INTEGER NOT NULL,
  scored_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reddit_limits (
  day TEXT NOT NULL,
  keyword TEXT NOT NULL,
  PRIMARY KEY (day, keyword)
);

-- Articles written on the live site by the article pipeline (src/articles.ts); published rows join the bundled posts.
CREATE TABLE IF NOT EXISTS blog_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'guide',
  topic TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  post_json TEXT NOT NULL DEFAULT '',
  draft_json TEXT NOT NULL DEFAULT '',
  issues_json TEXT NOT NULL DEFAULT '[]',
  token TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS blog_posts_status ON blog_posts(status);

-- Translated supplement pages and articles for the Spanish site (src/translate.ts).
CREATE TABLE IF NOT EXISTS translations (
  lang TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  json TEXT NOT NULL,
  source_hash TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (lang, kind, ref)
);

-- Shelf scans (src/shelf.ts): the analysis of the photographed bottles; the photos themselves are never stored.
CREATE TABLE IF NOT EXISTS shelf_scans (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  lang TEXT NOT NULL DEFAULT 'en',
  goal TEXT NOT NULL DEFAULT '',
  ip_hash TEXT,
  products INTEGER NOT NULL DEFAULT 0,
  analysis_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shelf_scans_created ON shelf_scans(created_at);

-- TikTok posting (src/tiktok.ts): the connected account's tokens and the posts sent through the API.
CREATE TABLE IF NOT EXISTS tiktok_auth (id INTEGER PRIMARY KEY CHECK (id = 1), open_id TEXT NOT NULL, access_token TEXT NOT NULL, access_expires_at TEXT NOT NULL, refresh_token TEXT NOT NULL, refresh_expires_at TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', display_name TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tiktok_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, publish_id TEXT NOT NULL, title TEXT NOT NULL, privacy TEXT NOT NULL, status TEXT NOT NULL, fail_reason TEXT NOT NULL DEFAULT '', post_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

-- Short videos per article (src/videos.ts): queue, script, render state and the posted TikTok id.
CREATE TABLE IF NOT EXISTS videos (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, status TEXT NOT NULL, script_json TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '', video_url TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0, set_index INTEGER NOT NULL DEFAULT 0, publish_id TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, rendered_at TEXT);

-- Backlink outreach (src/backlinks.ts): prospects, what happened to each, and the directory checklist.
CREATE TABLE IF NOT EXISTS link_prospects (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL UNIQUE, url TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'other', title TEXT NOT NULL DEFAULT '', why TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT 'en', score INTEGER NOT NULL DEFAULT 0, contact_email TEXT NOT NULL DEFAULT '', contact_name TEXT NOT NULL DEFAULT '', contact_url TEXT NOT NULL DEFAULT '', asset TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new', approved INTEGER NOT NULL DEFAULT 0, draft_subject TEXT NOT NULL DEFAULT '', draft_body TEXT NOT NULL DEFAULT '', sent_at TEXT, followup_at TEXT, replied_at TEXT, won_url TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS link_prospects_status ON link_prospects(status);
CREATE TABLE IF NOT EXISTS link_events (id INTEGER PRIMARY KEY AUTOINCREMENT, prospect_id INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS directory_submissions (name TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'todo', url TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
-- The owner's Google Sheet of directory submissions, one row per sheet ID (src/sheet.ts).
CREATE TABLE IF NOT EXISTS sheet_backlinks (sheet_id INTEGER PRIMARY KEY, tab TEXT NOT NULL DEFAULT '', resource TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', resource_url TEXT NOT NULL DEFAULT '', submission_url TEXT NOT NULL DEFAULT '', listing_url TEXT NOT NULL DEFAULT '', checked TEXT NOT NULL DEFAULT '', batch TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', first_seen TEXT NOT NULL, updated_at TEXT NOT NULL, status_changed_at TEXT NOT NULL);
