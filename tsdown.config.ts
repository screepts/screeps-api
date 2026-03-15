import { defineConfig } from "tsdown"

export default defineConfig([
  {
    entry: "./src/index.ts",
    platform: "browser",
    fixedExtension: true,
    sourcemap: true,
    exports: true,
    deps: {
      neverBundle: ["fs/promises"],
    },
  },
  {
    entry: "./src/cli.ts",
  },
])
