// Runs against the real account in .dev.vars: `npm run test:live`.
// Deploys guarded/example as the throwaway Worker spend-guard-runawaytest, then deletes it.
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudflareApi } from "../../src/cloudflare";
import { env } from "./env";

const api = new CloudflareApi(env.CF_API_TOKEN, env.CF_ACCOUNT_ID);
const NAME = "spend-guard-runawaytest";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let base = "";

async function call(path: string) {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(base + path);
    if (res.ok) return (await res.json()) as Record<string, any>;
    await sleep(2_000);
  }
  throw new Error(`${path} never succeeded`);
}

beforeAll(() => {
  // wrangler's own login deploys; the guard's token is deliberately not allowed to.
  const { CLOUDFLARE_API_TOKEN: _, ...wranglerEnv } = process.env;
  const out = execFileSync("npx", ["wrangler", "deploy", "-c", "guarded/example/wrangler.jsonc"], { env: wranglerEnv, encoding: "utf8" });
  base = out.match(/https:\/\/\S+\.workers\.dev/)![0];
}, 180_000);

afterAll(async () => {
  await api.request(`/workers/scripts/${NAME}?force=true`, { method: "DELETE" });
});

describe.each([
  ["plain Durable Object", "kind=do"],
  ["Agents SDK Agent", "kind=agent"],
])("on Cloudflare, a runaway %s", (_, kind) => {
  it("stops itself at its write budget and stays stopped", async () => {
    const query = `${kind}&id=${crypto.randomUUID()}`;
    await call(`/start?${query}`);
    let tripped: Record<string, any> | undefined;
    for (let i = 0; i < 60 && !tripped; i++) {
      const s = await call(`/status?${query}`);
      if (s.tripped) tripped = s;
      else await sleep(500);
    }
    expect(tripped).toMatchObject({ tripped: expect.stringMatching(/rows written this hour, budget 2000/), alarmPending: false });

    await sleep(5_000);
    const later = await call(`/status?${query}`);
    expect(later).toMatchObject({ rowsWritten: tripped!.rowsWritten, alarms: tripped!.alarms, alarmPending: false });
  }, 120_000);
});
