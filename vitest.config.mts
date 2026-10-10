import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the "@/..." imports the app uses, so tests can load modules without mocking every dependency.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "") } },
});
