// Runs against the real account in .dev.vars: `npm run test:live`.
import { describe, expect, it } from "vitest";
import { CloudflareApi } from "../../src/cloudflare";
import { measure } from "../../src/meters";
import { env } from "./env";

const { gql } = new CloudflareApi(env.CF_API_TOKEN, env.CF_ACCOUNT_ID);

describe("live meters", () => {
  it("measures the last hour and a week of hourly history", async () => {
    const end = new Date(Date.now() - 5 * 60_000);
    const hour = await measure(gql, env.CF_ACCOUNT_ID, new Date(end.getTime() - 3600_000), end);
    const week = await measure(gql, env.CF_ACCOUNT_ID, new Date(end.getTime() - 7 * 86400_000), end, true);
    console.log(`last hour: ${hour.length} samples; week: ${week.length} hourly samples`);
    console.table(hour.filter((s) => s.value > 0).sort((a, b) => b.value - a.value).slice(0, 12));
    expect(week.length).toBeLessThan(10_000 * 7);
    expect(hour.length).toBeGreaterThan(0);
  }, 60_000);
});
