// Deliberate runaways for testing the guard: each alarm writes rows and schedules the next alarm
// almost immediately, the same shape as the loop behind the October 2026 bill.
import { Agent } from "agents";
import { DurableObject } from "cloudflare:workers";
import { withGuard } from "../index";

type Env = { RUNAWAY: DurableObjectNamespace<Runaway>; RUNAWAY_AGENT: DurableObjectNamespace<RunawayAgent> };

const ROWS_PER_ALARM = 100;
const BUDGET = { rowsWrittenPerHour: 2_000, alarmsPerHour: 1_000 };

export class Runaway extends withGuard(DurableObject<Env>, BUDGET) {
  async start() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS junk (v TEXT)");
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return this.guardStatus();
  }

  async alarm() {
    for (let i = 0; i < ROWS_PER_ALARM; i++) this.ctx.storage.sql.exec("INSERT INTO junk VALUES (?)", "x".repeat(32));
    await this.ctx.storage.setAlarm(Date.now() + 50);
  }

  rows() {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM junk").one().n;
  }

  async alarmPending() {
    return (await this.ctx.storage.getAlarm()) !== null;
  }
}

export class RunawayAgent extends withGuard(Agent<Env>, BUDGET) {
  async start() {
    this.sql`CREATE TABLE IF NOT EXISTS junk (v TEXT)`;
    await this.schedule(0, "spin");
    return this.guardStatus();
  }

  async spin() {
    for (let i = 0; i < ROWS_PER_ALARM; i++) this.sql`INSERT INTO junk VALUES (${"x".repeat(32)})`;
    await this.schedule(0, "spin");
  }

  rows() {
    return this.sql<{ n: number }>`SELECT count(*) AS n FROM junk`[0].n;
  }

  async alarmPending() {
    return (await this.ctx.storage.getAlarm()) !== null;
  }
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    const ns = url.searchParams.get("kind") === "agent" ? env.RUNAWAY_AGENT : env.RUNAWAY;
    const stub = ns.get(ns.idFromName(url.searchParams.get("id") ?? "one")) as unknown as DurableObjectStub<Runaway>;
    switch (url.pathname) {
      case "/start":
        return Response.json(await stub.start());
      case "/status":
        return Response.json({ ...(await stub.guardStatus()), rows: await stub.rows().catch(() => null), alarmPending: await stub.alarmPending() });
      case "/reset":
        return Response.json(await stub.resetGuard());
    }
    return new Response("not found", { status: 404 });
  },
};
