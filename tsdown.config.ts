import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/main.ts"],
  format: "cjs",
  platform: "node",
  target: "es2022",
  clean: true,
  dts: false,
  // Runtime devDependencies (Effect and swagger2openapi) ship in the CLI bundle.
  deps: { onlyBundle: false },
  banner: "#!/usr/bin/env node",
})
