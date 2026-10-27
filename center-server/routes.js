import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { requireOwner, assertPublicCredentialId } from './auth.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const required = (value, name) => value ?? fail('NOT_FOUND', `${name} not found`);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : fail('INVALID_ARGUMENT', 'Expected an object');
const text = (value, name) => typeof value === 'string' && value.length > 0 ? value : fail('INVALID_ARGUMENT', `Invalid ${name}`);
const ajv = new Ajv({ strict: false });
ajv.addFormat('credential-ref', { type: 'string', validate: value => value.length > 0 });

const string = { type: 'string', minLength: 1 };
const revision = { type: 'integer', minimum: 0 };
const providerSchema = {
  type: 'object', required: ['name', 'api', 'baseUrl', 'credentialRef', 'enabled'],
  properties: { id: string, name: string, api: string, baseUrl: string, credentialRef: { anyOf: [string, { type: 'null' }] }, enabled: { type: 'boolean' }, revision },
  additionalProperties: false,
};
const modelSchema = {
  type: 'object', required: ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'enabled'],
  properties: { id: string, name: string, contextWindow: { type: 'integer', minimum: 1 }, maxTokens: { type: 'integer', minimum: 1 }, input: { type: 'array', items: string }, reasoning: { type: 'boolean' }, enabled: { type: 'boolean' }, revision, thinkingLevelMap: { type: 'object' }, cost: { type: 'object' }, compat: { type: 'object' }, inputLimits: { type: 'object' } },
  additionalProperties: false,
};
const selectionSchema = { type: 'object', properties: { modelRef: { anyOf: [string, { type: 'null' }] }, thinkingLevel: { anyOf: [string, { type: 'null' }] } }, additionalProperties: false };
function validate(schema, value) { if (!ajv.validate(schema, value)) fail('VALIDATION_FAILED', 'Invalid input'); return value; }

function assertConfigCredentials(schema, value) {
  if (!schema || typeof schema !== 'object' || value == null) return;
  if (schema.type === 'string' && schema.format === 'credential-ref') { assertPublicCredentialId(value); return; }
  if (Array.isArray(value)) {
    for (const item of value) assertConfigCredentials(schema.items, item);
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertConfigCredentials(schema.properties?.[key] ?? schema.additionalProperties, item);
  }
}


