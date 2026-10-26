import { describe, expect, it } from "vitest";
import { buildQuery, parse } from "../src/meters";

describe("meters", () => {
  it("queries each dataset once, summing every field it needs", () => {
    const q = buildQuery(false);
    expect(q.match(/durableObjectsPeriodicGroups\(/g)).toHaveLength(1);
    expect(q).toContain("sum { activeTime rowsRead rowsWritten }");
    expect(q).not.toContain("datetimeHour");
  });

  it("adds the hour dimension for baselines", () => {
    expect(buildQuery(true)).toContain("dimensions { scriptName datetimeHour }");
  });

  it("turns groups into one sample per metric and resource", () => {
    const samples = parse(
      { durableObjectsPeriodicGroups: [{ sum: { activeTime: 5, rowsRead: 7, rowsWritten: 1 }, dimensions: { namespaceId: "ns1" } }] },
      false,
    );
    expect(samples).toEqual([
      { metric: "do.active", product: "durableObjects", id: "ns1", value: 5 },
      { metric: "do.rowsRead", product: "durableObjects", id: "ns1", value: 7 },
      { metric: "do.rowsWritten", product: "durableObjects", id: "ns1", value: 1 },
    ]);
  });
});
