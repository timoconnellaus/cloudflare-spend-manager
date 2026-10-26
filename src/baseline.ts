export type BaselineConfig = {
  /** How far above its hourly peak a resource may go before it is anomalous. */
  multiplier: number;
  /** Hours of history needed before a learned baseline is trusted. */
  minHistoryHours: number;
};

/** A resource's highest hourly total over the trailing week, and how many hours it has been observed. */
export type Baseline = { peak: number; hours: number };

export type Verdict = {
  breached: boolean;
  limit: number;
  basis: "declared" | "learned" | "unbaselined";
};

/**
 * Judges one metric of one resource over the latest hour. `declared` is an expected hourly peak registered
 * for a launch; `floor` is both the limit for unbaselined resources and the minimum for learned ones.
 */
export function judge(
  current: number,
  baseline: Baseline | undefined,
  declared: number | undefined,
  floor: number,
  config: BaselineConfig,
): Verdict {
  let limit: number;
  let basis: Verdict["basis"];
  if (declared !== undefined) {
    limit = declared * config.multiplier;
    basis = "declared";
  } else if (baseline && baseline.hours >= config.minHistoryHours) {
    limit = Math.max(baseline.peak * config.multiplier, floor);
    basis = "learned";
  } else {
    limit = floor;
    basis = "unbaselined";
  }
  return { breached: current > limit, limit, basis };
}
