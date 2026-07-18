import { defineConfig } from "vitest/config";
import * as path from "path";

export default defineConfig({
  test: {
    // Node-Umgebung: Der Plugin-Code nutzt Node-Module (crypto, http).
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: false,
  },
  resolve: {
    alias: {
      // Das echte `obsidian`-Paket ist types-only (keine Runtime-JS).
      // Für Tests durch einen schlanken Mock ersetzen.
      obsidian: path.resolve(__dirname, "test/mocks/obsidian.ts"),
    },
  },
});
