// Runs against the real account in .dev.vars: `npm run test:live`.
import { describe, expect, it } from "vitest";
import { CloudflareApi, inventory } from "../../src/cloudflare";
import { env } from "./env";

describe("live inventory", () => {
  it("maps every Worker to the resources it uses", async () => {
    const workers = await inventory(new CloudflareApi(env.CF_API_TOKEN, env.CF_ACCOUNT_ID));
    console.log(`${workers.length} workers; with containers: ${workers.filter((w) => w.hasContainers).map((w) => w.name).join(", ")}`);
    console.log(`with workflows: ${workers.filter((w) => w.workflowClasses.length).map((w) => `${w.name}(${w.workflowClasses})`).join(", ")}`);
    console.table(workers.slice(0, 6).map((w) => ({ name: w.name, bindings: w.bindings.map((b) => `${b.product}:${b.id.slice(0, 8)}`).join(" ") })));
    expect(workers.length).toBeGreaterThan(0);
  }, 120_000);
});
