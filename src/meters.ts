import type { Product } from "./policy";

/**
 * One activity metric, read from a GraphQL Analytics dataset and grouped by the resource it belongs to.
 * These measure activity, not dollars: GraphQL undercounted the rows behind the 2026-10 Durable Objects bill
 * by five orders of magnitude, but activity such as `activeTime` still showed the runaway.
 */
export type Metric = {
  key: string;
  product: Product;
  dataset: string;
  /** Dimension that identifies the resource; must match the ids used in the inventory's bindings. */
  idDimension: string;
  field: string;
  unit: string;
  /** Hourly limit for a resource with no baseline, and the floor under every learned limit. */
  floor: number;
};

export const METRICS: Metric[] = [
  { key: "workers.requests", product: "workers", dataset: "workersInvocationsAdaptive", idDimension: "scriptName", field: "requests", unit: "requests", floor: 50_000 },
  { key: "workers.cpu", product: "workers", dataset: "workersInvocationsAdaptive", idDimension: "scriptName", field: "cpuTimeUs", unit: "µs CPU", floor: 600e6 },
  { key: "do.requests", product: "durableObjects", dataset: "durableObjectsInvocationsAdaptiveGroups", idDimension: "namespaceId", field: "requests", unit: "requests", floor: 50_000 },
  { key: "do.active", product: "durableObjects", dataset: "durableObjectsPeriodicGroups", idDimension: "namespaceId", field: "activeTime", unit: "µs active", floor: 36_000e6 },
  { key: "do.rowsRead", product: "durableObjects", dataset: "durableObjectsPeriodicGroups", idDimension: "namespaceId", field: "rowsRead", unit: "rows read", floor: 100e6 },
  { key: "do.rowsWritten", product: "durableObjects", dataset: "durableObjectsPeriodicGroups", idDimension: "namespaceId", field: "rowsWritten", unit: "rows written", floor: 1e6 },
  { key: "r2.requests", product: "r2", dataset: "r2OperationsAdaptiveGroups", idDimension: "bucketName", field: "requests", unit: "operations", floor: 100_000 },
  { key: "d1.rowsRead", product: "d1", dataset: "d1AnalyticsAdaptiveGroups", idDimension: "databaseId", field: "rowsRead", unit: "rows read", floor: 1e9 },
  { key: "d1.rowsWritten", product: "d1", dataset: "d1AnalyticsAdaptiveGroups", idDimension: "databaseId", field: "rowsWritten", unit: "rows written", floor: 1e6 },
  { key: "kv.requests", product: "kv", dataset: "kvOperationsAdaptiveGroups", idDimension: "namespaceId", field: "requests", unit: "operations", floor: 100_000 },
  { key: "queues.operations", product: "queues", dataset: "queueMessageOperationsAdaptiveGroups", idDimension: "queueId", field: "billableOperations", unit: "operations", floor: 100_000 },
];

/** A metric's total for one resource, either over a single window or per hour. */
export type Sample = { metric: string; product: Product; id: string; value: number; hour?: string };

export type Gql = (query: string, variables: Record<string, unknown>) => Promise<any>;

const byDataset = () => {
  const groups = new Map<string, Metric[]>();
  for (const m of METRICS) groups.set(m.dataset, [...(groups.get(m.dataset) ?? []), m]);
  return groups;
};

export function buildQuery(hourly: boolean): string {
  const parts = [...byDataset()].map(([dataset, metrics]) => {
    const dims = [metrics[0].idDimension, ...(hourly ? ["datetimeHour"] : [])].join(" ");
    const sums = [...new Set(metrics.map((m) => m.field))].join(" ");
    return `${dataset}(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }) { sum { ${sums} } dimensions { ${dims} } }`;
  });
  return `query($account: String!, $start: Time!, $end: Time!) { viewer { accounts(filter: { accountTag: $account }) { ${parts.join("\n")} } } }`;
}

export function parse(account: Record<string, any[] | undefined>, hourly: boolean): Sample[] {
  const samples: Sample[] = [];
  for (const [dataset, metrics] of byDataset()) {
    for (const group of account[dataset] ?? []) {
      for (const m of metrics) {
        samples.push({
          metric: m.key,
          product: m.product,
          id: group.dimensions[m.idDimension],
          value: group.sum[m.field] ?? 0,
          ...(hourly ? { hour: group.dimensions.datetimeHour } : {}),
        });
      }
    }
  }
  return samples;
}

/** Totals per resource and metric over [start, end), optionally split by hour. */
export async function measure(gql: Gql, accountId: string, start: Date, end: Date, hourly = false): Promise<Sample[]> {
  const data = await gql(buildQuery(hourly), { account: accountId, start: start.toISOString(), end: end.toISOString() });
  return parse(data.viewer.accounts[0], hourly);
}
