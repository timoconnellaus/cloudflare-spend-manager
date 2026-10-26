import { describe, expect, it } from "vitest";
import { tripwire, type BillingConfig, type UsageRow } from "../src/billing";

const config: BillingConfig = { multiplier: 3, dailyFloor: 10, monthlyCap: 500 };

const row = (day: string, family: string, cost: number): UsageRow => ({
  ServiceFamilyName: family,
  ServiceName: `${family} thing`,
  ChargePeriodStart: `${day}T00:00:00Z`,
  ContractedCost: cost,
});

const days = (from: number, to: number, family: string, cost: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => row(`2026-10-${String(from + i).padStart(2, "0")}`, family, cost));

describe("tripwire", () => {
  it("is quiet when every product stays near its own daily baseline", () => {
    expect(tripwire([...days(1, 20, "Workers", 5)], config)).toEqual([]);
  });

  it("breaches a product whose latest day jumps past its baseline, naming the product, not a resource", () => {
    const rows = [...days(1, 19, "D1", 5), row("2026-10-20", "D1", 40)];
    expect(tripwire(rows, config)).toMatchObject([{ resource: { product: "d1", id: "*" } }]);
  });

  it("ignores jumps that stay under the daily floor", () => {
    const rows = [...days(1, 19, "R2", 0.1), row("2026-10-20", "R2", 9)];
    expect(tripwire(rows, config)).toEqual([]);
  });

  it("catches a slow ramp the way the real incident started: from zero to $61/day", () => {
    const rows = [...days(1, 23, "Durable Objects", 0), row("2026-10-24", "Durable Objects", 61.48)];
    expect(tripwire(rows, config)).toMatchObject([{ resource: { product: "durableObjects", id: "*" } }]);
  });

  it("checks the two latest days, because the newest day is often partial", () => {
    const rows = [...days(1, 18, "Workers", 5), row("2026-10-19", "Workers", 90), row("2026-10-20", "Workers", 1)];
    expect(tripwire(rows, config)).toHaveLength(1);
  });

  it("breaches every product still spending once the month-to-date total passes the cap", () => {
    const rows = [...days(1, 20, "Workers", 20), ...days(1, 20, "R2", 20), ...days(1, 18, "D1", 5), ...days(19, 20, "D1", 0)];
    expect(tripwire(rows, config).map((b) => b.resource.product).sort()).toEqual(["r2", "workers"]);
  });

  it("does not kill anything over the cap when the spend that broke it has already stopped", () => {
    // The real 2026-10-21 period: $770 from the incident's last days, then about $1/day.
    const rows = [row("2026-10-21", "Durable Objects", 562), row("2026-10-22", "Durable Objects", 205), row("2026-10-23", "Durable Objects", 1), row("2026-10-24", "Durable Objects", 0.8)];
    expect(tripwire([...days(1, 20, "Durable Objects", 600), ...rows], config)).toEqual([]);
  });

  it("maps an unmetered product family to `other` so it is alerted on by name", () => {
    const rows = [...days(1, 19, "Stream", 0), row("2026-10-20", "Stream", 16)];
    expect(tripwire(rows, config)).toMatchObject([{ resource: { product: "other", id: "Stream" } }]);
  });
});
