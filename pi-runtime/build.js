import { build } from "esbuild";

await build({
  entryPoints: ["android.js"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  outfile: "../app/src/main/assets/pi-runtime.cjs",
  logLevel: "info",
});
