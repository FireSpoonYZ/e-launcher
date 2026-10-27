import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, extractArtifact, readJson } from './archive.js';

const key = (value) => Buffer.from(value).toString('base64url');

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, file);
}

export function runNpm(npmPath, args, cwd) {
  if (!npmPath) throw Object.assign(new Error('npm CLI is unavailable'), { code: 'NPM_UNAVAILABLE' });
  const script = /\.[cm]?js$/i.test(npmPath);
  return new Promise((resolve, reject) => {
    const child = spawn(script ? process.execPath : npmPath, script ? [npmPath, ...args] : args, {
      cwd, stdio: 'ignore', shell: false,
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    });
    child.once('error', (error) => {
      if (error.code === 'ENOENT') error.code = 'NPM_UNAVAILABLE';
      reject(error);
    });
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('npm preparation failed')));
  });
}

export function openManagedInstaller({ dataRoot, npmPath, fetchArtifact, report, withActivation }) {
  const root = path.join(dataRoot, 'managed-install');
  let queue = Promise.resolve();
  let closed = false;
  const instance = (id) => path.join(root, key(id));
  const currentFile = (id) => path.join(instance(id), 'current.json');

  async function getInstalled(id) {
    try {
      const current = await readJson(currentFile(id));
      if (current.removed) return null;
      return { installationId: id, version: current.version, packageRoot: current.packageRoot,
        dataDir: path.join(instance(id), 'data'), manifest: current.manifest };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function applyPlan(plan) {
    const prior = await getInstalled(plan.installationId);
    let actual = prior?.version ?? null;
    const receipt = (phase, error = null) => ({
      deviceId: plan.deviceId, installationId: plan.installationId, operationId: plan.operationId, planId: plan.planId,
      desiredRevision: plan.desiredRevision, appliedRevision: phase === 'applied' || phase === 'removed' ? plan.desiredRevision : null,
      actualVersion: actual, phase, health: error ? 'unsupported' : phase === 'removed' || (phase === 'applied' && plan.action === 'disable') ? 'disabled' : 'ready', error,
    });
    const emit = async (phase) => { const result = receipt(phase); await report(result); return result; };
    try {
      let appliedPlan = null;
      try { appliedPlan = await readJson(currentFile(plan.installationId)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (appliedPlan?.planId === plan.planId) return await emit(plan.action === 'uninstall' ? 'removed' : 'applied');
      const platform = process.env.ANDROID_ROOT ? 'android' : process.platform === 'win32' ? 'windows' : process.platform;
      if (plan.action !== 'disable' && plan.action !== 'uninstall' && plan.kind === 'plugin' &&
          !plan.manifest.platforms.includes(platform)) {
        throw Object.assign(new Error('Package does not support this platform'), { code: 'PLATFORM_UNSUPPORTED' });
      }
      if (plan.action === 'disable' || plan.action === 'uninstall') {
        await emit('waiting-idle');
        const applied = await withActivation(plan.installationId, async () => {
          const current = plan.action === 'disable' && prior
            ? { ...appliedPlan, planId: plan.planId, disabled: true }
            : { planId: plan.planId, removed: true, disabled: plan.action === 'disable' };
          await writeJson(currentFile(plan.installationId), current);
        });
        if (!applied) return receipt('waiting-idle');
        if (plan.action === 'uninstall') actual = null;
        return await emit(plan.action === 'uninstall' ? 'removed' : 'applied');
      }
      if ((plan.action === 'enable' || appliedPlan?.disabled) && prior?.version === plan.targetVersion) {
        let state = null;
        try { state = await readJson(prior.packageRoot + '.state.json'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (state?.status === 'ready' && state.digest === plan.digest && state.version === plan.targetVersion) {
          await emit('waiting-idle');
          const applied = await withActivation(plan.installationId, async () => {
            await emit('activating');
            await writeJson(currentFile(plan.installationId), { ...appliedPlan, planId: plan.planId, disabled: false, manifest: plan.manifest });
          });
          if (!applied) return receipt('waiting-idle');
          return await emit('applied');
        }
      }
      const dir = instance(plan.installationId);
      const versionDir = path.join(dir, 'versions', key(plan.planId));
      const prepared = versionDir + '.state.json';
      let state = null;
      try { state = await readJson(prepared); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (state && state.status !== 'ready') {
        throw Object.assign(new Error('Preparation was interrupted'), { code: 'INTERRUPTED' });
      }
      const ready = state?.digest === plan.digest && state?.version === plan.targetVersion;
      if (!ready) {
        await writeJson(prepared, { status: 'preparing', digest: plan.digest, version: plan.targetVersion });
        await rm(versionDir, { recursive: true, force: true });
        if (plan.artifactRef) {
          await emit('downloading');
          const bytes = await fetchArtifact(plan.artifactRef);
          if (digest(bytes) !== plan.digest) throw new Error('Artifact digest mismatch');
          await extractArtifact(bytes, versionDir);
        } else {
          await mkdir(versionDir, { recursive: true });
        }
        await emit('preparing');
        if (plan.lockfile) {
          await writeFile(path.join(versionDir, 'package-lock.json'), JSON.stringify(plan.lockfile));
          await runNpm(npmPath, ['ci', '--omit=peer', '--no-audit', '--no-fund'], versionDir);
        }
        await writeJson(prepared, { status: 'ready', digest: plan.digest, version: plan.targetVersion });
      }
      await mkdir(path.join(dir, 'data'), { recursive: true });
      await emit('waiting-idle');
      const applied = await withActivation(plan.installationId, async () => {
        await emit('activating');
        await writeJson(currentFile(plan.installationId), {
          planId: plan.planId, removed: false, version: plan.targetVersion, packageRoot: versionDir, manifest: plan.manifest,
        });
      });
      if (!applied) return receipt('waiting-idle');
      actual = plan.targetVersion;
      return await emit('applied');
    } catch (error) {
      const code = ['NPM_UNAVAILABLE', 'INTERRUPTED', 'PLATFORM_UNSUPPORTED'].includes(error.code) ? error.code : 'INSTALL_FAILED';
      const message = code === 'NPM_UNAVAILABLE' ? 'npm CLI is unavailable' : code === 'INTERRUPTED' ? 'Preparation interrupted; retry explicitly' : code === 'PLATFORM_UNSUPPORTED' ? 'Package does not support this platform' : 'Package deployment failed';
      const result = receipt('failed', { code, message });
      await report(result);
      return result;
    }
  }

  return {
    apply(plan) {
      if (closed) return Promise.reject(new Error('Installer is closed'));
      const result = queue.then(() => applyPlan(plan));
      queue = result.catch(() => {});
      return result;
    },
    getInstalled,
    async close() { closed = true; await queue; },
  };
}
