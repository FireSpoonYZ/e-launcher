import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import Ajv from 'ajv';
import deepmerge from 'deepmerge';

function error(code, message, details) {
  const result = new Error(message);
  result.code = code;
  if (details !== undefined) result.details = details;
  return result;
}

const merge = (base, overrides) => deepmerge(base, overrides, { arrayMerge: (_target, source) => source });
const parse = (row) => row ? JSON.parse(row.json) : null;
const json = (value) => JSON.stringify(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const pick = (value, fields) => Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));
const safeError = (value) => value == null ? null : { code: 'INTERNAL_ERROR', message: 'Operation failed' };
const safeReceipt = (receipt) => ({ ...receipt, error: safeError(receipt.error) });

function assertId(value) {
  if (typeof value !== 'string' || !value.trim()) throw error('INVALID_ARGUMENT', 'An identifier is required');
}
function assertObject(value) {
  if (!object(value)) throw error('INVALID_ARGUMENT', 'Expected an object');
}
function assertRevision(expected, actual) {
  if (expected !== actual) throw error('REVISION_CONFLICT', 'Revision does not match');
}

function collectCredentialRefs(schema, value, refs) {
  if (!schema || typeof schema !== 'object' || value == null) return;
  if (schema.type === 'string' && schema.format === 'credential-ref' && typeof value === 'string') {
    refs.add(value);
    return;
  }
  if (Array.isArray(value) && schema.items) {
    for (const item of value) collectCredentialRefs(schema.items, item, refs);
  } else if (object(value)) {
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties?.[key] ?? schema.additionalProperties;
      collectCredentialRefs(child, item, refs);
    }
  }
}

