import type { Breach, Product } from "./policy";

/** The fields we use from a Billable Usage API row (`GET /accounts/{id}/billable-usage`). */
export type UsageRow = {
  ServiceFamilyName: string;
  ServiceName: string;
  ChargePeriodStart: string;
  ContractedCost: number;
  BillingPeriodStart?: string;
};

export type BillingConfig = {
  /** How far above its highest prior day a product's daily cost may go. */
  multiplier: number;
  /** Daily cost below which no product is ever judged anomalous, in USD. */
  dailyFloor: number;
  /** Month-to-date total for the whole account, in USD. */
  monthlyCap: number;
};

const FAMILY_TO_PRODUCT: Record<string, Product> = {
  Workers: "workers",
  R2: "r2",
  D1: "d1",
  "Workers KV": "kv",
  "Durable Objects": "durableObjects",
  Queues: "queues",
  Containers: "containers",
};

const resourceOf = (family: string) => {
  const product = FAMILY_TO_PRODUCT[family];
  return product ? { product, id: "*" } : { product: "other" as const, id: family };
};

const BASELINE_DAYS = 14;
/** The newest day in the API is usually partial, so the day before it is checked too. */
const CHECKED_DAYS = 2;

const usd = (n: number) => `$${n.toFixed(2)}`;

export function tripwire(rows: UsageRow[], config: BillingConfig): Breach[] {
  const daily = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const day = r.ChargePeriodStart.slice(0, 10);
    const byDay = daily.get(r.ServiceFamilyName) ?? new Map<string, number>();
    byDay.set(day, (byDay.get(day) ?? 0) + r.ContractedCost);
    daily.set(r.ServiceFamilyName, byDay);
  }
  const allDays = [...new Set(rows.map((r) => r.ChargePeriodStart.slice(0, 10)))].sort();
  const checked = allDays.slice(-CHECKED_DAYS);

  const breaches: Breach[] = [];
  const breachedFamilies = new Set<string>();

  for (const [family, byDay] of daily) {
    for (const day of checked) {
      const cost = byDay.get(day) ?? 0;
      const prior = allDays.filter((d) => d < day).slice(-BASELINE_DAYS).map((d) => byDay.get(d) ?? 0);
      const limit = Math.max(Math.max(0, ...prior) * config.multiplier, config.dailyFloor);
      if (cost > limit) {
        breaches.push({
          resource: resourceOf(family),
          reason: `${family} billed ${usd(cost)} on ${day}, over its limit of ${usd(limit)} (${config.multiplier}x its highest day in the prior ${BASELINE_DAYS})`,
        });
        breachedFamilies.add(family);
        break;
      }
    }
  }

  const period = rows.map((r) => r.BillingPeriodStart).filter(Boolean).sort().at(-1);
  const inPeriod = period ? rows.filter((r) => r.BillingPeriodStart === period) : rows;
  const monthToDate = inPeriod.reduce((sum, r) => sum + r.ContractedCost, 0);
  if (monthToDate > config.monthlyCap) {
    // Spend that has already stopped cannot be saved by a kill. Only stop products still billing
    // faster than the cap allows, so normal background spend is left alone.
    const capPerDay = config.monthlyCap / 30;
    for (const [family, byDay] of daily) {
      const ongoing = Math.max(0, ...checked.map((d) => byDay.get(d) ?? 0)) >= capPerDay;
      if (!ongoing || breachedFamilies.has(family)) continue;
      breaches.push({
        resource: resourceOf(family),
        reason: `account billed ${usd(monthToDate)} this period, over the ${usd(config.monthlyCap)} cap; ${family} is still billing`,
      });
    }
  }

  return breaches;
}
