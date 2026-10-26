export type Product = "workers" | "r2" | "d1" | "kv" | "durableObjects" | "queues" | "containers" | "other";

/** `id: "*"` means every resource of the product: the billing API reports cost per product, not per resource. */
export type ResourceRef = { product: Product; id: string };

/** A resource some detector judged to be running away, with a human-readable why. */
export type Breach = { resource: ResourceRef; reason: string };

export type Inventory = {
  /** `bindings` include the Durable Object namespaces a script defines, not only the ones it binds. */
  workers: { name: string; bindings: ResourceRef[] }[];
};

export type Settings = {
  /** Keys from `keyOf`. Protected resources are alerted on, never killed automatically. */
  protectedKeys: Set<string>;
  /** The guard's own script name: never killed, or nothing would be left to undo a kill. */
  guardScript: string;
};

/** Only Workers and R2 buckets have kill actions; other products are stopped through the Workers bound to them. */
export type KillTarget = { product: "workers" | "r2"; id: string };

export type Kill = { target: KillTarget; reasons: string[] };

export type Alert = {
  resource: ResourceRef;
  kind: "protected" | "unattributed" | "guard";
  message: string;
};

export type Plan = { kills: Kill[]; alerts: Alert[] };

export const keyOf = (r: ResourceRef) => `${r.product}:${r.id}`;

const matches = (binding: ResourceRef, resource: ResourceRef) =>
  binding.product === resource.product && (resource.id === "*" || binding.id === resource.id);

export function plan(breaches: Breach[], inventory: Inventory, settings: Settings): Plan {
  const kills = new Map<string, Kill>();
  const alerts: Alert[] = [];

  for (const { resource, reason } of breaches) {
    const candidates: KillTarget[] = [];
    if ((resource.product === "workers" || resource.product === "r2") && resource.id !== "*") {
      candidates.push({ product: resource.product, id: resource.id });
    }
    for (const worker of inventory.workers) {
      const bound = resource.product === "workers" ? false : worker.bindings.some((b) => matches(b, resource));
      const isAll = resource.product === "workers" && resource.id === "*";
      if (bound || isAll) candidates.push({ product: "workers", id: worker.name });
    }

    let killedAny = false;
    let alerted = false;
    for (const target of candidates) {
      if (target.product === "workers" && target.id === settings.guardScript) {
        if (resource.product === "workers" && resource.id === settings.guardScript) {
          alerts.push({ resource, kind: "guard", message: `${reason}; the guard never kills itself` });
          alerted = true;
        }
        continue;
      }
      if (settings.protectedKeys.has(keyOf(target))) {
        alerts.push({ resource, kind: "protected", message: `${reason}; ${keyOf(target)} is protected, kill it from the dashboard` });
        alerted = true;
        continue;
      }
      const existing = kills.get(keyOf(target));
      if (existing) existing.reasons.push(reason);
      else kills.set(keyOf(target), { target, reasons: [reason] });
      killedAny = true;
    }

    if (!killedAny && !alerted) {
      alerts.push({
        resource,
        kind: "unattributed",
        message: `${reason}; no Worker in this account is bound to it, so it may be driven by an API token or external client`,
      });
    }
  }

  return { kills: [...kills.values()], alerts };
}
