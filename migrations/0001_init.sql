-- Key/value settings: mode, alert addresses, thresholds. Values are JSON.
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Resources the guard alerts on but never kills automatically. key = "<product>:<id>".
CREATE TABLE protected (key TEXT PRIMARY KEY, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- Expected hourly peaks registered for a launch, used instead of a learned baseline.
CREATE TABLE declarations (
  resource TEXT NOT NULL,
  metric TEXT NOT NULL,
  hourly_peak REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (resource, metric)
);

-- Learned baselines, refreshed hourly from a week of GraphQL history.
CREATE TABLE baselines (
  resource TEXT NOT NULL,
  metric TEXT NOT NULL,
  peak REAL NOT NULL,
  hours INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (resource, metric)
);

-- Latest reading of every resource and metric, for the dashboard.
CREATE TABLE readings (
  resource TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  "limit" REAL NOT NULL,
  basis TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (resource, metric)
);

-- Every kill, real or dry-run, with what is needed to undo it.
CREATE TABLE kills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  target TEXT NOT NULL,
  reasons TEXT NOT NULL,
  dry_run INTEGER NOT NULL,
  record TEXT,
  error TEXT,
  restored_at TEXT
);
CREATE INDEX kills_target ON kills (target, restored_at);

-- Alerts and notable events, newest first on the dashboard. dedupe_key suppresses repeats.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  dedupe_key TEXT
);
CREATE INDEX events_dedupe ON events (dedupe_key, at);
