import type { Baseline } from "./baseline";

export type Mode = "dry-run" | "armed";

export type Config = {
  mode: Mode;
  alertTo: string | null;
  alertFrom: string | null;
  activityMultiplier: number;
  minHistoryHours: number;
  billingMultiplier: number;
  dailyFloor: number;
  monthlyCap: number;
  /** Written by the hourly billing check for the dashboard. */
  billingSummary?: BillingSummary;
  /** Written hourly so the dashboard need not call the API on every page load. */
  snapshot?: Snapshot;
};

export type Snapshot = {
  takenAt: string;
  labels: Record<string, string>;
  workers: { name: string; hasContainers: boolean; bindings: string[] }[];
};

export type BillingSummary = {
  period: string | undefined;
  checkedAt: string;
  families: Record<string, { monthToDate: number; days: Record<string, number> }>;
};

export const DEFAULT_CONFIG: Config = {
  mode: "dry-run",
  alertTo: null,
  alertFrom: null,
  activityMultiplier: 3,
  minHistoryHours: 72,
  billingMultiplier: 3,
  dailyFloor: 25,
  monthlyCap: 300,
};

export class Store {
  constructor(private db: D1Database) {}

  async config(): Promise<Config> {
    const { results } = await this.db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
    const stored = Object.fromEntries(results.map((r) => [r.key, JSON.parse(r.value)]));
    return { ...DEFAULT_CONFIG, ...stored };
  }

  async setConfig(patch: Partial<Config>) {
    const stmt = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    await this.db.batch(Object.entries(patch).map(([k, v]) => stmt.bind(k, JSON.stringify(v))));
  }

  async protectedKeys(): Promise<Set<string>> {
    const { results } = await this.db.prepare("SELECT key FROM protected").all<{ key: string }>();
    return new Set(results.map((r) => r.key));
  }

  async setProtected(key: string, on: boolean, note?: string) {
    if (on) await this.db.prepare("INSERT OR IGNORE INTO protected (key, note) VALUES (?, ?)").bind(key, note ?? null).run();
    else await this.db.prepare("DELETE FROM protected WHERE key = ?").bind(key).run();
  }

  async declarations(): Promise<Map<string, number>> {
    const { results } = await this.db.prepare("SELECT resource, metric, hourly_peak FROM declarations").all<{ resource: string; metric: string; hourly_peak: number }>();
    return new Map(results.map((r) => [`${r.resource}|${r.metric}`, r.hourly_peak]));
  }

  async listDeclarations() {
    return (await this.db.prepare("SELECT * FROM declarations ORDER BY created_at DESC").all<{ resource: string; metric: string; hourly_peak: number; note: string | null; created_at: string }>()).results;
  }

  async declare(resource: string, metric: string, hourlyPeak: number, note?: string) {
    await this.db
      .prepare("INSERT INTO declarations (resource, metric, hourly_peak, note) VALUES (?, ?, ?, ?) ON CONFLICT (resource, metric) DO UPDATE SET hourly_peak = excluded.hourly_peak, note = excluded.note")
      .bind(resource, metric, hourlyPeak, note ?? null)
      .run();
  }

  async undeclare(resource: string, metric: string) {
    await this.db.prepare("DELETE FROM declarations WHERE resource = ? AND metric = ?").bind(resource, metric).run();
  }

  async baselines(): Promise<Map<string, Baseline>> {
    const { results } = await this.db.prepare("SELECT resource, metric, peak, hours FROM baselines").all<{ resource: string; metric: string; peak: number; hours: number }>();
    return new Map(results.map((r) => [`${r.resource}|${r.metric}`, { peak: r.peak, hours: r.hours }]));
  }

  async replaceBaselines(rows: { resource: string; metric: string; peak: number; hours: number }[]) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare("INSERT INTO baselines (resource, metric, peak, hours, updated_at) VALUES (?, ?, ?, ?, ?)");
    await this.db.batch([this.db.prepare("DELETE FROM baselines"), ...rows.map((r) => stmt.bind(r.resource, r.metric, r.peak, r.hours, now))]);
  }

  async replaceReadings(rows: { resource: string; metric: string; value: number; limit: number; basis: string }[]) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`INSERT INTO readings (resource, metric, value, "limit", basis, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
    await this.db.batch([this.db.prepare("DELETE FROM readings"), ...rows.map((r) => stmt.bind(r.resource, r.metric, r.value, r.limit, r.basis, now))]);
  }

  async readings() {
    return (await this.db.prepare(`SELECT *, value / "limit" AS ratio FROM readings ORDER BY ratio DESC`).all<{ resource: string; metric: string; value: number; limit: number; basis: string; ratio: number; updated_at: string }>()).results;
  }

  /** The newest kill of a target that has not been restored, if any. */
  async activeKill(target: string) {
    return this.db.prepare("SELECT * FROM kills WHERE target = ? AND restored_at IS NULL ORDER BY id DESC LIMIT 1").bind(target).first<KillRow>();
  }

  async recordKill(target: string, reasons: string[], dryRun: boolean, record: unknown, error?: string) {
    await this.db
      .prepare("INSERT INTO kills (target, reasons, dry_run, record, error) VALUES (?, ?, ?, ?, ?)")
      .bind(target, JSON.stringify(reasons), dryRun ? 1 : 0, record === undefined ? null : JSON.stringify(record), error ?? null)
      .run();
  }

  async kill(id: number) {
    return this.db.prepare("SELECT * FROM kills WHERE id = ?").bind(id).first<KillRow>();
  }

  async markRestored(id: number) {
    await this.db.prepare("UPDATE kills SET restored_at = datetime('now') WHERE id = ?").bind(id).run();
  }

  async kills(limit = 50) {
    return (await this.db.prepare("SELECT * FROM kills ORDER BY id DESC LIMIT ?").bind(limit).all<KillRow>()).results;
  }

  /** Logs an event unless the same dedupe key was logged within the window; returns whether it was new. */
  async event(kind: string, message: string, dedupeKey?: string, windowHours = 6): Promise<boolean> {
    if (dedupeKey) {
      const seen = await this.db
        .prepare("SELECT 1 FROM events WHERE dedupe_key = ? AND at > datetime('now', ?)")
        .bind(dedupeKey, `-${windowHours} hours`)
        .first();
      if (seen) return false;
    }
    await this.db.prepare("INSERT INTO events (kind, message, dedupe_key) VALUES (?, ?, ?)").bind(kind, message, dedupeKey ?? null).run();
    return true;
  }

  async events(limit = 50) {
    return (await this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").bind(limit).all<{ id: number; at: string; kind: string; message: string }>()).results;
  }
}

export type KillRow = {
  id: number;
  at: string;
  target: string;
  reasons: string;
  dry_run: number;
  record: string | null;
  error: string | null;
  restored_at: string | null;
};
