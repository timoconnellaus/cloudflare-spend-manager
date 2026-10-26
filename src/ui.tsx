import type { FC } from "hono/jsx";
import type { Metric } from "./meters";
import type { Config, KillRow } from "./store";

type Props = {
  user: string;
  guard: string;
  config: Config;
  protectedKeys: Set<string>;
  readings: { resource: string; metric: string; value: number; limit: number; basis: string; ratio: number; updated_at: string }[];
  kills: KillRow[];
  events: { id: number; at: string; kind: string; message: string }[];
  declarations: { resource: string; metric: string; hourly_peak: number; note: string | null; created_at: string }[];
  metrics: Metric[];
  labels: Record<string, string>;
  emailBound: boolean;
};

const CSS = `
:root { --bg:#f6f7f9; --card:#fff; --text:#16181d; --muted:#626a77; --line:#e3e6eb; --accent:#2f6fde; --ok:#1f8a4c; --warn:#b26b00; --bad:#c62f2f; --chip:#eef1f5; }
@media (prefers-color-scheme: dark) { :root { --bg:#111317; --card:#1a1d23; --text:#e8eaee; --muted:#9aa2ae; --line:#2b3039; --accent:#6c9cf0; --ok:#4cc27e; --warn:#e0a03a; --bad:#ef6a6a; --chip:#252a33; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 20px 16px 60px; }
header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; margin-bottom:16px; }
h1 { font-size:20px; margin:0; } h2 { font-size:15px; margin:0 0 10px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; overflow-x:auto; }
.grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap:16px; }
.grid .card { margin-bottom:0; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; }
td.num, th.num { text-align:right; font-variant-numeric: tabular-nums; white-space:nowrap; }
.muted { color:var(--muted); } .small { font-size:12px; }
.chip { display:inline-block; padding:1px 8px; border-radius:999px; background:var(--chip); font-size:12px; white-space:nowrap; }
.chip.ok { color:var(--ok); } .chip.warn { color:var(--warn); } .chip.bad { color:var(--bad); }
.mode { font-weight:700; padding:4px 12px; border-radius:999px; }
.mode.armed { background:var(--bad); color:#fff; } .mode.dry { background:var(--warn); color:#fff; }
.bar { position:relative; height:6px; background:var(--chip); border-radius:3px; min-width:80px; }
.bar > span { position:absolute; inset:0 auto 0 0; border-radius:3px; background:var(--ok); }
.bar.warn > span { background:var(--warn); } .bar.bad > span { background:var(--bad); }
form.inline { display:inline; margin:0; }
button { font:inherit; padding:4px 10px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--text); cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; } button.danger { color:var(--bad); }
input, select { font:inherit; padding:5px 8px; border-radius:6px; border:1px solid var(--line); background:var(--bg); color:var(--text); max-width:100%; }
.row { display:flex; flex-wrap:wrap; gap:8px; align-items:end; } .row label { display:flex; flex-direction:column; gap:2px; font-size:12px; color:var(--muted); }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
.notice { border-left:3px solid var(--warn); padding:8px 12px; background:var(--card); margin-bottom:12px; border-radius:6px; }
`;

const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0));
const usd = (n: number) => `$${n.toFixed(2)}`;
const when = (s: string) => s.replace("T", " ").slice(0, 16);

const Post: FC<{ action: string; fields?: Record<string, string>; label: string; cls?: string; confirm?: string }> = (p) => (
  <form class="inline" method="post" action={p.action} onsubmit={p.confirm ? `return confirm(${JSON.stringify(p.confirm)})` : undefined}>
    {Object.entries(p.fields ?? {}).map(([k, v]) => <input type="hidden" name={k} value={v} />)}
    <button class={p.cls}>{p.label}</button>
  </form>
);

const Page: FC<{ title: string; children?: any }> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{CSS}</style>
    </head>
    <body>
      <main>{children}</main>
    </body>
  </html>
);