export function openCenterStore({ dataRoot, encryptionKey }) {
  if (typeof dataRoot !== 'string' || !isAbsolute(dataRoot)) throw error('INVALID_ARGUMENT', 'dataRoot must be absolute');
  if (!(encryptionKey instanceof Uint8Array) || encryptionKey.byteLength !== 32) {
    throw error('INVALID_ARGUMENT', 'encryptionKey must contain 32 bytes');
  }
  const key = Buffer.from(encryptionKey);
  mkdirSync(dataRoot, { recursive: true });
  const db = new DatabaseSync(join(dataRoot, 'center.sqlite'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const defaultsAjv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  ajv.addFormat('credential-ref', { type: 'string', validate: (value) => value.length > 0 });
  defaultsAjv.addFormat('credential-ref', { type: 'string', validate: (value) => value.length > 0 });

  function transaction(fn, mode = 'IMMEDIATE') {
    db.exec('BEGIN ' + mode);
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve original error. */ }
      throw err;
    }
  }
  function bump() {
    db.prepare('UPDATE metadata SET revision = revision + 1 WHERE id = 1').run();
  }
  function validate(schema, value, allowMissing = false, defaults = false) {
    let validator;
    try {
      validator = (defaults ? defaultsAjv : ajv).compile(schema);
    } catch {
      throw error('VALIDATION_FAILED', 'Invalid configuration schema');
    }
    if (validator(value)) return;
    const errors = validator.errors.filter((entry) => !allowMissing || entry.keyword !== 'required');
    if (errors.length) {
      throw error('VALIDATION_FAILED', 'Configuration is invalid', errors.map((entry) => ({
        path: entry.instancePath, keyword: entry.keyword,
      })));
    }
  }
  function get(table, id) {
    return parse(db.prepare('SELECT json FROM ' + table + ' WHERE id = ?').get(id));
  }
  function rows(table) {
    return db.prepare('SELECT json FROM ' + table + ' ORDER BY id').all().map(parse);
  }
  function save(table, id, value) {
    db.prepare('INSERT INTO ' + table + ' (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(id, json(value));
  }
  function createOrUpdate(table, input, idField, expected) {
    assertObject(input);
    const id = input[idField] || randomUUID();
    assertId(id);
    const current = get(table, id);
    if (expected === null) {
      if (current) throw error('REVISION_CONFLICT', 'Resource already exists');
    } else {
      if (!current) throw error('NOT_FOUND', 'Resource not found');
      assertRevision(expected, current.revision);
    }
    const result = { ...input, [idField]: id, revision: current ? current.revision + 1 : 0 };
    save(table, id, result);
    return result;
  }
  function packageFor(installation) {
    const row = db.prepare('SELECT json FROM package_versions WHERE package_id = ? AND version = ?').get(installation.packageId, installation.targetVersion);
    if (!row) throw error('NOT_FOUND', 'Package version not found');
    return parse(row);
  }
  function requireInstallation(id) {
    const installation = get('installations', id);
    if (!installation) throw error('NOT_FOUND', 'Installation not found');
    return installation;
  }
  function configFor(id) {
    const installation = requireInstallation(id);
    const pkg = packageFor(installation);
    const row = db.prepare('SELECT json, revision FROM installation_configs WHERE installation_id = ?').get(id);
    return {
      globalConfig: JSON.parse(row.json), configSchema: pkg.configSchema,
      ...(pkg.uiSchema === undefined ? {} : { uiSchema: pkg.uiSchema }), revision: row.revision,
    };
  }
  function bindingFor(deviceId, botId, id) {
    return parse(db.prepare('SELECT json FROM bindings WHERE device_id = ? AND bot_id = ? AND installation_id = ?').get(deviceId, botId, id))
      ?? { deviceId, botId, installationId: id, enabled: false, overrides: {}, revision: 0 };
  }
  function capabilityFor(deviceId, botId, id) {
    const config = configFor(id);
    const binding = bindingFor(deviceId, botId, id);
    return { ...binding, globalConfig: config.globalConfig, effectiveConfig: merge(config.globalConfig, binding.overrides), configSchema: config.configSchema };
  }
  function checkEnabledBindings(id, config, installation) {
    if (!installation.enabled) return;
    const bindings = db.prepare('SELECT json FROM bindings WHERE installation_id = ?').all(id).map(parse);
    for (const binding of bindings) {
      if (binding.enabled) validate(config.configSchema, merge(config.globalConfig, binding.overrides));
    }
  }
  function credential(id) {
    const row = db.prepare('SELECT revision, ciphertext FROM credentials WHERE id = ?').get(id);
    return row ? { credentialId: id, configured: row.ciphertext !== null, revision: row.revision } : null;
  }
  function resolveCredential(id) {
    const row = db.prepare('SELECT nonce, tag, ciphertext FROM credentials WHERE id = ?').get(id);
    if (!row || row.ciphertext === null) throw error('NOT_FOUND', 'Credential not configured');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
      decipher.setAAD(Buffer.from(id, 'utf8'));
      decipher.setAuthTag(row.tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw error('INTERNAL_ERROR', 'Credential decryption failed');
    }
  }
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    transaction(() => {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) throw error('UNSUPPORTED_SCHEMA', 'Unsupported center database schema');
      if (version === 0) {
        db.exec(`
          CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
          INSERT INTO metadata VALUES (1, 0);
          CREATE TABLE providers (id TEXT PRIMARY KEY, json TEXT NOT NULL);
          CREATE TABLE models (provider_id TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(provider_id, id));
          CREATE TABLE model_config (id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL, revision INTEGER NOT NULL);
          INSERT INTO model_config VALUES (1, '{}', 0);
          CREATE TABLE bot_models (device_id TEXT NOT NULL, bot_id TEXT NOT NULL, json TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(device_id, bot_id));
          CREATE TABLE device_bots (device_id TEXT NOT NULL, bot_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(device_id, bot_id));
          CREATE TABLE package_versions (package_id TEXT NOT NULL, version TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(package_id, version));
          CREATE TABLE installations (id TEXT PRIMARY KEY, json TEXT NOT NULL);
          CREATE TABLE installation_configs (installation_id TEXT PRIMARY KEY REFERENCES installations(id), json TEXT NOT NULL, revision INTEGER NOT NULL);
          CREATE TABLE bindings (device_id TEXT NOT NULL, bot_id TEXT NOT NULL, installation_id TEXT NOT NULL REFERENCES installations(id), json TEXT NOT NULL, PRIMARY KEY(device_id, bot_id, installation_id));
          CREATE TABLE credentials (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, nonce BLOB, tag BLOB, ciphertext BLOB);
          CREATE TABLE operations (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, json TEXT NOT NULL);
          CREATE TABLE deployment_receipts (device_id TEXT NOT NULL, installation_id TEXT NOT NULL, operation_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(device_id, installation_id, operation_id));
          CREATE TABLE deployment_plans (device_id TEXT NOT NULL, installation_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(device_id, installation_id));
          CREATE TABLE runtime_receipts (device_id TEXT PRIMARY KEY, json TEXT NOT NULL);
          PRAGMA user_version = 1;
        `);
      }
    });

    const store = {
      listProviders: () => rows('providers'),
      getProvider: (id) => get('providers', id),
      putProvider(provider, expectedRevision) {
        assertObject(provider);
        let url;
        try { url = new URL(provider.baseUrl); } catch { throw error('INVALID_ARGUMENT', 'Invalid provider URL'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw error('INVALID_ARGUMENT', 'Invalid provider URL');
        const input = pick(provider, ['id', 'name', 'api', 'baseUrl', 'credentialRef', 'enabled']);
        return transaction(() => { const value = createOrUpdate('providers', input, 'id', expectedRevision); bump(); return value; });
      },
      listModels(providerId) {
        return db.prepare('SELECT json FROM models WHERE provider_id = ? ORDER BY id').all(providerId).map(parse);
      },
      putModel(providerId, model, expectedRevision) {
        return transaction(() => {
          if (!get('providers', providerId)) throw error('NOT_FOUND', 'Provider not found');
          assertObject(model);
          const id = model.id || randomUUID();
          assertId(id);
          const current = parse(db.prepare('SELECT json FROM models WHERE provider_id = ? AND id = ?').get(providerId, id));
          if (expectedRevision === null) {
            if (current) throw error('REVISION_CONFLICT', 'Model already exists');
          } else {
            if (!current) throw error('NOT_FOUND', 'Model not found');
            assertRevision(expectedRevision, current.revision);
          }
          const result = { ...pick(model, ['name', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'thinkingLevelMap', 'cost', 'compat', 'inputLimits', 'enabled']), id, revision: current ? current.revision + 1 : 0 };
          db.prepare('INSERT INTO models VALUES (?, ?, ?) ON CONFLICT(provider_id, id) DO UPDATE SET json = excluded.json').run(providerId, id, json(result));
          bump();
          return result;
        });
      },
      getModelConfig() {
        const row = db.prepare('SELECT json, revision FROM model_config WHERE id = 1').get();
        return { global: JSON.parse(row.json), revision: row.revision };
      },
      putModelConfig(expectedRevision, global) {
        assertObject(global);
        return transaction(() => {
          const current = store.getModelConfig();
          assertRevision(expectedRevision, current.revision);
          db.prepare('UPDATE model_config SET json = ?, revision = ? WHERE id = 1').run(json(global), current.revision + 1);
          bump(); return store.getModelConfig();
        });
      },
      getBotModelConfig(deviceId, botId) {
        const global = store.getModelConfig().global;
        const row = db.prepare('SELECT json, revision FROM bot_models WHERE device_id = ? AND bot_id = ?').get(deviceId, botId);
        const overrides = row ? JSON.parse(row.json) : {};
        return { global, overrides, effective: merge(global, overrides), revision: row?.revision ?? 0 };
      },
      putBotModelConfig(deviceId, botId, expectedRevision, overrides) {
        assertId(deviceId); assertId(botId); assertObject(overrides);
        return transaction(() => {
          const current = store.getBotModelConfig(deviceId, botId);
          assertRevision(expectedRevision, current.revision);
          db.prepare('INSERT INTO bot_models VALUES (?, ?, ?, ?) ON CONFLICT(device_id, bot_id) DO UPDATE SET json = excluded.json, revision = excluded.revision').run(deviceId, botId, json(overrides), current.revision + 1);
          bump(); return store.getBotModelConfig(deviceId, botId);
        });
      },
      replaceDeviceBots(deviceId, bots) {
        assertId(deviceId);
        if (!Array.isArray(bots)) throw error('INVALID_ARGUMENT', 'bots must be an array');
        return transaction(() => {
          db.prepare('DELETE FROM device_bots WHERE device_id = ?').run(deviceId);
          const insert = db.prepare('INSERT INTO device_bots VALUES (?, ?, ?)');
          const seen = new Set();
          for (const bot of bots) {
            assertObject(bot); assertId(bot.botId);
            if (bot.deviceId !== deviceId || seen.has(bot.botId) || typeof bot.name !== 'string') throw error('INVALID_ARGUMENT', 'Invalid bot directory');
            seen.add(bot.botId);
            insert.run(deviceId, bot.botId, json({ deviceId, botId: bot.botId, name: bot.name }));
          }
          bump();
        });
      },
      listDeviceBots(deviceId) {
        return db.prepare('SELECT json FROM device_bots WHERE device_id = ? ORDER BY bot_id').all(deviceId).map(parse);
      },
      listBotBindings(filter = {}) {
        return db.prepare('SELECT json FROM bindings WHERE (? IS NULL OR device_id = ?) AND (? IS NULL OR installation_id = ?) ORDER BY device_id, bot_id, installation_id').all(filter.deviceId ?? null, filter.deviceId ?? null, filter.installationId ?? null, filter.installationId ?? null).map(parse);
      },
      listInstallations: () => rows('installations'),
      getInstallation: (id) => get('installations', id),
      getInstallationConfig: configFor,
      putInstallationConfig(id, input) {
        assertObject(input); assertObject(input.globalConfig);
        return transaction(() => {
          const installation = requireInstallation(id);
          const current = configFor(id);
          assertRevision(input.expectedRevision, current.revision);
          validate(current.configSchema, input.globalConfig, true);
          checkEnabledBindings(id, { ...current, globalConfig: input.globalConfig }, installation);
          db.prepare('UPDATE installation_configs SET json = ?, revision = ? WHERE installation_id = ?').run(json(input.globalConfig), current.revision + 1, id);
          bump(); return configFor(id);
        });
      },
      getBotCapability: capabilityFor,
      putBotCapability(deviceId, botId, id, input) {
        assertId(deviceId); assertId(botId); assertObject(input); assertObject(input.overrides);
        if (typeof input.enabled !== 'boolean') throw error('INVALID_ARGUMENT', 'enabled must be boolean');
        return transaction(() => {
          const config = configFor(id);
          const current = bindingFor(deviceId, botId, id);
          assertRevision(input.expectedRevision, current.revision);
          validate(config.configSchema, merge(config.globalConfig, input.overrides), !input.enabled);
          const binding = { deviceId, botId, installationId: id, enabled: input.enabled, overrides: input.overrides, revision: current.revision + 1 };
          db.prepare('INSERT INTO bindings VALUES (?, ?, ?, ?) ON CONFLICT(device_id, bot_id, installation_id) DO UPDATE SET json = excluded.json').run(deviceId, botId, id, json(binding));
          bump(); return capabilityFor(deviceId, botId, id);
        });
      },
      getCredential: credential,
      putCredential(id, input) {
        assertId(id); assertObject(input);
        if (typeof input.value !== 'string' || !input.value) throw error('INVALID_ARGUMENT', 'Credential value is required');
        return transaction(() => {
          const current = credential(id);
          if (input.expectedRevision === null) {
            if (current) throw error('REVISION_CONFLICT', 'Credential already exists');
          } else {
            if (!current) throw error('NOT_FOUND', 'Credential not found');
            assertRevision(input.expectedRevision, current.revision);
          }
          const nonce = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', key, nonce);
          cipher.setAAD(Buffer.from(id, 'utf8'));
          const ciphertext = Buffer.concat([cipher.update(input.value, 'utf8'), cipher.final()]);
          db.prepare('INSERT INTO credentials VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, nonce = excluded.nonce, tag = excluded.tag, ciphertext = excluded.ciphertext').run(id, current ? current.revision + 1 : 0, nonce, cipher.getAuthTag(), ciphertext);
          bump(); return credential(id);
        });
      },
      deleteCredential(id, expectedRevision) {
        return transaction(() => {
          const current = credential(id);
          if (!current || !current.configured) throw error('NOT_FOUND', 'Credential not found');
          assertRevision(expectedRevision, current.revision);
          db.prepare('UPDATE credentials SET revision = ?, nonce = NULL, tag = NULL, ciphertext = NULL WHERE id = ?').run(current.revision + 1, id);
          bump();
        });
      },
      resolveCredential,
      getPackageVersion(packageId, version) {
        return parse(db.prepare('SELECT json FROM package_versions WHERE package_id = ? AND version = ?').get(packageId, version));
      },
      putPackageVersion(version) {
        assertObject(version); assertId(version.packageId); assertId(version.version);
        return transaction(() => {
          const previous = store.getPackageVersion(version.packageId, version.version);
          if (previous && json(previous) !== json(version)) throw error('REQUEST_CONFLICT', 'Package version already exists');
          if (!previous) {
            db.prepare('INSERT INTO package_versions VALUES (?, ?, ?)').run(version.packageId, version.version, json(version));
            bump();
          }
        });
      },
      putInstallation(installation, expectedRevision) {
        return transaction(() => {
          assertObject(installation);
          const pkg = packageFor(installation);
          if (pkg.kind !== installation.kind) throw error('INVALID_ARGUMENT', 'Package kind does not match installation');
          const current = installation.installationId ? get('installations', installation.installationId) : null;
          const result = createOrUpdate('installations', pick(installation, ['installationId', 'packageId', 'displayName', 'kind', 'source', 'target', 'targetVersion', 'enabled']), 'installationId', expectedRevision);
          if (!current) {
            const globalConfig = {};
            validate(pkg.configSchema, globalConfig, true, true);
            db.prepare('INSERT INTO installation_configs VALUES (?, ?, 0)').run(result.installationId, json(globalConfig));
          } else {
            const config = configFor(result.installationId);
            validate(config.configSchema, config.globalConfig, true);
            checkEnabledBindings(result.installationId, config, result);
          }
          bump(); return result;
        });
      },
      getOperation(id) {
        return parse(db.prepare('SELECT json FROM operations WHERE id = ?').get(id));
      },
      findOperationByRequestId(requestId) {
        return parse(db.prepare('SELECT json FROM operations WHERE request_id = ?').get(requestId));
      },
      putOperation(operation, requestFingerprint) {
        assertObject(operation); assertId(operation.operationId); assertId(operation.requestId); assertId(requestFingerprint);
        return transaction(() => {
          const row = db.prepare('SELECT id, request_id, fingerprint, json FROM operations WHERE request_id = ? OR id = ?').all(operation.requestId, operation.operationId);
          if (row.length) {
            if (row.length !== 1 || row[0].request_id !== operation.requestId || row[0].fingerprint !== requestFingerprint) throw error('REQUEST_CONFLICT', 'Operation request conflicts');
            return parse(row[0]);
          }
          const value = safeReceipt(pick(operation, ['operationId', 'requestId', 'action', 'installationId', 'deviceIds', 'target', 'phase', 'error']));
          db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?)').run(value.operationId, value.requestId, requestFingerprint, json(value));
          bump(); return value;
        });
      },
      updateOperation(id, update) {
        assertObject(update);
        return transaction(() => {
          const current = store.getOperation(id);
          if (!current) throw error('NOT_FOUND', 'Operation not found');
          const result = { ...current, phase: update.phase, error: safeError(update.error) };
          db.prepare('UPDATE operations SET json = ? WHERE id = ?').run(json(result), id);
          bump(); return result;
        });
      },
      listDeploymentReceipts(installationId) {
        return db.prepare('SELECT json FROM deployment_receipts WHERE installation_id = ? ORDER BY device_id, operation_id').all(installationId).map(parse);
      },
      putDeploymentReceipt(receipt) {
        assertObject(receipt);
        return transaction(() => {
          const value = safeReceipt(pick(receipt, ['deviceId', 'installationId', 'operationId', 'desiredRevision', 'appliedRevision', 'actualVersion', 'phase', 'health', 'error']));
          db.prepare('INSERT INTO deployment_receipts VALUES (?, ?, ?, ?) ON CONFLICT(device_id, installation_id, operation_id) DO UPDATE SET json = excluded.json').run(value.deviceId ?? '', value.installationId, value.operationId, json(value));
          bump();
        });
      },
      putDeploymentPlan(plan) {
        assertObject(plan);
        return transaction(() => {
          db.prepare('INSERT INTO deployment_plans VALUES (?, ?, ?) ON CONFLICT(device_id, installation_id) DO UPDATE SET json = excluded.json').run(plan.deviceId ?? '', plan.installationId, json(plan));
          bump();
        });
      },
      listDeploymentPlans(deviceId) {
        return db.prepare('SELECT json FROM deployment_plans WHERE device_id = ? ORDER BY installation_id').all(deviceId ?? '').map(parse);
      },
      putRuntimeReceipt(receipt) {
        assertObject(receipt); assertId(receipt.deviceId);
        return transaction(() => {
          const value = { deviceId: receipt.deviceId, revision: receipt.revision, status: receipt.status, error: safeError(receipt.error) };
          db.prepare('INSERT INTO runtime_receipts VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET json = excluded.json').run(receipt.deviceId, json(value));
        });
      },
      getRuntimeReceipt(deviceId) {
        return parse(db.prepare('SELECT json FROM runtime_receipts WHERE device_id = ?').get(deviceId));
      },
      getDeviceSnapshot(deviceId, linkUrl) {
        assertId(deviceId);
        return transaction(() => {
          const providers = store.listProviders();
          const models = Object.fromEntries(providers.map((provider) => [provider.id, store.listModels(provider.id)]));
          const installations = store.listInstallations();
          const refs = new Set();
          const bots = store.listDeviceBots(deviceId).map((bot) => {
            const model = store.getBotModelConfig(deviceId, bot.botId).effective;
            if (typeof model.modelRef === 'string') {
              const slash = model.modelRef.indexOf('/');
              const provider = providers.find((item) => item.id === model.modelRef.slice(0, slash) && item.enabled);
              const selected = provider && models[provider.id].find((item) => item.id === model.modelRef.slice(slash + 1) && item.enabled);
              if (slash > 0 && selected && provider.credentialRef) refs.add(provider.credentialRef);
            }
            const capabilities = installations.map((installation) => {
              const config = capabilityFor(deviceId, bot.botId, installation.installationId);
              const enabled = installation.enabled && config.enabled;
              if (enabled) {
                validate(config.configSchema, config.effectiveConfig);
                if (installation.target === 'host') collectCredentialRefs(config.configSchema, config.effectiveConfig, refs);
              }
              return {
                installationId: installation.installationId, kind: installation.kind, target: installation.target,
                targetVersion: installation.targetVersion, enabled, revision: config.revision, effectiveConfig: config.effectiveConfig,
              };
            });
            return { botId: bot.botId, model, capabilities };
          });
          const credentials = Object.fromEntries([...refs].map((id) => [id, resolveCredential(id)]));
          const revision = db.prepare('SELECT revision FROM metadata WHERE id = 1').get().revision;
          return { protocol: 1, deviceId, revision, linkUrl, providers, models, bots, credentials };
        }, 'DEFERRED');
      },
      close() { db.close(); },
    };
    return store;
  } catch (err) {
    try { db.close(); } catch { /* Preserve original error. */ }
    throw err;
  }
}
