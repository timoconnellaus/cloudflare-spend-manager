// Runs guarded/example in the real Workers runtime (workerd) via wrangler: deliberate runaway
// alarm loops, on a plain Durable Object and on an Agents SDK Agent, must stop themselves.
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
const call = async (path: string) => (await worker.fetch(`http://guard.test${path}`)).json() as Promise<Record<string, any>>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function untilTripped(query: string) {
  for (let i = 0; i < 100; i++) {
    const s = await call(`/status?${query}`);
    if (s.tripped) return s;
    await sleep(100);
  }
  throw new Error("never tripped");
}

beforeAll(async () => {
  worker = await unstable_startWorker({ config: "guarded/example/wrangler.jsonc", dev: { remote: false, persist: false, server: { port: 0 }, inspector: false } });
  await worker.ready;
}, 60_000);

afterAll(() => worker?.dispose());

describe.each([
  ["plain Durable Object", "kind=do"],
  ["Agents SDK Agent", "kind=agent"],
])("a runaway %s", (_, kind) => {
  const query = `${kind}&id=${crypto.randomUUID()}`;

  it("trips on its write budget and stays stopped", async () => {
    await call(`/start?${query}`);
    const tripped = await untilTripped(query);
    expect(tripped).toMatchObject({ tripped: expect.stringMatching(/rows written this hour, budget 2000/), alarmPending: false });
    expect(tripped.alarms).toBeGreaterThan(1);

    await sleep(1_000);
    const later = await call(`/status?${query}`);
    expect(later.rowsWritten).toBe(tripped.rowsWritten);
    expect(later.alarms).toBe(tripped.alarms);
  }, 30_000);

  it("works again after resetGuard, with its data intact", async () => {
    await call(`/reset?${query}`);
    const status = await call(`/status?${query}`);
    expect(status.tripped).toBeNull();
    expect(status.rows).toBeGreaterThanOrEqual(1_900);
  }, 30_000);
});
