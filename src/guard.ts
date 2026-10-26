import { judge } from "./baseline";
import { tripwire, type UsageRow } from "./billing";
import { CloudflareApi, inventory, labels, restore, setR2PublicAccess, stubKill, type InventoryWorker, type KillRecord } from "./cloudflare";
import { sendEmail } from "./email";
import { METRICS, measure } from "./meters";
import { keyOf, plan, type Breach, type KillTarget } from "./policy";
import { Store, type Config, type KillRow } from "./store";

export type Env = {
  DB: D1Database;
  EMAIL?: SendEmail;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  /** This Worker's own script name; the guard never kills itself. */
  GUARD_SCRIPT: string;
  /** Base URL of the dashboard, for links in emails. */
  PUBLIC_URL?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
};

const HOUR = 3600_000;
/** GraphQL Analytics lags by a few minutes; reading up to now would undercount the latest hour. */
const ANALYTICS_LAG = 5 * 60_000;
const BASELINE_DAYS = 7;

const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0));

const services = (env: Env) => ({ api: new CloudflareApi(env.CF_API_TOKEN, env.CF_ACCOUNT_ID), store: new Store(env.DB) });

/** Every 5 minutes: compares each resource's last hour of activity against its own baseline. */
export async function checkActivity(env: Env) {
  const { api, store } = services(env);
  const end = new Date(Date.now() - ANALYTICS_LAG);
  const [samples, config, baselines, declarations] = await Promise.all([
    measure(api.gql, api.accountId, new Date(end.getTime() - HOUR), end),
    store.config(),
    store.baselines(),
    store.declarations(),
  ]);

  const readings = [];
  const breaches: Breach[] = [];
  for (const s of samples) {
    const metric = METRICS.find((m) => m.key === s.metric)!;
    const resource = keyOf({ product: s.product, id: s.id });
    const k = `${resource}|${s.metric}`;
    const verdict = judge(s.value, baselines.get(k), declarations.get(k), metric.floor, {
      multiplier: config.activityMultiplier,
      minHistoryHours: config.minHistoryHours,
    });
    readings.push({ resource, metric: s.metric, value: s.value, limit: verdict.limit, basis: verdict.basis });
    if (verdict.breached) {
      breaches.push({
        resource: { product: s.product, id: s.id },
        reason: `${resource} ${metric.unit}: ${fmt(s.value)} in the last hour, over its ${verdict.basis} limit of ${fmt(verdict.limit)}`,
      });
    }
  }
  await store.replaceReadings(readings);
  await act(env, breaches, "activity");
}

/** Hourly: each resource's highest hourly total over the past week, and how long it has been observed. */
export async function refreshBaselines(env: Env) {
  const { api, store } = services(env);
  const now = Date.now();
  const end = new Date(Math.floor(now / HOUR) * HOUR);
  const days = await Promise.all(
    Array.from({ length: BASELINE_DAYS }, (_, i) =>
      measure(api.gql, api.accountId, new Date(end.getTime() - (i + 1) * 24 * HOUR), new Date(end.getTime() - i * 24 * HOUR), true),
    ),
  );
  const stats = new Map<string, { resource: string; metric: string; peak: number; first: number }>();
  for (const s of days.flat()) {
    const resource = keyOf({ product: s.product, id: s.id });
    const k = `${resource}|${s.metric}`;
    const hour = Date.parse(s.hour!);
    const cur = stats.get(k) ?? { resource, metric: s.metric, peak: 0, first: hour };
    cur.peak = Math.max(cur.peak, s.value);
    cur.first = Math.min(cur.first, hour);
    stats.set(k, cur);
  }
  await store.replaceBaselines([...stats.values()].map((s) => ({ ...s, hours: Math.floor((end.getTime() - s.first) / HOUR) })));

  const [workers, names] = await Promise.all([inventory(api), labels(api)]);
  await store.setConfig({
    snapshot: {
      takenAt: new Date().toISOString(),
      labels: names,
      workers: workers.map((w) => ({ name: w.name, hasContainers: w.hasContainers, bindings: w.bindings.map(keyOf) })),
    },
  });
}

/** Hourly: the Billable Usage API is authoritative but lags a day or two; it caught the 2026-10 incident when GraphQL could not. */
export async function checkBilling(env: Env) {
  const { api, store } = services(env);
  const [rows, config] = await Promise.all([api.request<UsageRow[]>("/billable-usage"), store.config()]);
  const breaches = tripwire(rows, { multiplier: config.billingMultiplier, dailyFloor: config.dailyFloor, monthlyCap: config.monthlyCap });

  const period = rows.map((r) => r.BillingPeriodStart).filter(Boolean).sort().at(-1);
  const byFamily = new Map<string, { monthToDate: number; days: Record<string, number> }>();
  for (const r of rows) {
    const f = byFamily.get(r.ServiceFamilyName) ?? { monthToDate: 0, days: {} };
    if (r.BillingPeriodStart === period) f.monthToDate += r.ContractedCost;
    const day = r.ChargePeriodStart.slice(0, 10);
    f.days[day] = (f.days[day] ?? 0) + r.ContractedCost;
    byFamily.set(r.ServiceFamilyName, f);
  }
  await store.setConfig({ billingSummary: { period, checkedAt: new Date().toISOString(), families: Object.fromEntries(byFamily) } });
  await act(env, breaches, "billing");
}

