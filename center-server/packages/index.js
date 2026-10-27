import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import pacote from 'pacote';
import semver from 'semver';
import { containedPath, digest, extractArtifact, MAX_ARTIFACT_SIZE, readJson } from '../../host-core/managed-install/archive.js';
import { openManagedInstaller, runNpm } from '../../host-core/managed-install/index.js';

const key = (value) => Buffer.from(value).toString('base64url');
const error = (code, message) => Object.assign(new Error(message), { code });
const credential = { type: 'string', format: 'credential-ref' };
const mcpSchema = (url) => ({
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object',
  properties: {
    url: { type: 'string', ...(url ? { default: url } : {}) }, command: { type: 'string' },
    bin: { type: 'string' }, args: { type: 'array', items: { type: 'string' } },
    cwd: { type: 'string' }, env: { type: 'object', additionalProperties: { type: 'string' } },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    timeoutMs: { type: 'number' }, transport: { type: 'string', enum: ['stdio', 'http'] },
    oauth: { type: 'boolean', default: false },
    apiKeyRef: credential, envRefs: { type: 'object', additionalProperties: credential },
    headerRefs: { type: 'object', additionalProperties: credential },
  }, additionalProperties: false,
});

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

export function openPackageManager({ dataRoot, store, npmPath, withActivation, onChange = () => {} }) {
  const root = path.join(dataRoot, 'packages');
  const artifacts = path.join(root, 'artifacts');
  const metadata = path.join(root, 'metadata');
  const registry = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY;
  const pacoteOptions = registry ? { registry } : {};
  const manifestSchema = JSON.parse(readFileSync(new URL('../../center-contract/manifest.schema.json', import.meta.url), 'utf8'));
  const ajv = new Ajv({ strict: false });
  ajv.addFormat('credential-ref', true);
  const validateManifest = ajv.compile(manifestSchema);
  let queue = Promise.resolve();
  let closed = false;
  const waiting = new Map();
  const changing = new Set();
  const reconciling = new Map();
  let retryQueued = false;
  for (const op of store.listOperations()) {
    if (op.target === 'center' && ['queued', 'downloading', 'preparing', 'waiting-idle', 'activating'].includes(op.phase)) {
      store.updateOperation(op.operationId, { phase: 'failed', error: { code: 'INTERRUPTED', message: 'Operation interrupted; retry explicitly' } });
    }
  }
  const retryTimer = setInterval(() => {
    if (!waiting.size || closed || retryQueued) return;
    retryQueued = true;
    enqueue(async () => {
      try {
        for (const [id, pending] of waiting) {
          const receipt = await installer.apply(pending.plan);
          store.updateOperation(pending.operationId, { phase: receipt.phase, error: receipt.error });
          if (receipt.phase !== 'waiting-idle') {
            waiting.delete(id);
            if (receipt.phase === 'applied' || receipt.phase === 'removed') onChange(id);
          }
        }
      } finally { retryQueued = false; }
    });
  }, 1000);
  retryTimer.unref?.();

  async function saveArtifact(bytes) {
    if (bytes.length > MAX_ARTIFACT_SIZE) throw error('PAYLOAD_TOO_LARGE', 'Artifact exceeds size limit');
    const sum = digest(bytes);
    const ref = createHash('sha256').update(bytes).digest('hex');
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, ref), bytes, { flag: 'wx' }).catch((err) => {
      if (err.code !== 'EEXIST') throw err;
    });
    return { artifactRef: ref, digest: sum, size: bytes.length };
  }

  async function uploadArtifact(input) {
    let size = 0;
    const chunks = [];
    for await (const chunk of input) {
      size += chunk.length;
      if (size > MAX_ARTIFACT_SIZE) throw error('PAYLOAD_TOO_LARGE', 'Artifact exceeds size limit');
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    const temporary = path.join(root, 'upload-' + randomUUID());
    try { await extractArtifact(bytes, temporary); }
    finally { await rm(temporary, { recursive: true, force: true }); }
    return saveArtifact(bytes);
  }

  async function readArtifact(ref) {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw error('INVALID_ARGUMENT', 'Invalid artifact reference');
    try { return await readFile(path.join(artifacts, ref)); }
    catch (err) { if (err.code === 'ENOENT') throw error('NOT_FOUND', 'Artifact not found'); throw err; }
  }

  const metaFile = (id) => path.join(metadata, key(id) + '.json');
  async function getMeta(id) {
    try { return await readJson(metaFile(id)); }
    catch (err) { if (err.code === 'ENOENT') throw error('NOT_FOUND', 'Installation metadata not found'); throw err; }
  }

  async function resolveVersion(kind, source, version, target) {
    if (kind === 'skill' && target !== 'host') throw error('INVALID_ARGUMENT', 'Skills require a Host target');
    if (source.type === 'http') {
      if (kind !== 'mcp') throw error('INVALID_ARGUMENT', 'HTTP source requires MCP');
      const url = new URL(source.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw error('INVALID_ARGUMENT', 'Invalid HTTP MCP URL');
      }
      const id = 'http-' + createHash('sha256').update(url.href).digest('hex');
      return { packageVersion: { packageId: id, version: '1.0.0', kind, digest: digest(Buffer.from(url.href)),
        artifactRef: null, manifest: {}, configSchema: mcpSchema(url.href), resolved: url.href, integrity: null }, lockfile: null };
    }
    let bytes, resolved = null, integrity = null, expected = null;
    if (source.type === 'npm') {
      const split = source.spec.lastIndexOf('@');
      const suffix = split > 0 ? source.spec.slice(split + 1) : '';
      const name = split > 0 ? source.spec.slice(0, split) : source.spec;
      if (!/^(?:@[a-z0-9][a-z0-9._~-]*\x2f)?[a-z0-9][a-z0-9._~-]*$/i.test(name) ||
          (suffix && !semver.validRange(suffix) && !/^[a-z][a-z0-9._-]*$/i.test(suffix))) {
        throw error('INVALID_ARGUMENT', 'Only npm registry package specifications are supported');
      }
      // Resolve version through pacote, then fetch the exact resolved tarball.
      const selected = version ? versionSpec(source.spec, version) : source.spec;
      expected = await pacote.manifest(selected, pacoteOptions);
      if (!semver.valid(expected.version) || !expected._resolved || !expected._integrity) {
        throw error('INVALID_ARGUMENT', 'Registry package did not resolve to an immutable version');
      }
      resolved = expected._resolved;
      const resolvedUrl = new URL(resolved);
      if (!['http:', 'https:'].includes(resolvedUrl.protocol) || resolvedUrl.username || resolvedUrl.password) {
        throw error('VALIDATION_FAILED', 'Invalid registry artifact URL');
      }
      integrity = String(expected._integrity);
      bytes = await pacote.tarball.stream(resolved, async (stream) => {
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > MAX_ARTIFACT_SIZE) throw error('PAYLOAD_TOO_LARGE', 'Artifact exceeds size limit');
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      }, { ...pacoteOptions, integrity });
    } else if (source.type === 'artifact') {
      bytes = await readArtifact(source.artifactRef);
    } else throw error('INVALID_ARGUMENT', 'Unsupported package source');
    const saved = await saveArtifact(bytes);
    const temp = path.join(root, 'stage-' + randomUUID());
    try {
      await extractArtifact(bytes, temp);
      let pkg = null;
      try { pkg = await readJson(path.join(temp, 'package.json')); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (kind !== 'skill' && !pkg) throw error('VALIDATION_FAILED', 'package.json is required');
      if (expected && (pkg?.name !== expected.name || pkg?.version !== expected.version)) {
        throw error('VALIDATION_FAILED', 'Package identity does not match registry');
      }
      let manifest = {}, configSchema = { type: 'object', properties: {}, additionalProperties: false }, uiSchema;
      let packageId = pkg?.name, packageVersion = pkg?.version;
      if (kind === 'plugin') {
        manifest = await readJson(path.join(temp, 'capability.json'));
        if (!validateManifest(manifest) || !semver.valid(manifest.version)) throw error('VALIDATION_FAILED', 'Invalid native manifest');
        if (!manifest.components[target]) throw error('INVALID_ARGUMENT', 'Package has no component for target');
        if (pkg?.version !== manifest.version) throw error('VALIDATION_FAILED', 'Package version does not match native manifest');
        for (const component of Object.values(manifest.components)) await stat(containedPath(temp, component.entry));
        configSchema = await readJson(containedPath(temp, manifest.configSchema));
        if (!ajv.validateSchema(configSchema)) throw error('VALIDATION_FAILED', 'Invalid configuration schema');
        if (manifest.uiSchema) uiSchema = await readJson(containedPath(temp, manifest.uiSchema));
        packageId = manifest.id;
        packageVersion = manifest.version;
        for (const name of ['@earendil-works/pi-durable', '@earendil-works/chord', '@earendil-works/pi-ai']) {
          if (pkg.dependencies?.[name] || pkg.optionalDependencies?.[name]) {
            throw error('VALIDATION_FAILED', 'Host engine must be a peer dependency');
          }
        }
      } else if (kind === 'mcp') {
        configSchema = mcpSchema();
        manifest = { bin: pkg.bin ?? {} };
      } else if (kind === 'skill') {
        let capability = {};
        try { capability = await readJson(path.join(temp, 'capability.json')); }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
        let hasRoot = false;
        try { hasRoot = (await stat(path.join(temp, 'SKILL.md'))).isFile(); }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
        const dirs = hasRoot ? ['.'] : capability.skills ?? pkg?.pi?.skills ?? ['.'];
        if (!Array.isArray(dirs) || !dirs.length) throw error('VALIDATION_FAILED', 'Invalid skill directories');
        let found = false;
        async function scan(dir) {
          const entries = await readdir(dir, { withFileTypes: true });
          if (entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile())) { found = true; return; }
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') await scan(path.join(dir, entry.name));
          }
        }
        for (const dir of dirs) await scan(containedPath(temp, dir));
        if (!found) throw error('VALIDATION_FAILED', 'No managed SKILL.md found');
        manifest = { skills: dirs };
        packageId ||= 'skill-' + saved.artifactRef;
        packageVersion ||= '1.0.0';
      } else throw error('INVALID_ARGUMENT', 'Unknown capability kind');
      if (!packageId || !semver.valid(packageVersion)) throw error('VALIDATION_FAILED', 'Package requires an exact version');
      let lockfile = null;
      if (kind !== 'skill') {
        const lockPath = path.join(temp, 'package-lock.json');
        try { lockfile = await readJson(lockPath); }
        catch (err) {
          if (err.code !== 'ENOENT') throw err;
          await runNpm(npmPath, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], temp);
          lockfile = await readJson(lockPath);
        }
      }
      return { packageVersion: { packageId, version: packageVersion, kind, digest: saved.digest,
        artifactRef: saved.artifactRef, manifest, configSchema, ...(uiSchema === undefined ? {} : { uiSchema }),
        resolved, integrity }, lockfile };
    } finally { await rm(temp, { recursive: true, force: true }); }
  }

  function versionSpec(spec, version) {
    if (!semver.valid(version)) throw error('INVALID_ARGUMENT', 'Update requires exact version');
    const name = spec.startsWith('@') ? spec.slice(0, spec.indexOf('@', 1) < 0 ? undefined : spec.indexOf('@', 1))
      : spec.split('@')[0];
    return name + '@' + version;
  }

  const installer = openManagedInstaller({
    dataRoot, npmPath, fetchArtifact: readArtifact,
    withActivation,
    report: async (receipt) => {
      store.putDeploymentReceipt(receipt);
      store.updateOperation(receipt.operationId, { phase: receipt.phase, error: receipt.error });
    },
  });

  function enqueue(work) {
    queue = queue.then(work).catch(() => {});
  }
  function accept(action, id, request, target, deviceIds, work) {
    if (closed) throw error('INVALID_STATE', 'Package manager is closed');
    if (!request.requestId) throw error('INVALID_ARGUMENT', 'requestId is required');
    const op = { operationId: randomUUID(), requestId: request.requestId, action,
      installationId: id, target, deviceIds, phase: 'queued', error: null };
    const fingerprint = createHash('sha256').update(JSON.stringify({ action, id: action === 'install' ? null : id, request })).digest('hex');
    const saved = store.putOperation(op, fingerprint);
    if (saved.operationId !== op.operationId) return { operationId: saved.operationId };
    enqueue(async () => {
      try { await work(op); }
      catch (err) {
        const known = ['NPM_UNAVAILABLE', 'INVALID_ARGUMENT', 'VALIDATION_FAILED', 'INVALID_STATE', 'PAYLOAD_TOO_LARGE'];
        const code = known.includes(err.code) ? err.code : 'INSTALL_FAILED';
        store.updateOperation(op.operationId, { phase: 'failed', error: { code, message: code === 'NPM_UNAVAILABLE' ? 'npm CLI is unavailable' : 'Package operation failed' } });
      }
    });
    return { operationId: op.operationId };
  }

  function planFor(installation, meta, op, deviceId, action = op.action) {
    const v = meta.versions[installation.targetVersion];
    return { protocol: 1, target: installation.target, deviceId, operationId: op.operationId,
      installationId: installation.installationId, packageId: installation.packageId, kind: installation.kind,
      targetVersion: installation.targetVersion, manifest: v.packageVersion.manifest,
      artifactRef: v.packageVersion.artifactRef, digest: v.packageVersion.digest, resolved: v.packageVersion.resolved,
      integrity: v.packageVersion.integrity, lockfile: v.lockfile, action };
  }

  async function dispatch(installation, meta, op) {
    if (installation.target === 'center') {
      const action = installation.enabled ? op.action : op.action === 'uninstall' ? 'uninstall' : 'disable';
      const plan = { ...planFor(installation, meta, op, null, action), planId: randomUUID(), desiredRevision: installation.revision };
      waiting.delete(installation.installationId);
      const receipt = await installer.apply(plan);
      store.updateOperation(op.operationId, { phase: receipt.phase, error: receipt.error });
      if (receipt.phase === 'waiting-idle') waiting.set(installation.installationId, { plan, operationId: op.operationId });
      if (receipt.phase === 'applied' || receipt.phase === 'removed') onChange(installation.installationId);
      return;
    }
    const devices = [...new Set(store.listBotBindings({ installationId: installation.installationId }).map((b) => b.deviceId))];
    for (const device of devices) await reconcileDevice(device);
    // Host receipts complete the operation separately; an unassigned installation remains queued.
  }

  async function install(request) {
    const id = randomUUID();
    return accept('install', id, request, request.target, [], async (op) => {
      store.updateOperation(op.operationId, { phase: 'downloading', error: null });
      const v = await resolveVersion(request.kind, request.source, null, request.target);
      store.putPackageVersion(v.packageVersion);
      const meta = { versions: { [v.packageVersion.version]: { ...v, source: request.source } }, history: [v.packageVersion.version], operationId: op.operationId, action: 'install' };
      await atomicJson(metaFile(id), meta);
      const installation = store.putInstallation({ installationId: id, packageId: v.packageVersion.packageId,
        displayName: request.displayName, kind: request.kind, source: request.source, target: request.target,
        targetVersion: v.packageVersion.version, enabled: true, revision: 0 }, null);
      onChange(id);
      await dispatch(installation, meta, op);
    });
  }

  function existing(id) {
    const value = store.getInstallation(id);
    if (!value) throw error('NOT_FOUND', 'Installation not found');
    return value;
  }

  async function change(id, request, action) {
    const installation = existing(id);
    const devices = [...new Set(store.listBotBindings({ installationId: id }).map((b) => b.deviceId))];
    return accept(action, id, request, installation.target, devices, async (op) => {
      const current = existing(id);
      const pending = waiting.get(id);
      if (pending) {
        waiting.delete(id);
        store.updateOperation(pending.operationId, { phase: 'failed', error: { code: 'INTERRUPTED', message: 'Operation superseded' } });
      }
      const oldMeta = await getMeta(id);
      const meta = structuredClone(oldMeta);
      let targetVersion = current.targetVersion;
      let source = current.source;
      if (action === 'update') {
        store.updateOperation(op.operationId, { phase: 'downloading', error: null });
        if (!semver.valid(request.targetVersion)) throw error('INVALID_ARGUMENT', 'Update requires exact version');
        if (current.source.type === 'artifact') {
          if (request.source?.type !== 'artifact' || !request.source.artifactRef) throw error('INVALID_ARGUMENT', 'Update requires an uploaded artifact');
          source = request.source;
        } else if (current.source.type !== 'npm' || request.source) {
          throw error('INVALID_ARGUMENT', 'Invalid update source');
        }
        const v = await resolveVersion(current.kind, source, request.targetVersion, current.target);
        if (v.packageVersion.packageId !== current.packageId || v.packageVersion.version !== request.targetVersion) {
          throw error('VALIDATION_FAILED', 'Update package identity mismatch');
        }
        store.putPackageVersion(v.packageVersion);
        targetVersion = v.packageVersion.version;
        meta.versions[targetVersion] = { ...v, source };
      } else if (action === 'rollback') {
        targetVersion = meta.history.at(-2);
        if (!targetVersion) throw error('INVALID_STATE', 'No previous version');
        source = meta.versions[targetVersion].source;
      }
      if (targetVersion !== current.targetVersion) meta.history.push(targetVersion);
      meta.operationId = op.operationId;
      meta.action = action;
      changing.add(id);
      let next;
      try {
        await atomicJson(metaFile(id), meta);
        try {
          next = store.putInstallation({ ...current, source, targetVersion,
            enabled: action === 'enable' ? true : action === 'disable' || action === 'uninstall' ? false : current.enabled }, current.revision);
        } catch (err) {
          await atomicJson(metaFile(id), oldMeta);
          throw err;
        }
      } finally { changing.delete(id); }
      onChange(id);
      await dispatch(next, meta, op);
    });
  }

  async function reconcileDeviceNow(deviceId) {
    const bindings = store.listBotBindings({ deviceId });
    const previousPlans = store.listDeploymentPlans(deviceId);
    for (const id of new Set([...bindings.map((binding) => binding.installationId), ...previousPlans.map((plan) => plan.installationId)])) {
      const installation = store.getInstallation(id);
      if (!installation || installation.target !== 'host' || changing.has(id)) continue;
      const meta = await getMeta(id);
      if (changing.has(id) || store.getInstallation(id)?.revision !== installation.revision) continue;
      const op = store.getOperation(meta.operationId);
      if (!op) continue;
      const enabled = installation.enabled && bindings.some((binding) => binding.installationId === id && binding.enabled);
      const action = enabled ? (meta.action === 'disable' || meta.action === 'uninstall' ? 'install' : meta.action) : 'disable';
      const plan = planFor(installation, meta, op, deviceId, action);
      const previous = previousPlans.find((item) => item.installationId === id);
      const previousContent = previous && Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'planId' && key !== 'desiredRevision'));
      if (JSON.stringify(previousContent) !== JSON.stringify(plan)) {
        store.putDeploymentPlan({ ...plan, planId: randomUUID(), desiredRevision: (previous?.desiredRevision ?? 0) + 1 });
        onChange(id);
      }
    }
  }

  function reconcileDevice(deviceId) {
    const previous = reconciling.get(deviceId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => reconcileDeviceNow(deviceId));
    reconciling.set(deviceId, result);
    return result.finally(() => { if (reconciling.get(deviceId) === result) reconciling.delete(deviceId); });
  }

  async function listDeploymentPlans(deviceId) {
    await reconcileDevice(deviceId);
    return store.listDeploymentPlans(deviceId);
  }

  async function checkUpdates(id) {
    const installation = existing(id);
    if (installation.source.type !== 'npm') return [];
    const spec = installation.source.spec;
    const split = spec.lastIndexOf('@');
    const name = split > 0 ? spec.slice(0, split) : spec;
    const v = await resolveVersion(installation.kind, { type: 'npm', spec: name + '@latest' }, null, installation.target);
    return semver.gt(v.packageVersion.version, installation.targetVersion) ? [v.packageVersion] : [];
  }

  return {
    uploadArtifact, readArtifact, listDeploymentPlans, reconcileDevice, install,
    update: (id, request) => change(id, request, 'update'),
    enable: (id, request) => change(id, request, 'enable'),
    disable: (id, request) => change(id, request, 'disable'),
    uninstall: (id, request) => change(id, request, 'uninstall'),
    rollback: (id, request) => change(id, request, 'rollback'),
    checkUpdates, getInstalled: (id) => installer.getInstalled(id),
    async close() {
      closed = true;
      clearInterval(retryTimer);
      await queue;
      await Promise.allSettled([...reconciling.values()]);
      await installer.close();
    },
  };
}
