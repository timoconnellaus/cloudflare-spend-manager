import { readFileSync } from "node:fs";

export const env: Record<string, string> = Object.fromEntries(
  readFileSync(".dev.vars", "utf8").split("\n").filter(Boolean).map((l: string) => l.split(/=(.*)/s).slice(0, 2)),
);
