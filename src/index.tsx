import { Hono } from "hono";
import { accessEmail } from "./access";
import { checkActivity, checkBilling, manualKill, refreshBaselines, undoKill, type Env } from "./guard";
import { METRICS } from "./meters";
import { Store } from "./store";
import { Dashboard } from "./ui";

type Vars = { user: string };

const app = new Hono<{ Bindings: Env & { LOCAL_DEV?: string }; Variables: Vars }>();

app.use("*", async (c, next) => {
  let user: string | null = null;
  if (c.env.LOCAL_DEV === "1") user = "local-dev";
  else if (c.env.ACCESS_TEAM_DOMAIN && c.env.ACCESS_AUD) user = await accessEmail(c.req.raw, c.env.ACCESS_TEAM_DOMAIN, c.env.ACCESS_AUD);
  else return c.text("Cloudflare Access is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD.", 503);
  if (!user) return c.text("Forbidden", 403);
  if (c.req.method === "POST" && c.req.header("origin") !== new URL(c.req.url).origin) return c.text("Bad origin", 403);
  c.set("user", user);
  await next();
});

app.get("/", async (c) => {
  const store = new Store(c.env.DB);
  const [config, protectedKeys, readings, kills, events, declarations] = await Promise.all([
    store.config(),
    store.protectedKeys(),
    store.readings(),
    store.kills(),
    store.events(),
    store.listDeclarations(),
  ]);
  return c.html(
    <Dashboard
      user={c.get("user")}
      guard={c.env.GUARD_SCRIPT}
      config={config}
      protectedKeys={protectedKeys}
      readings={readings}
      kills={kills}
      events={events}
      declarations={declarations}
      metrics={METRICS}
      emailBound={!!c.env.EMAIL}
    />,
  );
});

const form = async (c: { req: { parseBody: () => Promise<Record<string, unknown>> } }) =>
  Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));

app.post("/mode", async (c) => {
  const { mode } = await form(c);
  if (mode !== "armed" && mode !== "dry-run") return c.text("bad mode", 400);
  const store = new Store(c.env.DB);
  await store.setConfig({ mode });
  await store.event("mode", `${c.get("user")} switched the guard to ${mode}`);
  return c.redirect("/");
});

app.post("/settings", async (c) => {
  const f = await form(c);
  const num = (k: string) => {
    const n = Number(f[k]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${k} must be a positive number`);
    return n;
  };
  await new Store(c.env.DB).setConfig({
    alertTo: f.alertTo || null,
    alertFrom: f.alertFrom || null,
    activityMultiplier: num("activityMultiplier"),
    billingMultiplier: num("billingMultiplier"),
    dailyFloor: num("dailyFloor"),
    monthlyCap: num("monthlyCap"),
  });
  return c.redirect("/");
});

app.post("/protect", async (c) => {
  const { key, on } = await form(c);
  const store = new Store(c.env.DB);
  await store.setProtected(key, on === "1");
  await store.event("protect", `${c.get("user")} ${on === "1" ? "protected" : "unprotected"} ${key}`);
  return c.redirect("/#workers");
});

app.post("/kill", async (c) => {
  const { target } = await form(c);
  if (target === `workers:${c.env.GUARD_SCRIPT}`) return c.text("The guard cannot kill itself.", 400);
  await manualKill(c.env, target, c.get("user"));
  return c.redirect("/#kills");
});

app.post("/kills/:id/undo", async (c) => {
  const store = new Store(c.env.DB);
  const row = await store.kill(Number(c.req.param("id")));
  if (!row || row.restored_at) return c.text("No such active kill", 404);
  await undoKill(c.env, row, c.get("user"));
  return c.redirect("/#kills");
});

app.post("/declare", async (c) => {
  const { resource, metric, hourlyPeak, note } = await form(c);
  const peak = Number(hourlyPeak);
  if (!resource.includes(":") || !METRICS.some((m) => m.key === metric) || !(peak > 0)) return c.text("bad declaration", 400);
  const store = new Store(c.env.DB);
  await store.declare(resource, metric, peak, note);
  await store.event("declare", `${c.get("user")} registered ${resource} ${metric} at ${peak}/hour`);
  return c.redirect("/#launches");
});

app.post("/declare/delete", async (c) => {
  const { resource, metric } = await form(c);
  await new Store(c.env.DB).undeclare(resource, metric);
  return c.redirect("/#launches");
});

const JOBS = { activity: checkActivity, baselines: refreshBaselines, billing: checkBilling } as const;

app.post("/run/:job", async (c) => {
  const job = JOBS[c.req.param("job") as keyof typeof JOBS];
  if (!job) return c.text("unknown job", 404);
  await job(c.env);
  return c.redirect("/");
});

app.onError(async (err, c) => {
  await new Store(c.env.DB).event("error", `${c.req.method} ${c.req.path}: ${err.message}`).catch(() => {});
  return c.text(`Error: ${err.message}`, 500);
});

/** Runs a scheduled job, logging and emailing (once per 6 hours) if it fails, since a silent guard is no guard. */
async function guarded(env: Env, name: string, job: (env: Env) => Promise<void>) {
  try {
    await job(env);
  } catch (e) {
    const store = new Store(env.DB);
    const isNew = await store.event("error", `${name} failed: ${e}`, `error:${name}`);
    const config = await store.config();
    if (isNew && env.EMAIL && config.alertTo && config.alertFrom) {
      const { sendEmail } = await import("./email");
      await sendEmail(env.EMAIL, config.alertFrom, config.alertTo, `spend-guard: ${name} is failing`, `${e}\n\n${env.PUBLIC_URL ?? ""}`);
    }
    throw e;
  }
}

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === "*/5 * * * *") {
      ctx.waitUntil(guarded(env, "activity check", checkActivity));
    } else {
      ctx.waitUntil(guarded(env, "baseline refresh", refreshBaselines).finally(() => guarded(env, "billing check", checkBilling)));
    }
  },
} satisfies ExportedHandler<Env>;
