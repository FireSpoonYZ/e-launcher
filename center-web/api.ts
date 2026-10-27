import type {
  Accepted, ActionRequest, ActionResult, ApiError, ArtifactUploadReceipt, BotCapabilityConfig,
  BotModelConfig, BotRef, CredentialInfo, CredentialWrite, DeploymentReceipt, Device, DiscoveryResult,
  InstallRequest, Installation, InstallationConfig, LoginRequest, Model, ModelConfig, ModelSelection,
  Operation, OperationRequest, PackageVersion, Provider, ProviderCheckRequest, ProviderCheckResult,
  PutBotCapability, PutInstallationConfig, RevisionWrite, SessionInfo, UpdateRequest,
} from '@e-launcher/center-contract';

let csrfToken: string | null = null;
export class CenterApiError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: ApiError['error']['details']) {
    super(message);
  }
}
const id = encodeURIComponent;
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers = new Headers();
  if (method !== 'GET') {
    if (!csrfToken) throw new CenterApiError('CSRF_INVALID', '会话令牌不可用，请重新连接中心', 403);
    headers.set('x-csrf-token', csrfToken);
  }
  if (body !== undefined && !(body instanceof FormData)) headers.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await fetch(path, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), cache: 'no-store' });
  } catch {
    window.dispatchEvent(new Event('center-offline'));
    throw new CenterApiError('CENTER_OFFLINE', '无法连接中心', 503);
  }
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/session') window.dispatchEvent(new Event('center-unauthenticated'));
    const payload = await response.json().catch(() => null) as ApiError | null;
    if (payload?.error?.code === 'CENTER_OFFLINE') window.dispatchEvent(new Event('center-offline'));
    throw new CenterApiError(payload?.error?.code || 'HTTP_ERROR', payload?.error?.message || `请求失败 (${response.status})`, response.status, payload?.error?.details);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
const botPath = (deviceId: string, botId: string) => `/api/devices/${id(deviceId)}/bots/${id(botId)}`;
const installationPath = (installationId: string) => `/api/installations/${id(installationId)}`;
export const api = {
  async session() { const result = await request<SessionInfo>('/api/session'); csrfToken = result.csrfToken; return result; },
  async login(body: LoginRequest) { const result = await request<SessionInfo>('/api/session', 'POST', body); csrfToken = result.csrfToken; return result; },
  async logout() { await request<void>('/api/session', 'DELETE'); csrfToken = null; },
  listProviders: () => request<Provider[]>('/api/providers'),
  createProvider: (body: Provider) => request<Provider>('/api/providers', 'POST', body),
  getProvider: (providerId: string) => request<Provider>(`/api/providers/${id(providerId)}`),
  putProvider: (providerId: string, body: RevisionWrite<Provider>) => request<Provider>(`/api/providers/${id(providerId)}`, 'PUT', body),
  validateProvider: (providerId: string, body: ProviderCheckRequest) => request<ProviderCheckResult>(`/api/providers/${id(providerId)}/validate`, 'POST', body),
  discoverModels: (providerId: string, body: ProviderCheckRequest) => request<DiscoveryResult>(`/api/providers/${id(providerId)}/discover`, 'POST', body),
  listModels: (providerId: string) => request<Model[]>(`/api/providers/${id(providerId)}/models`),
  createModel: (providerId: string, body: Model) => request<Model>(`/api/providers/${id(providerId)}/models`, 'POST', body),
  putModel: (providerId: string, modelId: string, body: RevisionWrite<Model>) => request<Model>(`/api/providers/${id(providerId)}/models/${id(modelId)}`, 'PUT', body),
  getModelConfig: () => request<ModelConfig>('/api/model-config'),
  putModelConfig: (body: RevisionWrite<ModelSelection>) => request<ModelConfig>('/api/model-config', 'PUT', body),
  listDevices: () => request<Device[]>('/api/devices'),
  listBots: (deviceId: string) => request<BotRef[]>(`/api/devices/${id(deviceId)}/bots`),
  getBotModelConfig: (deviceId: string, botId: string) => request<BotModelConfig>(`${botPath(deviceId, botId)}/model-config`),
  putBotModelConfig: (deviceId: string, botId: string, body: RevisionWrite<ModelSelection>) => request<BotModelConfig>(`${botPath(deviceId, botId)}/model-config`, 'PUT', body),
  getCredential: (credentialId: string) => request<CredentialInfo>(`/api/credentials/${id(credentialId)}`),
  putCredential: (credentialId: string, body: CredentialWrite) => request<CredentialInfo>(`/api/credentials/${id(credentialId)}`, 'PUT', body),
  deleteCredential: (credentialId: string, body: RevisionWrite<null>) => request<void>(`/api/credentials/${id(credentialId)}`, 'DELETE', body),
  uploadArtifact: (file: File) => { const body = new FormData(); body.append('file', file); return request<ArtifactUploadReceipt>('/api/artifacts', 'POST', body); },
  listCapabilities: () => request<Installation[]>('/api/capabilities'),
  install: (body: InstallRequest) => request<Accepted>('/api/installations', 'POST', body),
  getInstallation: (installationId: string) => request<Installation>(installationPath(installationId)),
  getInstallationConfig: (installationId: string) => request<InstallationConfig>(`${installationPath(installationId)}/config`),
  putInstallationConfig: (installationId: string, body: PutInstallationConfig) => request<InstallationConfig>(`${installationPath(installationId)}/config`, 'PUT', body),
  getBotCapability: (deviceId: string, botId: string, installationId: string) => request<BotCapabilityConfig>(`${botPath(deviceId, botId)}/capabilities/${id(installationId)}`),
  putBotCapability: (deviceId: string, botId: string, installationId: string, body: PutBotCapability) => request<BotCapabilityConfig>(`${botPath(deviceId, botId)}/capabilities/${id(installationId)}`, 'PUT', body),
  validateInstallation: (installationId: string, body: ProviderCheckRequest) => request<ProviderCheckResult>(`${installationPath(installationId)}/validate`, 'POST', body),
  checkUpdates: (installationId: string) => request<PackageVersion[]>(`${installationPath(installationId)}/updates/check`, 'POST'),
  updateInstallation: (installationId: string, body: UpdateRequest) => request<Accepted>(`${installationPath(installationId)}/update`, 'POST', body),
  rollbackInstallation: (installationId: string, body: OperationRequest) => request<Accepted>(`${installationPath(installationId)}/rollback`, 'POST', body),
  disableInstallation: (installationId: string, body: OperationRequest) => request<Accepted>(`${installationPath(installationId)}/disable`, 'POST', body),
  uninstallInstallation: (installationId: string, body: OperationRequest) => request<Accepted>(installationPath(installationId), 'DELETE', body),
  runAction: (installationId: string, action: string, body: ActionRequest) => request<ActionResult>(`${installationPath(installationId)}/actions/${id(action)}`, 'POST', body),
  listDeployments: (installationId: string) => request<DeploymentReceipt[]>(`${installationPath(installationId)}/deployments`),
  getOperation: (operationId: string) => request<Operation>(`/api/operations/${id(operationId)}`),
};
