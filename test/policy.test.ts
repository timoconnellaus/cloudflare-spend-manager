import { describe, expect, it } from "vitest";
import { plan, type Breach, type Inventory, type Settings } from "../src/policy";

const settings: Settings = { protectedKeys: new Set(), guardScript: "spend-guard" };

const inventory: Inventory = {
  workers: [
    { name: "api", bindings: [{ product: "d1", id: "db1" }, { product: "r2", id: "uploads" }] },
    { name: "cron-job", bindings: [{ product: "d1", id: "db1" }] },
    { name: "site", bindings: [] },
    { name: "chat", bindings: [{ product: "durableObjects", id: "ns-chat" }] },
    { name: "spend-guard", bindings: [{ product: "d1", id: "db1" }] },
  ],
};

const breach = (product: Breach["resource"]["product"], id: string): Breach => ({
  resource: { product, id },
  reason: `${product}:${id} breached`,
});

const killedIds = (p: ReturnType<typeof plan>) => p.kills.map((k) => `${k.target.product}:${k.target.id}`).sort();

describe("plan", () => {
  it("does nothing without breaches", () => {
    expect(plan([], inventory, settings)).toEqual({ kills: [], alerts: [] });
  });

  it("kills a breaching worker", () => {
    expect(killedIds(plan([breach("workers", "site")], inventory, settings))).toEqual(["workers:site"]);
  });

  it("kills a breaching bucket and the workers bound to it", () => {
    expect(killedIds(plan([breach("r2", "uploads")], inventory, settings))).toEqual(["r2:uploads", "workers:api"]);
  });

  it("kills every unprotected consumer of a breaching database, never the guard", () => {
    expect(killedIds(plan([breach("d1", "db1")], inventory, settings))).toEqual(["workers:api", "workers:cron-job"]);
  });

  it("kills the workers behind a breaching Durable Object namespace", () => {
    expect(killedIds(plan([breach("durableObjects", "ns-chat")], inventory, settings))).toEqual(["workers:chat"]);
  });

  it("kills every unprotected user of a product when billing only names the product", () => {
    expect(killedIds(plan([breach("d1", "*")], inventory, settings))).toEqual(["workers:api", "workers:cron-job"]);
  });

  it("alerts instead of killing a protected resource", () => {
    const p = plan([breach("workers", "site")], inventory, { ...settings, protectedKeys: new Set(["workers:site"]) });
    expect(p.kills).toEqual([]);
    expect(p.alerts).toMatchObject([{ resource: { id: "site" }, kind: "protected" }]);
  });

  it("alerts when a breaching resource has no killable consumer", () => {
    const p = plan([breach("kv", "orphan")], inventory, settings);
    expect(p.kills).toEqual([]);
    expect(p.alerts).toMatchObject([{ resource: { id: "orphan" }, kind: "unattributed" }]);
  });

  it("never kills the guard even when the guard itself breaches", () => {
    const p = plan([breach("workers", "spend-guard")], inventory, settings);
    expect(p.kills).toEqual([]);
    expect(p.alerts).toMatchObject([{ resource: { id: "spend-guard" }, kind: "guard" }]);
  });

  it("merges reasons when one worker is hit by several breaches", () => {
    const p = plan([breach("workers", "api"), breach("d1", "db1")], inventory, settings);
    expect(p.kills.find((k) => k.target.id === "api")?.reasons).toHaveLength(2);
  });
});
