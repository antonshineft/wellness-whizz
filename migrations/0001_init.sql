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
