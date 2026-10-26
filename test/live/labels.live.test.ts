// Runs against the real account in .dev.vars: `npm run test:live`.
import { describe, expect, it } from "vitest";
import { CloudflareApi, labels } from "../../src/cloudflare";
import { env } from "./env";

describe("live labels", () => {
  it("names Durable Object namespaces, databases, KV namespaces and queues", async () => {
    const l = await labels(new CloudflareApi(env.CF_API_TOKEN, env.CF_ACCOUNT_ID));
    console.log(Object.keys(l).length, "labels; e.g.", l["durableObjects:c0fdb8e4218341c997c8ee7fbe728ed3"]);
    expect(l["durableObjects:c0fdb8e4218341c997c8ee7fbe728ed3"]).toBe("frockbot-computer-host / FlyHostContainer");
  }, 60_000);
});
