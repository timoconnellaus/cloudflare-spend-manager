import type { ResourceRef } from "./policy";

export class CloudflareApi {
  constructor(
    private token: string,
    readonly accountId: string,
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}${path}`;
    const res = await this.fetcher(url, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
    });
    const body: any = await res.json();
    if (!body.success) throw new Error(`${init.method ?? "GET"} ${path} failed: ${JSON.stringify(body.errors)}`);
    return body.result;
  }

  gql = async (query: string, variables: Record<string, unknown>) => {
    const res = await this.fetcher("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body: any = await res.json();
    if (body.errors?.length) throw new Error(`GraphQL failed: ${JSON.stringify(body.errors)}`);
    return body.data;
  };
}

export type InventoryWorker = {
  name: string;
  bindings: ResourceRef[];
  /** Classes the stub must export so the script's own Durable Object and Workflow bindings stay valid. */
  durableObjectClasses: string[];
  workflowClasses: string[];
  /** The stub upload is untested against container configuration, so these are never killed automatically. */
  hasContainers: boolean;
};

type Binding = Record<string, any> & { type: string; name: string };

export async function inventory(api: CloudflareApi): Promise<InventoryWorker[]> {
  const [scripts, namespaces, queues, containerApps] = await Promise.all([
    api.request<{ id: string }[]>("/workers/scripts"),
    api.request<{ id: string; script: string; class: string }[]>("/workers/durable_objects/namespaces?per_page=1000"),
    api.request<{ queue_id: string; queue_name: string; consumers?: { script?: string; script_name?: string }[] }[]>("/queues"),
    api.request<{ durable_objects?: { namespace_id?: string } }[]>("/containers/applications").catch(() => []),
  ]);
  const queueIdByName = new Map(queues.map((q) => [q.queue_name, q.queue_id]));
  const containerNamespaces = new Set(containerApps.map((a) => a.durable_objects?.namespace_id).filter(Boolean));

  return Promise.all(
    scripts.map(async ({ id: name }) => {
      const { bindings } = await api.request<{ bindings: Binding[] }>(`/workers/scripts/${name}/settings`);
      const refs: ResourceRef[] = [];
      for (const b of bindings) {
        if (b.type === "durable_object_namespace" && b.namespace_id) refs.push({ product: "durableObjects", id: b.namespace_id });
        if (b.type === "d1") refs.push({ product: "d1", id: b.id ?? b.database_id });
        if (b.type === "r2_bucket") refs.push({ product: "r2", id: b.bucket_name });
        if (b.type === "kv_namespace") refs.push({ product: "kv", id: b.namespace_id });
        if (b.type === "queue" && queueIdByName.has(b.queue_name)) refs.push({ product: "queues", id: queueIdByName.get(b.queue_name)! });
      }
      const owned = namespaces.filter((n) => n.script === name);
      for (const n of owned) refs.push({ product: "durableObjects", id: n.id });
      for (const q of queues) {
        if (q.consumers?.some((c) => (c.script ?? c.script_name) === name)) refs.push({ product: "queues", id: q.queue_id });
      }
      const hasContainers = owned.some((n) => containerNamespaces.has(n.id));
      if (hasContainers) refs.push({ product: "containers", id: name });
      const unique = [...new Map(refs.map((r) => [`${r.product}:${r.id}`, r])).values()];
      return {
        name,
        bindings: unique,
        durableObjectClasses: owned.map((n) => n.class),
        workflowClasses: bindings.filter((b) => b.type === "workflow" && b.class_name && (b.script_name ?? name) === name).map((b) => b.class_name),
        hasContainers,
      };
    }),
  );
}

/** A Worker module that keeps the script's exports but does no work: requests get 503, alarms stop rescheduling. */
export function stubSource(w: Pick<InventoryWorker, "durableObjectClasses" | "workflowClasses">): string {
  const lines = [
    `const stopped = () => new Response("Stopped by spend-guard to prevent runaway spend.", { status: 503 });`,
    `export default {`,
    `  fetch: stopped,`,
    `  scheduled() {},`,
    `  queue(batch) { batch.retryAll({ delaySeconds: 43200 }); },`,
    `  email(message) { message.setReject("stopped by spend-guard"); },`,
    `};`,
  ];
  for (const c of w.durableObjectClasses) {
    lines.push(
      `export class ${c} {`,
      `  constructor(ctx) { this.ctx = ctx; }`,
      `  fetch() { return stopped(); }`,
      `  alarm() {}`,
      `  webSocketMessage(ws) { ws.close(1013, "stopped by spend-guard"); }`,
      `}`,
    );
  }
  if (w.workflowClasses.length) lines.unshift(`import { WorkflowEntrypoint } from "cloudflare:workers";`);
  for (const c of w.workflowClasses) {
    lines.push(`export class ${c} extends WorkflowEntrypoint { async run() { throw new Error("stopped by spend-guard"); } }`);
  }
  return lines.join("\n");
}

export type DeploymentVersion = { version_id: string; percentage: number };

/** Everything needed to undo a kill. */
export type KillRecord = { script: string; previous: DeploymentVersion[]; stubVersionId: string };

/**
 * Deploys a stub version of the script. The entrypoint switches at once; running Durable Objects
 * pick up the stub after roughly five minutes (measured 302–303s), which is when their alarms stop.
 */
export async function stubKill(api: CloudflareApi, w: InventoryWorker): Promise<KillRecord> {
  if (w.hasContainers) throw new Error(`${w.name} runs containers; kill it manually`);
  const base = `/workers/scripts/${w.name}`;
  const [{ deployments }, settings] = await Promise.all([
    api.request<{ deployments: { versions: DeploymentVersion[] }[] }>(`${base}/deployments`),
    api.request<{ bindings: Binding[]; compatibility_date?: string; compatibility_flags?: string[] }>(`${base}/settings`),
  ]);
  const previous = deployments[0]?.versions;
  if (!previous?.length) throw new Error(`${w.name} has no deployment to return to`);

  const form = new FormData();
  const metadata = {
    main_module: "stub.js",
    compatibility_date: settings.compatibility_date ?? "2026-10-01",
    compatibility_flags: settings.compatibility_flags ?? [],
    keep_bindings: [...new Set(settings.bindings.map((b) => b.type))],
    keep_assets: true,
    annotations: { "workers/message": "spend-guard kill" },
  };
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("stub.js", new Blob([stubSource(w)], { type: "application/javascript+module" }), "stub.js");
  const version = await api.request<{ id: string }>(`${base}/versions`, { method: "POST", body: form });

  await deploy(api, w.name, [{ version_id: version.id, percentage: 100 }], "spend-guard kill");
  return { script: w.name, previous, stubVersionId: version.id };
}

export async function restore(api: CloudflareApi, record: KillRecord): Promise<void> {
  await deploy(api, record.script, record.previous, "spend-guard restore");
}

async function deploy(api: CloudflareApi, script: string, versions: DeploymentVersion[], message: string) {
  await api.request(`/workers/scripts/${script}/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ strategy: "percentage", versions, annotations: { "workers/message": message } }),
  });
}

