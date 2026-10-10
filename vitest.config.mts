import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Resolve the "@/..." imports the app uses, so tests can load modules without mocking every dependency.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "") } },
  // example_project/ is a git-ignored reference copy of another app; its tests are not SBSB's.
  test: { exclude: [...configDefaults.exclude, "example_project/**"] },
});
