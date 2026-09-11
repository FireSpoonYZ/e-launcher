import { build } from "esbuild";
import { cp, mkdir, copyFile } from "node:fs/promises";

const sdk = "node_modules/@earendil-works/pi-coding-agent";
const assets = "../app/src/main/assets/pi-sdk";
await mkdir(assets, { recursive: true });
for (const name of ["package.json", "README.md", "CHANGELOG.md"]) await copyFile(`${sdk}/${name}`, `${assets}/${name}`);
for (const name of ["docs", "dist/modes/interactive/theme", "dist/core/export-html"]) {
  await cp(`${sdk}/${name}`, `${assets}/${name}`, { recursive: true, filter: (path) => !path.endsWith(".map") && !path.endsWith(".d.ts") });
}

await build({
  entryPoints: ["android.js"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  define: { PI_BUNDLED_NODE: "true", "import.meta.url": "__bundleMetaUrl" },
  banner: { js: 'const __bundleMetaUrl = require("node:url").pathToFileURL(__filename).href; process.env.PI_PACKAGE_DIR = require("node:path").join(__dirname, "pi-sdk");' },
  outfile: "../app/src/main/assets/pi-runtime.cjs",
  logLevel: "info",
});
