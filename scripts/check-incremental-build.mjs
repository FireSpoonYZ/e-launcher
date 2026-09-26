// Run: node --test scripts/check-incremental-build.mjs
// Also exercise real Gradle tasks (requires prepared dependencies/JDK/SDK/keystore):
// CHECK_GRADLE_INCREMENTAL=1 node --test scripts/check-incremental-build.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFile(path, 'utf8');
async function put(path, content) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, content);
}
const runNode = (cwd, ...args) => execFileSync(process.execPath, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('runtime build reuses complete npm only and repairs changed/deleted assets', async () => {
  await mkdir(join(root, 'build'), { recursive: true });
  const fixture = await mkdtemp(join(root, 'build/incremental-runtime-'));
  const runtime = join(fixture, 'pi-runtime');
  const assets = join(fixture, 'app/src/main/assets');
  const sdk = join(runtime, 'node_modules/@earendil-works/pi-coding-agent');
  const npm = join(runtime, 'node_modules/npm');
  const payload = join(assets, 'npm/11.6.2');
  const marker = join(payload, 'payload-complete.txt');
  const bundle = join(assets, 'pi-runtime.cjs');
  try {
    await put(join(runtime, 'package.json'), JSON.stringify({ type: 'module', dependencies: { npm: '11.6.2' } }));
    await put(join(runtime, 'package-lock.json'), '{}');
    await cp(join(root, 'pi-runtime/build.js'), join(runtime, 'build.js'));
    await put(join(runtime, 'android.js'), 'import { value } from "./value.js"; console.log(value);');
    await put(join(runtime, 'value.js'), 'export const value = "first-bundle";');
    for (const name of ['package.json', 'README.md', 'CHANGELOG.md', 'docs/old.md', 'dist/modes/interactive/theme/dark.json', 'dist/core/export-html/template.html']) {
      await put(join(sdk, name), name === 'package.json' ? '{}' : name);
    }
    await put(join(sdk, 'docs/ignored.d.ts'), 'ignored');
    await put(join(npm, 'package.json'), '{"version":"11.6.2"}');
    await put(join(npm, 'bin/npm-cli.js'), 'console.log("npm");');
    await symlink(join(root, 'pi-runtime/node_modules/esbuild'), join(runtime, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
    const build = () => runNode(runtime, 'build.js');
    build();
    assert.equal(runNode(runtime, bundle).trim(), 'first-bundle');
    const firstMarker = await read(marker);
    const firstTime = (await stat(marker)).mtimeMs;
    const firstPayloadTime = (await stat(join(payload, 'bin/npm-cli.js'))).mtimeMs;
    build();
    assert.equal((await stat(marker)).mtimeMs, firstTime, 'no-op must not republish npm');
    assert.equal((await stat(join(payload, 'bin/npm-cli.js'))).mtimeMs, firstPayloadTime, 'no-op must not copy npm');
    await put(join(runtime, 'value.js'), 'export const value = "updated-bundle";');
    await rm(join(sdk, 'docs/old.md'));
    build();
    assert.equal(runNode(runtime, bundle).trim(), 'updated-bundle');
    assert.equal((await stat(marker)).mtimeMs, firstTime, 'JS-only changes must reuse npm');
    await assert.rejects(stat(join(assets, 'pi-sdk/docs/old.md')), { code: 'ENOENT' });
    await assert.rejects(stat(join(assets, 'pi-sdk/docs/ignored.d.ts')), { code: 'ENOENT' });
    await put(join(npm, 'bin/npm-cli.js'), 'console.log("changed npm");');
    build();
    assert.notEqual(await read(marker), firstMarker, 'same-version payload edits invalidate the marker');
    assert.equal(await read(join(payload, 'bin/npm-cli.js')), await read(join(npm, 'bin/npm-cli.js')));
    const changedMarker = await read(marker);
    await put(join(runtime, 'package-lock.json'), '{"lockfileVersion":3}');
    build();
    assert.notEqual(await read(marker), changedMarker, 'lockfile changes invalidate the marker');
    await rm(join(payload, 'bin/npm-cli.js'));
    await rm(bundle);
    await rm(join(assets, 'pi-sdk/README.md'));
    build();
    assert.equal(runNode(runtime, bundle).trim(), 'updated-bundle');
    assert.equal(await read(join(payload, 'bin/npm-cli.js')), await read(join(npm, 'bin/npm-cli.js')));
    assert.equal(await read(join(assets, 'pi-sdk/README.md')), 'README.md');
    await put(join(payload, 'unwanted.txt'), 'stale');
    build();
    await assert.rejects(stat(join(payload, 'unwanted.txt')), { code: 'ENOENT' });

    // Fault-inject a failed copy through Node's builtin module, not a fake build implementation.
    await rm(join(payload, 'bin/npm-cli.js'));
    await put(join(runtime, 'fail-copy.js'), `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const copy = fs.cp;
fs.cp = async (source, target, options) => {
  if (source !== 'node_modules/npm') return copy(source, target, options);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(target + '/partial.txt', 'incomplete');
  throw new Error('injected copy failure');
};
syncBuiltinESMExports();
await import('./build.js');
`);
    assert.throws(() => runNode(runtime, 'fail-copy.js'), /injected copy failure/);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
    build();
    await assert.rejects(stat(join(payload, 'partial.txt')), { code: 'ENOENT' });
    assert.equal(await read(join(payload, 'bin/npm-cli.js')), await read(join(npm, 'bin/npm-cli.js')));
    await put(join(runtime, 'package.json'), JSON.stringify({ type: 'module', dependencies: { npm: '11.6.3' } }));
    assert.throws(build, /differs from the pinned version/);
    await put(join(npm, 'package.json'), '{"version":"11.6.3"}');
    build();
    await assert.rejects(stat(payload), { code: 'ENOENT' });
    assert.ok((await read(join(assets, 'npm/11.6.3/payload-complete.txt'))).startsWith('11.6.3\n'));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('Gradle no-op, source invalidation, and missing output recovery', { skip: process.env.CHECK_GRADLE_INCREMENTAL !== '1' }, async () => {
  // Dependencies may be read-only junctions; never run npm ci from this check.
  const args = [':app:copyWebAssets', ':app:buildPiRuntime', '-x', ':app:installPiDependencies', '--no-daemon', '--console=plain', '--info'];
  let invocation = 0;
  const gradle = () => {
    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/c', 'gradlew.bat', ...args], { cwd: root, encoding: 'utf8' })
      : spawnSync('./gradlew', args, { cwd: root, encoding: 'utf8' });
    writeFileSync(join(root, `build/incremental-gradle-${++invocation}.log`), `${result.stdout}\n${result.stderr}`);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const android = join(root, 'pi-runtime/android.js');
  const original = await read(android);
  const probe = `incremental-check-${process.pid}`;
  const publicFile = join(root, `web/public/${probe}.txt`);
  const copiedFile = join(root, `app/src/main/assets/public/${probe}.txt`);
  const bundle = join(root, 'app/src/main/assets/pi-runtime.cjs');
  const marker = join(root, 'app/src/main/assets/npm/11.6.2/payload-complete.txt');
  const sideProducts = ['app/src/main/assets/capacitor.config.json', 'app/src/main/res/xml/config.xml', 'capacitor-cordova-android-plugins/src/main/AndroidManifest.xml'];
  const backups = await Promise.all(sideProducts.map((path) => read(join(root, path))));
  try {
    gradle();
    const noOp = gradle();
    for (const task of ['buildWeb', 'copyWebAssets', 'buildPiRuntime']) {
      assert.ok(noOp.includes(`> Task :app:${task} UP-TO-DATE`), noOp);
    }
    const npmTime = (await stat(marker)).mtimeMs;
    await put(publicFile, 'fresh Web asset');
    await writeFile(android, `${original}\nglobalThis.__incrementalBuildCheck = ${JSON.stringify(probe)};\n`);
    const changed = gradle();
    assert.ok(!changed.includes(':app:buildPiRuntime UP-TO-DATE'), changed);
    assert.equal(await read(copiedFile), 'fresh Web asset');
    assert.ok((await read(bundle)).includes(probe), 'bundle must contain the changed runtime source');
    assert.equal((await stat(marker)).mtimeMs, npmTime, 'Gradle JS change must reuse npm');
    await rm(bundle);
    await rm(join(root, 'app/src/main/assets/npm/11.6.2/bin/npm-cli.js'));
    await rm(join(root, 'app/src/main/assets/pi-sdk/README.md'));
    await rm(join(root, `web/dist/${probe}.txt`));
    await rm(copiedFile);
    for (const path of sideProducts) await rm(join(root, path));
    gradle();
    assert.ok((await read(bundle)).includes(probe));
    assert.equal(await read(copiedFile), 'fresh Web asset');
    for (const path of [...sideProducts, 'app/src/main/assets/pi-sdk/README.md', 'app/src/main/assets/npm/11.6.2/bin/npm-cli.js']) {
      assert.ok((await stat(join(root, path))).isFile(), `missing output: ${path}`);
    }
  } finally {
    await writeFile(android, original);
    await rm(publicFile, { force: true });
    try {
      gradle(); // Leave bundles matching the restored source, and remove the stale Web probe.
    } finally {
      for (let i = 0; i < sideProducts.length; i++) await writeFile(join(root, sideProducts[i]), backups[i]);
    }
  }
  await assert.rejects(stat(copiedFile), { code: 'ENOENT' });
  assert.ok(!(await read(bundle)).includes(probe));
});
