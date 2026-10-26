import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: process.env.LIVE ? ["test/live/**/*.live.test.ts"] : ["test/*.test.ts"] },
});
