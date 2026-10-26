-- The guard's own record of hourly activity. Cloudflare drops a Worker's analytics when it is deleted;
-- this keeps the evidence (and the baselines built from it) for 90 days regardless.
CREATE TABLE history (
  resource TEXT NOT NULL,
  metric TEXT NOT NULL,
  hour TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (resource, metric, hour)
);
CREATE INDEX history_hour ON history (hour);

-- Readable names for opaque ids, kept after the resource is deleted.
CREATE TABLE labels (resource TEXT PRIMARY KEY, label TEXT NOT NULL, last_seen TEXT NOT NULL);