/** Turns breaches into kills and alerts, honouring dry-run mode, then emails anything new. */
async function act(env: Env, breaches: Breach[], source: "activity" | "billing") {
  if (!breaches.length) return;
  const { api, store } = services(env);
  const [config, protectedKeys, workers] = await Promise.all([store.config(), store.protectedKeys(), inventory(api)]);
  for (const w of workers) if (w.hasContainers) protectedKeys.add(`workers:${w.name}`);

  const result = plan(breaches, { workers }, { protectedKeys, guardScript: env.GUARD_SCRIPT });
  const news: string[] = [];

  for (const { target, reasons } of result.kills) {
    const key = `${target.product}:${target.id}`;
    if (await store.activeKill(key)) continue;
    if (config.mode === "dry-run") {
      if (await store.event("would-kill", `[${source}] would kill ${key}: ${reasons.join("; ")}`, `would-kill:${key}`, 24)) {
        await store.recordKill(key, reasons, true, undefined);
        news.push(`WOULD KILL (dry-run) ${key}\n  ${reasons.join("\n  ")}`);
      }
      continue;
    }
    try {
      const record = await killTarget(api, target, workers);
      await store.recordKill(key, reasons, false, record);
      await store.event("killed", `[${source}] killed ${key}: ${reasons.join("; ")}`);
      news.push(`KILLED ${key}\n  ${reasons.join("\n  ")}`);
    } catch (e) {
      await store.recordKill(key, reasons, false, undefined, String(e));
      await store.event("kill-failed", `[${source}] failed to kill ${key}: ${e}`);
      news.push(`FAILED TO KILL ${key}: ${e}\n  ${reasons.join("\n  ")}`);
    }
  }

  for (const alert of result.alerts) {
    const key = keyOf(alert.resource);
    if (await store.event(alert.kind, `[${source}] ${alert.message}`, `${alert.kind}:${key}`)) {
      news.push(`ALERT (${alert.kind}) ${key}\n  ${alert.message}`);
    }
  }

  await notify(env, config, news);
}

async function killTarget(api: CloudflareApi, target: KillTarget, workers: InventoryWorker[]) {
  if (target.product === "r2") return { bucket: target.id, wasEnabled: await setR2PublicAccess(api, target.id, false) };
  const worker = workers.find((w) => w.name === target.id);
  if (!worker) throw new Error(`no Worker named ${target.id}`);
  return stubKill(api, worker);
}

/** A kill from the dashboard; unlike automatic kills it also applies to protected resources. */
export async function manualKill(env: Env, target: string, by: string) {
  const { api, store } = services(env);
  const [product, id] = target.split(/:(.*)/s) as ["workers" | "r2", string];
  if (await store.activeKill(target)) throw new Error(`${target} is already killed`);
  const record = await killTarget(api, { product, id }, await inventory(api));
  await store.recordKill(target, [`manual kill by ${by}`], false, record);
  await store.event("killed", `${by} killed ${target} from the dashboard`);
}

export async function undoKill(env: Env, row: KillRow, by: string) {
  const { api, store } = services(env);
  if (!row.dry_run && row.record) {
    const record = JSON.parse(row.record);
    if (row.target.startsWith("r2:")) await setR2PublicAccess(api, record.bucket, record.wasEnabled);
    else await restore(api, record as KillRecord);
  }
  await store.markRestored(row.id);
  await store.event("restored", `${by} restored ${row.target}${row.target.startsWith("workers:") ? "; Durable Objects take about 5 minutes to switch back" : ""}`);
}

async function notify(env: Env, config: Config, news: string[]) {
  if (!news.length || !env.EMAIL || !config.alertTo || !config.alertFrom) return;
  const subject = news.some((n) => n.startsWith("KILLED"))
    ? `spend-guard killed ${news.filter((n) => n.startsWith("KILLED")).length} resource(s)`
    : `spend-guard: ${news.length} new alert(s)`;
  const body = [
    ...news,
    "",
    config.mode === "dry-run" ? "The guard is in dry-run mode: nothing was actually stopped." : "Undo any kill from the dashboard.",
    env.PUBLIC_URL ?? "",
  ].join("\n\n");
  await sendEmail(env.EMAIL, config.alertFrom, config.alertTo, subject, body);
}
