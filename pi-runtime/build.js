import { build } from "esbuild";
import { cp, mkdir, copyFile, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Hash every payload path and byte, not just npm's version or directory timestamp.
async function payloadHash(root) {
  const hash = createHash("sha256");
  async function visit(relative) {
    const path = `${root}/${relative}`;
    const info = await stat(path);
    hash.update(JSON.stringify([relative, info.isDirectory() ? "dir" : info.size]));
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (!relative && name === "payload-complete.txt") continue;
        await visit(relative ? `${relative}/${name}` : name);
      }
    } else {
      hash.update(await readFile(path));
    }
  }
  await visit("");
  return hash.digest("hex");
}

async function readIfPresent(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

const sdk = "node_modules/@earendil-works/pi-coding-agent";
const assets = "../app/src/main/assets/pi-sdk";
// Copy is a replacement: removed SDK docs/themes must not survive a rebuild.
await rm(assets, { recursive: true, force: true });
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
const sourceHash = await payloadHash("node_modules/npm");
const inputHash = createHash("sha256").update(sourceHash);
for (const path of ["package.json", "package-lock.json", "build.js"]) inputHash.update(await readFile(path));
const complete = `${npmVersion}\n${inputHash.digest("hex")}\n`;
const marker = `${npmTarget}/payload-complete.txt`;
let reusable = false;
if (await readIfPresent(marker) === complete) {
  try { reusable = await payloadHash(npmTarget) === sourceHash; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
if (!reusable) {
  // Remove the old completion marker before copying; publish only after verification.
  await rm(npmAssets, { recursive: true, force: true });
  await mkdir(npmAssets, { recursive: true });
  await cp("node_modules/npm", npmTarget, { recursive: true, dereference: true });
  if (await payloadHash(npmTarget) !== sourceHash) throw new Error("Incomplete npm payload copy");
  await writeFile(marker, complete);
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