/** R2 buckets are stopped by switching off their public r2.dev URL; custom domains and the S3 API stay as they are. */
export async function setR2PublicAccess(api: CloudflareApi, bucket: string, enabled: boolean): Promise<boolean> {
  const path = `/r2/buckets/${bucket}/domains/managed`;
  const current = await api.request<{ enabled: boolean }>(path);
  await api.request(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
  return current.enabled;
}

/** Human-readable names for the opaque ids GraphQL reports (Durable Object namespaces, D1, KV, queues). */
export async function labels(api: CloudflareApi): Promise<Record<string, string>> {
  const [namespaces, databases, kvs, queues] = await Promise.all([
    api.request<{ id: string; script: string; class: string }[]>("/workers/durable_objects/namespaces?per_page=1000"),
    api.request<{ uuid: string; name: string }[]>("/d1/database?per_page=1000"),
    api.request<{ id: string; title: string }[]>("/storage/kv/namespaces?per_page=1000"),
    api.request<{ queue_id: string; queue_name: string }[]>("/queues"),
  ]);
  return Object.fromEntries([
    ...namespaces.map((n) => [`durableObjects:${n.id}`, `${n.script} / ${n.class}`]),
    ...databases.map((d) => [`d1:${d.uuid}`, d.name]),
    ...kvs.map((k) => [`kv:${k.id}`, k.title]),
    ...queues.map((q) => [`queues:${q.queue_id}`, q.queue_name]),
  ]);
}
