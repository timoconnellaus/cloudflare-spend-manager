// Runs against the real account in .dev.vars: `npm run test:live`.
// Creates and deletes a throwaway Worker; never touches existing ones.
import { afterAll, describe, expect, it } from "vitest";
import { CloudflareApi, inventory, restore, stubKill } from "../../src/cloudflare";
import { env } from "./env";

const api = new CloudflareApi(env.CF_API_TOKEN, env.CF_ACCOUNT_ID);
const NAME = "spend-guard-killtest";

const ORIGINAL = `
export class Loop { constructor(ctx) { this.ctx = ctx; } fetch() { return new Response("original-do"); } }
export default { fetch: () => new Response("original") };
`;

async function upload() {
  const form = new FormData();
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-10-01",
    bindings: [{ type: "durable_object_namespace", name: "LOOP", class_name: "Loop" }, { type: "plain_text", name: "MARK", text: "kept" }],
    migrations: { new_tag: "v1", new_sqlite_classes: ["Loop"] },
  };
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("index.js", new Blob([ORIGINAL], { type: "application/javascript+module" }), "index.js");
  await api.request(`/workers/scripts/${NAME}`, { method: "PUT", body: form });
  await api.request(`/workers/scripts/${NAME}/subdomain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
}

async function body(url: string) {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(url);
    if (res.status !== 404) return `${res.status} ${await res.text()}`;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return "never reachable";
}

afterAll(async () => {
  await api.request(`/workers/scripts/${NAME}?force=true`, { method: "DELETE" });
});

describe("live stub kill", () => {
  it("stops a Worker at once, keeps its bindings, and restores it", async () => {
    await upload();
    const { subdomain } = await api.request<{ subdomain: string }>("/workers/subdomain");
    const url = `https://${NAME}.${subdomain}.workers.dev`;
    expect(await body(url)).toBe("200 original");

    const worker = (await inventory(api)).find((w) => w.name === NAME)!;
    expect(worker.durableObjectClasses).toEqual(["Loop"]);

    const record = await stubKill(api, worker);
    await new Promise((r) => setTimeout(r, 5000));
    expect(await body(url)).toMatch(/^503 Stopped by spend-guard/);
    const { bindings } = await api.request<{ bindings: { name: string }[] }>(`/workers/scripts/${NAME}/settings`);
    expect(bindings.map((b) => b.name).sort()).toEqual(["LOOP", "MARK"]);

    await restore(api, record);
    await new Promise((r) => setTimeout(r, 5000));
    expect(await body(url)).toBe("200 original");
  }, 180_000);
});
