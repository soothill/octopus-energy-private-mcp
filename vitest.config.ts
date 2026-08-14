import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"]
    }
  }
});