/** A resource's hourly record from the guard's own history, which outlives Cloudflare's analytics for deleted Workers. */
export const History: FC<{ resource: string; label: string; rows: { metric: string; hour: string; value: number }[]; known: Record<string, string> }> = (p) => {
  const byMetric = new Map<string, { metric: string; hour: string; value: number }[]>();
  for (const r of p.rows) byMetric.set(r.metric, [...(byMetric.get(r.metric) ?? []), r]);
  return (
    <Page title="Spend Guard history">
      <header>
        <div>
          <h1>{p.label}</h1>
          <div class="muted small"><a href="/">← Dashboard</a> · {p.resource} · hourly activity kept for 90 days, even after the resource is deleted</div>
        </div>
        <form method="get" action="/history" class="row">
          <input name="resource" list="known" value={p.resource} size={40} />
          <datalist id="known">{Object.entries(p.known).map(([k, v]) => <option value={k}>{v}</option>)}</datalist>
          <button>Show</button>
        </form>
      </header>
      {!p.rows.length && <p class="muted">No history recorded for this resource.</p>}
      {[...byMetric].map(([metric, rows]) => {
        const days = new Map<string, { total: number; peak: number; peakHour: string }>();
        for (const r of rows) {
          const d = days.get(r.hour.slice(0, 10)) ?? { total: 0, peak: 0, peakHour: "" };
          d.total += r.value;
          if (r.value >= d.peak) Object.assign(d, { peak: r.value, peakHour: r.hour.slice(11, 16) });
          days.set(r.hour.slice(0, 10), d);
        }
        const max = Math.max(...[...days.values()].map((d) => d.total), 1);
        return (
          <section class="card">
            <h2>{metric}</h2>
            <table>
              <thead><tr><th>Day</th><th class="num">Total</th><th></th><th class="num">Peak hour</th></tr></thead>
              <tbody>
                {[...days].reverse().map(([day, d]) => (
                  <tr><td>{day}</td><td class="num">{fmt(d.total)}</td><td style="width:40%"><div class="bar"><span style={`width:${((d.total / max) * 100).toFixed(0)}%`} /></div></td><td class="num">{fmt(d.peak)} at {d.peakHour}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </Page>
  );
};

export const Dashboard: FC<Props> = (p) => {
  const { config } = p;
  const label = (key: string) => p.labels[key] ?? key;
  const armed = config.mode === "armed";
  const summary = config.billingSummary;
  const families = summary ? Object.entries(summary.families).sort((a, b) => b[1].monthToDate - a[1].monthToDate) : [];
  const days = summary ? [...new Set(families.flatMap(([, f]) => Object.keys(f.days)))].sort().slice(-7) : [];
  const monthToDate = families.reduce((s, [, f]) => s + f.monthToDate, 0);
  const workers = config.snapshot?.workers ?? [];
  const buckets = [...new Set(workers.flatMap((w) => w.bindings.filter((b) => b.startsWith("r2:"))))].sort();
  const resources = [...new Set(p.readings.map((r) => r.resource))].sort();

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Spend Guard</title>
        <style>{CSS}</style>
      </head>
      <body>
        <main>
          <header>
            <div>
              <h1>Spend Guard</h1>
              <div class="muted small">Signed in as {p.user} · guarding everything except <code>{p.guard}</code></div>
            </div>
            <div class="row">
              <span class={`mode ${armed ? "armed" : "dry"}`}>{armed ? "ARMED" : "DRY-RUN"}</span>
              <Post
                action="/mode"
                fields={{ mode: armed ? "dry-run" : "armed" }}
                label={armed ? "Switch to dry-run" : "Arm the guard"}
                cls={armed ? undefined : "danger"}
                confirm={armed ? "Stop killing automatically?" : "Arm the guard? Unprotected resources over their limits will be stopped automatically."}
              />
              <Post action="/run/activity" label="Check activity now" />
              <Post action="/run/baselines" label="Refresh baselines" />
              <Post action="/run/billing" label="Check billing now" />
            </div>
          </header>

          {!armed && <div class="notice">Dry-run: breaches are logged and emailed as "would kill", but nothing is stopped. Arm the guard once the kill log looks right.</div>}
          {(!p.emailBound || !config.alertTo || !config.alertFrom) && <div class="notice">Email alerts are off: {!p.emailBound ? "the EMAIL binding is missing" : "set the alert addresses in Settings"}.</div>}
          {!config.snapshot && <div class="notice">No baselines yet. They are computed hourly, or press "Refresh baselines".</div>}

          <div class="grid">
            <section class="card">
              <h2>Billing (authoritative, 1–2 days behind)</h2>
              {summary ? (
                <>
                  <div class="small muted">
                    Period from {summary.period?.slice(0, 10)} · {usd(monthToDate)} of {usd(config.monthlyCap)} cap · checked {when(summary.checkedAt)}
                  </div>
                  <table>
                    <thead>
                      <tr><th>Product</th><th class="num">This period</th>{days.map((d) => <th class="num">{d.slice(5)}</th>)}</tr>
                    </thead>
                    <tbody>
                      {families.filter(([, f]) => f.monthToDate > 0 || Object.values(f.days).some((v) => v > 0)).map(([name, f]) => (
                        <tr><td>{name}</td><td class="num">{usd(f.monthToDate)}</td>{days.map((d) => <td class="num">{(f.days[d] ?? 0) > 0 ? usd(f.days[d]) : "·"}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : <p class="muted">Not checked yet.</p>}
            </section>

            <section class="card" id="kills">
              <h2>Kills</h2>
              {p.kills.length ? (
                <table>
                  <thead><tr><th>When</th><th>Target</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {p.kills.map((k) => (
                      <tr>
                        <td class="small">{when(k.at)}</td>
                        <td><div>{k.target}</div><div class="small muted">{JSON.parse(k.reasons).join("; ")}</div>{k.error && <div class="small" style="color:var(--bad)">{k.error}</div>}</td>
                        <td>{k.restored_at ? <span class="chip">{k.dry_run ? "dismissed" : "restored"}</span> : k.error ? <span class="chip bad">failed</span> : k.dry_run ? <span class="chip warn">would kill</span> : <span class="chip bad">stopped</span>}</td>
                        <td>{!k.restored_at && !k.error && <Post action={`/kills/${k.id}/undo`} label={k.dry_run ? "Dismiss" : "Undo"} confirm={k.dry_run ? undefined : `Restore ${k.target} to its previous version?`} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p class="muted">Nothing killed yet.</p>}
            </section>
          </div>

          <section class="card" style="margin-top:16px">
            <h2>Activity, last hour, against each resource's own limit</h2>
            <table>
              <thead><tr><th>Resource</th><th>Metric</th><th class="num">Last hour</th><th class="num">Limit</th><th></th><th>Basis</th></tr></thead>
              <tbody>
                {p.readings.slice(0, 30).map((r) => (
                  <tr>
                    <td><a href={`/history?resource=${encodeURIComponent(r.resource)}`}>{label(r.resource)}</a><div class="small muted">{r.resource.split(":")[0]}</div></td>
                    <td class="small">{r.metric}</td>
                    <td class="num">{fmt(r.value)}</td>
                    <td class="num">{fmt(r.limit)}</td>
                    <td><div class={`bar ${r.ratio > 1 ? "bad" : r.ratio > 0.6 ? "warn" : ""}`}><span style={`width:${Math.min(100, r.ratio * 100).toFixed(0)}%`} /></div></td>
                    <td><span class={`chip ${r.basis === "unbaselined" ? "warn" : ""}`}>{r.basis}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!p.readings.length && <p class="muted">No readings yet.</p>}
          </section>

          <section class="card" id="launches">
            <h2>Launches: register expected levels before new traffic</h2>
            <p class="small muted">A resource with less than {config.minHistoryHours} hours of history is held to a strict default. Register the hourly peak you expect and the guard allows {config.activityMultiplier}× that instead.</p>
            <form method="post" action="/declare" class="row">
              <label>Resource<input name="resource" list="resources" placeholder="workers:my-app" required /></label>
              <datalist id="resources">{[...resources, ...workers.map((w) => `workers:${w.name}`)].map((r) => <option value={r}>{label(r)}</option>)}</datalist>
              <label>Metric<select name="metric">{p.metrics.map((m) => <option value={m.key}>{m.key} ({m.unit})</option>)}</select></label>
              <label>Expected hourly peak<input name="hourlyPeak" type="number" min="1" step="any" required /></label>
              <label>Note<input name="note" placeholder="launch week" /></label>
              <button class="primary">Register</button>
            </form>
            {p.declarations.length > 0 && (
              <table style="margin-top:10px">
                <thead><tr><th>Resource</th><th>Metric</th><th class="num">Expected peak/hour</th><th>Note</th><th></th></tr></thead>
                <tbody>
                  {p.declarations.map((d) => (
                    <tr><td>{label(d.resource)}</td><td class="small">{d.metric}</td><td class="num">{fmt(d.hourly_peak)}</td><td class="small">{d.note}</td>
                      <td><Post action="/declare/delete" fields={{ resource: d.resource, metric: d.metric }} label="Remove" /></td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section class="card" id="workers">
            <h2>Workers and buckets</h2>
            <p class="small muted">Protected resources are alerted on but never stopped automatically. Workers running containers are always treated as protected.</p>
            <table>
              <thead><tr><th>Resource</th><th>Uses</th><th>Protection</th><th></th></tr></thead>
              <tbody>
                {[...workers.map((w) => ({ key: `workers:${w.name}`, uses: w.bindings.length, containers: w.hasContainers })), ...buckets.map((b) => ({ key: b, uses: 0, containers: false }))].map((r) => {
                  const isGuard = r.key === `workers:${p.guard}`;
                  const prot = p.protectedKeys.has(r.key);
                  return (
                    <tr>
                      <td>{r.key}</td>
                      <td class="small muted">{r.uses ? `${r.uses} bindings` : ""}</td>
                      <td>
                        {isGuard ? <span class="chip ok">the guard</span> : r.containers ? <span class="chip">containers</span> : null}{" "}
                        {!isGuard && <Post action="/protect" fields={{ key: r.key, on: prot ? "0" : "1" }} label={prot ? "Protected ✓" : "Protect"} cls={prot ? "primary" : undefined} />}
                      </td>
                      <td>{!isGuard && <Post action="/kill" fields={{ target: r.key }} label="Kill now" cls="danger" confirm={`Stop ${r.key} now? You can undo it from the Kills list.`} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <div class="grid">
            <section class="card">
              <h2>Settings</h2>
              <form method="post" action="/settings" class="row">
                <label>Alerts to<input name="alertTo" type="email" value={config.alertTo ?? ""} /></label>
                <label>Alerts from<input name="alertFrom" type="email" value={config.alertFrom ?? ""} placeholder="guard@your-domain" /></label>
                <label>Activity × peak<input name="activityMultiplier" type="number" step="any" value={String(config.activityMultiplier)} /></label>
                <label>Billing × best day<input name="billingMultiplier" type="number" step="any" value={String(config.billingMultiplier)} /></label>
                <label>Daily floor $<input name="dailyFloor" type="number" step="any" value={String(config.dailyFloor)} /></label>
                <label>Monthly cap $<input name="monthlyCap" type="number" step="any" value={String(config.monthlyCap)} /></label>
                <button class="primary">Save</button>
              </form>
            </section>

            <section class="card">
              <h2>Events</h2>
              <table>
                <tbody>
                  {p.events.map((e) => (
                    <tr><td class="small muted" style="white-space:nowrap">{when(e.at)}</td><td><span class={`chip ${e.kind === "error" || e.kind === "killed" ? "bad" : e.kind === "would-kill" ? "warn" : ""}`}>{e.kind}</span></td><td class="small">{e.message}</td></tr>
                  ))}
                </tbody>
              </table>
              {!p.events.length && <p class="muted">No events yet.</p>}
            </section>
          </div>
        </main>
      </body>
    </html>
  );
};
