import { describe, expect, it } from "vitest";
import { judge, type BaselineConfig } from "../src/baseline";

const config: BaselineConfig = { multiplier: 3, minHistoryHours: 72 };
const FLOOR = 1000;
const week = (peak: number) => ({ peak, hours: 168 });

describe("judge", () => {
  it("passes activity within the multiplier of the historical hourly peak", () => {
    expect(judge(2900, week(1000), undefined, FLOOR, config)).toMatchObject({ breached: false, limit: 3000 });
  });

  it("breaches activity above the multiplier of the peak", () => {
    expect(judge(3001, week(1000), undefined, FLOOR, config)).toMatchObject({ breached: true, basis: "learned" });
  });

  it("holds a resource with too little history to the floor", () => {
    expect(judge(1001, { peak: 5000, hours: 24 }, undefined, FLOOR, config)).toMatchObject({ breached: true, basis: "unbaselined", limit: 1000 });
  });

  it("holds a resource never seen before to the floor", () => {
    expect(judge(1001, undefined, undefined, FLOOR, config)).toMatchObject({ breached: true, basis: "unbaselined" });
  });

  it("uses a declared expectation instead of history, so a launch can be set up in advance", () => {
    expect(judge(250_000, undefined, 100_000, FLOOR, config)).toMatchObject({ breached: false, basis: "declared", limit: 300_000 });
    expect(judge(350_000, week(10), 100_000, FLOOR, config)).toMatchObject({ breached: true, basis: "declared" });
  });

  it("never sets a learned limit below the floor, so near-idle resources are not killed for blips", () => {
    expect(judge(900, week(1), undefined, FLOOR, config)).toMatchObject({ breached: false, limit: 1000 });
  });
});
