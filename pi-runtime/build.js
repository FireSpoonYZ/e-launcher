import { build } from "esbuild";
import { cp, mkdir, copyFile, readFile, rm, writeFile } from "node:fs/promises";

const sdk = "node_modules/@earendil-works/pi-coding-agent";
const assets = "../app/src/main/assets/pi-sdk";
await mkdir(assets, { recursive: true });
for (const name of ["package.json", "README.md", "CHANGELOG.md"]) await copyFile(`${sdk}/${name}`, `${assets}/${name}`);
for (const name of ["docs", "dist/modes/interactive/theme", "dist/core/export-html"]) {
  await cp(`${sdk}/${name}`, `${assets}/${name}`, { recursive: true, filter: (path) => !path.endsWith(".map") && !path.endsWith(".d.ts") });
}

const npmVersion = JSON.parse(await readFile("package.json", "utf8")).dependencies.npm;
if (JSON.parse(await readFile("node_modules/npm/package.json", "utf8")).version !== npmVersion) {
  throw new Error("Installed npm payload differs from the pinned version; run npm ci");
}
const npmAssets = "../app/src/main/assets/npm";
const npmTarget = `${npmAssets}/${npmVersion}`;
await rm(npmAssets, { recursive: true, force: true });
await mkdir(npmAssets, { recursive: true });
await cp("node_modules/npm", npmTarget, { recursive: true });
await writeFile(`${npmTarget}/payload-complete.txt`, `${npmVersion}\n`);

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