export function registerRoutes(app, { store, packages, bridge, execution, oauth, linkUrl }) {
  const streams = new Map();
  function notify(deviceId) {
    for (const stream of streams.get(deviceId) || []) {
      if (!bridge.registry.authenticate(deviceId, stream.token)) stream.reply.end();
      else stream.reply.write('event: config-changed\ndata: {}\n\n');
    }
  }
  function notifyAll() { for (const deviceId of streams.keys()) notify(deviceId); }
  function notifyInstallation(id) { for (const deviceId of new Set(store.listBotBindings({ installationId: id }).map(b => b.deviceId))) notify(deviceId); }
  const owner = [requireOwner];
  const mutation = [requireOwner, app.csrfProtection];
  const route = (method, path, handler, write = false) => app.route({ method, url: path, onRequest: write ? mutation : owner, handler });
  const changed = (result, deviceId) => { deviceId ? notify(deviceId) : notifyAll(); return result; };
  const providerInput = id => {
    const provider = required(store.getProvider(id), 'Provider');
    const models = store.listModels(id);
    const credential = provider.credentialRef ? store.resolveCredential(assertPublicCredentialId(provider.credentialRef)) : undefined;
    return { provider, models, ...(credential === undefined ? {} : { credential }) };
  };
  route('GET', '/api/providers', () => store.listProviders());
  route('POST', '/api/providers', (req, reply) => reply.code(201).send(changed(store.putProvider({ ...validate(providerSchema, req.body), credentialRef: assertPublicCredentialId(req.body.credentialRef), id: req.body.id || randomUUID(), revision: 0 }, null))), true);
  route('GET', '/api/providers/:id', req => required(store.getProvider(req.params.id), 'Provider'));
  route('PUT', '/api/providers/:id', req => { const body = object(req.body); validate(providerSchema, body.value); assertPublicCredentialId(body.value.credentialRef); return changed(store.putProvider({ ...body.value, id: req.params.id }, body.expectedRevision)); }, true);
  for (const [path, method] of [['validate', 'validateCenterProvider'], ['discover', 'discoverCenterProviderModels']]) {
    route('POST', `/api/providers/:id/${path}`, req => bridge.call(text(req.body?.deviceId, 'deviceId'), method, providerInput(req.params.id)), true);
  }
  route('GET', '/api/providers/:id/models', req => { required(store.getProvider(req.params.id), 'Provider'); return store.listModels(req.params.id); });
  route('POST', '/api/providers/:id/models', (req, reply) => { required(store.getProvider(req.params.id), 'Provider'); return reply.code(201).send(changed(store.putModel(req.params.id, { ...validate(modelSchema, req.body), revision: 0 }, null))); }, true);
  route('PUT', '/api/providers/:id/models/:modelId', req => { const body = object(req.body); return changed(store.putModel(req.params.id, { ...validate(modelSchema, body.value), id: req.params.modelId }, body.expectedRevision)); }, true);
  route('GET', '/api/model-config', () => store.getModelConfig());
  route('PUT', '/api/model-config', req => { const body = object(req.body); return changed(store.putModelConfig(body.expectedRevision, validate(selectionSchema, body.value))); }, true);
  route('GET', '/api/devices', () => bridge.listDevices());
  route('GET', '/api/devices/:deviceId/bots', req => store.listDeviceBots(req.params.deviceId));
  route('GET', '/api/devices/:deviceId/bots/:botId/model-config', req => store.getBotModelConfig(req.params.deviceId, req.params.botId));
  route('PUT', '/api/devices/:deviceId/bots/:botId/model-config', req => { const b = object(req.body); return changed(store.putBotModelConfig(req.params.deviceId, req.params.botId, b.expectedRevision, validate(selectionSchema, b.value)), req.params.deviceId); }, true);
  const credentialId = assertPublicCredentialId;
  route('GET', '/api/credentials/:id', req => required(store.getCredential(credentialId(req.params.id)), 'Credential'));
  route('PUT', '/api/credentials/:id', req => changed(store.putCredential(credentialId(req.params.id), object(req.body))), true);
  route('DELETE', '/api/credentials/:id', (req, reply) => { store.deleteCredential(credentialId(req.params.id), object(req.body).expectedRevision); notifyAll(); return reply.code(204).send(); }, true);
  route('POST', '/api/artifacts', async (req, reply) => {
    const file = await req.file();
    if (!file) fail('INVALID_ARGUMENT', 'File required');
    if (file.fieldname !== 'file') { file.file.resume(); fail('INVALID_ARGUMENT', 'File required'); }
    async function* content() {
      for await (const chunk of file.file) yield chunk;
      if (file.file.truncated) fail('PAYLOAD_TOO_LARGE', 'Artifact too large');
    }
    return reply.code(201).send(await packages.uploadArtifact(content()));
  }, true);
  route('GET', '/api/capabilities', () => store.listInstallations());
  route('POST', '/api/installations', async (req, reply) => { const body = object(req.body); if (body.target === 'center' && (body.kind === 'plugin' || body.kind === 'skill')) fail('UNSUPPORTED_TARGET', 'Native plugins and skills run on Hosts'); return reply.code(202).send(await packages.install(body)); }, true);
  route('GET', '/api/installations/:id', req => required(store.getInstallation(req.params.id), 'Installation'));
  route('GET', '/api/installations/:id/config', req => store.getInstallationConfig(req.params.id));
  route('PUT', '/api/installations/:id/config', req => { const body = object(req.body); assertConfigCredentials(store.getInstallationConfig(req.params.id).configSchema, body.globalConfig); const result = store.putInstallationConfig(req.params.id, body); notifyInstallation(req.params.id); return result; }, true);
  route('GET', '/api/devices/:deviceId/bots/:botId/capabilities/:id', req => store.getBotCapability(req.params.deviceId, req.params.botId, req.params.id));
  route('PUT', '/api/devices/:deviceId/bots/:botId/capabilities/:id', async req => { const { deviceId, botId, id } = req.params; const body = object(req.body); assertConfigCredentials(store.getInstallationConfig(id).configSchema, body.overrides); const result = store.putBotCapability(deviceId, botId, id, body); try { await packages.reconcileDevice(deviceId); } finally { notify(deviceId); } return result; }, true);
  function actions(id) {
    const installation = required(store.getInstallation(id), 'Installation');
    const version = required(store.getPackageVersion(installation.packageId, installation.targetVersion), 'Package version');
    return version.manifest.actions || [];
  }
  route('GET', '/api/installations/:id/actions', req => actions(req.params.id));
  async function action(id, name, input) {
    const declared = actions(id).find(item => item.id === name);
    if (!declared) fail('NOT_FOUND', 'Action not declared');
    object(input); text(input.deviceId, 'deviceId'); text(input.botId, 'botId'); text(input.requestId, 'requestId');
    if (!ajv.validate(declared.inputSchema, input.input)) fail('VALIDATION_FAILED', 'Invalid action input');
    const result = await bridge.call(input.deviceId, 'callCapabilityAction', { installationId: id, action: name, request: input });
    if (declared.outputSchema !== undefined && !ajv.validate(declared.outputSchema, result.result)) fail('INVALID_STATE', 'Invalid action output');
    return result;
  }
  route('POST', '/api/installations/:id/actions/:action', req => action(req.params.id, req.params.action, req.body), true);
  route('POST', '/api/installations/:id/validate', async req => {
    const body = object(req.body); text(body.deviceId, 'deviceId'); text(body.botId, 'botId');
    if (!actions(req.params.id).some(item => item.id === 'validate')) return { ok: false, message: 'Connection validation is not supported' };
    const result = await action(req.params.id, 'validate', { requestId: randomUUID(), deviceId: body.deviceId, botId: body.botId, input: {} });
    return result.result;
  }, true);
  route('POST', '/api/installations/:id/updates/check', req => packages.checkUpdates(req.params.id), true);
  for (const [method, path, fn] of [['POST','update','update'],['POST','rollback','rollback'],['POST','disable','disable'],['POST','enable','enable'],['DELETE','','uninstall']]) {
    route(method, `/api/installations/:id${path ? `/${path}` : ''}`, async (req, reply) => reply.code(202).send(await packages[fn](req.params.id, object(req.body))), true);
  }
  route('GET', '/api/installations/:id/deployments', req => store.listDeploymentReceipts(req.params.id));
  route('GET', '/api/operations/:id', req => required(store.getOperation(req.params.id), 'Operation'));
  const oauthInput = req => ({ installationId: req.params.id, deviceId: text(req.body?.deviceId, 'deviceId'), botId: text(req.body?.botId, 'botId') });
  route('POST', '/api/installations/:id/oauth/start', req => oauth.start(oauthInput(req)), true);
  route('GET', '/api/oauth/mcp/flows/:flowId', req => required(oauth.status(req.params.flowId), 'OAuth flow'));
  route('POST', '/api/installations/:id/oauth/logout', async (req, reply) => {
    const input = oauthInput(req);
    await oauth.logout(input);
    await execution.invalidate(input.deviceId, input.botId, input.installationId);
    notify(input.deviceId);
    return reply.code(204).send();
  }, true);
  app.get('/api/oauth/mcp/callback', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const state = text(req.query?.state, 'state');
    await oauth.complete({ state, code: req.query?.code, error: req.query?.error });
    return reply.type('text/plain; charset=utf-8').send(req.query?.error ? 'Authorization was not completed. You may close this window.' : 'Authorization complete. You may close this window.');
  });
  function snapshot(deviceId) {
    const value = store.getDeviceSnapshot(deviceId, linkUrl);
    for (const id of Object.keys(value.credentials)) assertPublicCredentialId(id);
    return value;
  }


  function authenticate(req, reply, done) {
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '')?.[1];
    const deviceId = req.headers['x-device-id'];
    const identity = token && typeof deviceId === 'string' && bridge.registry.authenticate(deviceId, token);
    if (!identity || deviceId === bridge.deviceId) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Device authentication required' } });
    req.centerDevice = { deviceId, token };
    done();
  }
  const host = (method, url, handler) => app.route({ method, url, onRequest: authenticate, handler });
  host('GET', '/api/host/events', (req, reply) => {
    const { deviceId, token } = req.centerDevice;
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write('event: heartbeat\ndata: {}\n\n');
    const set = streams.get(deviceId) || new Set(); const stream = { reply: reply.raw, token }; set.add(stream); streams.set(deviceId, set);
    const timer = setInterval(() => { if (!bridge.registry.authenticate(deviceId, token)) return reply.raw.end(); reply.raw.write('event: heartbeat\ndata: {}\n\n'); }, 15000);
    reply.raw.on('error', () => reply.raw.destroy());
    reply.raw.on('close', () => { clearInterval(timer); set.delete(stream); if (!set.size) streams.delete(deviceId); });
  });
  host('POST', '/api/host/bootstrap', async req => {
    const body = object(req.body); const id = req.centerDevice.deviceId;
    if (body.deviceId !== id || body.capabilityProtocol !== 1 || !Array.isArray(body.bots) || body.bots.some(bot => !bot || bot.deviceId !== id || typeof bot.botId !== 'string' || !bot.botId || typeof bot.name !== 'string')) fail('INVALID_ARGUMENT', 'Invalid bootstrap');
    store.replaceDeviceBots(id, body.bots);
    await packages.reconcileDevice(id);
    return { snapshot: snapshot(id) };
  });
  host('GET', '/api/host/snapshot', req => snapshot(req.centerDevice.deviceId));
  host('POST', '/api/host/receipt', (req, reply) => {
    const body = object(req.body);
    if (body.deviceId !== req.centerDevice.deviceId) fail('FORBIDDEN', 'Device mismatch');
    if (!Number.isSafeInteger(body.revision) || body.revision < 0 || !['applied', 'failed'].includes(body.status)) fail('INVALID_ARGUMENT', 'Invalid runtime receipt');
    store.putRuntimeReceipt({ ...body, error: body.error ? { code: 'INTERNAL_ERROR', message: 'Runtime application failed' } : null });
    return reply.code(204).send();
  });
  host('GET', '/api/host/deployments', req => packages.listDeploymentPlans(req.centerDevice.deviceId));
  host('POST', '/api/host/deployments/receipt', async (req, reply) => {
    const body = object(req.body), deviceId = req.centerDevice.deviceId;
    const plan = store.listDeploymentPlans(deviceId).find(p => p.installationId === body.installationId);
    if (body.deviceId !== deviceId || !plan || plan.operationId !== body.operationId || plan.planId !== body.planId || plan.desiredRevision !== body.desiredRevision) fail('FORBIDDEN', 'Deployment not assigned');
    if (!['queued', 'downloading', 'preparing', 'waiting-idle', 'activating', 'applied', 'failed', 'removed'].includes(body.phase) || !['ready', 'disconnected', 'needs-auth', 'unsupported', 'disabled'].includes(body.health) || (body.appliedRevision !== null && (!Number.isSafeInteger(body.appliedRevision) || body.appliedRevision < 0)) || (body.actualVersion !== null && typeof body.actualVersion !== 'string')) fail('INVALID_ARGUMENT', 'Invalid deployment receipt');
    if (['applied', 'removed'].includes(body.phase) && body.appliedRevision !== plan.desiredRevision) fail('INVALID_ARGUMENT', 'Deployment revision mismatch');
    if (body.phase === 'applied' && ['install', 'update', 'rollback', 'enable'].includes(plan.action) && body.actualVersion !== plan.targetVersion) fail('INVALID_ARGUMENT', 'Deployment version mismatch');
    store.putDeploymentReceipt({ ...body, error: body.error ? { code: 'INTERNAL_ERROR', message: 'Deployment failed' } : null });
    const operation = store.getOperation(plan.operationId);
    if (operation && operation.target === 'host' && operation.deviceIds.length && !['applied', 'removed', 'failed'].includes(operation.phase)) {
      const receipts = store.listDeploymentReceipts(plan.installationId);
      const matched = operation.deviceIds.map(id => {
        const current = store.listDeploymentPlans(id).find(p => p.installationId === plan.installationId && p.operationId === operation.operationId);
        return current && receipts.find(r => r.deviceId === id && r.operationId === operation.operationId && r.planId === current.planId && r.desiredRevision === current.desiredRevision);
      });
      if (matched.some(receipt => receipt?.phase === 'failed')) store.updateOperation(operation.operationId, { phase: 'failed', error: { code: 'INTERNAL_ERROR', message: 'Deployment failed' } });
      else if (matched.every(receipt => receipt && ['applied', 'removed'].includes(receipt.phase))) store.updateOperation(operation.operationId, { phase: operation.action === 'uninstall' ? 'removed' : 'applied', error: null });
    }
    notify(deviceId);
    return reply.code(204).send();
  });
  host('GET', '/api/host/artifacts/:artifactRef', async (req, reply) => { const plans = store.listDeploymentPlans(req.centerDevice.deviceId); if (!plans.some(plan => plan.artifactRef === req.params.artifactRef)) fail('FORBIDDEN', 'Artifact not assigned'); return reply.type('application/octet-stream').send(Buffer.from(await packages.readArtifact(req.params.artifactRef))); });
  host('POST', '/api/host/capabilities/:installationId/tools/list', req => execution.listTools(req.centerDevice.deviceId, req.params.installationId, object(req.body)));
  host('POST', '/api/host/capabilities/:installationId/tools/call', req => { const body = object(req.body); text(body.callId, 'callId'); text(body.name, 'name'); object(body.args); return execution.callTool(req.centerDevice.deviceId, req.params.installationId, body); });
  return { notifyInstallation, close() { for (const set of streams.values()) for (const stream of set) stream.reply.end(); streams.clear(); } };
}
