/** Shared wire data only: no Node, Android, React or server imports. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
export type JsonSchema = boolean | JsonObject;
export type CapabilityKind = 'plugin' | 'mcp' | 'skill';
export type DeploymentPhase = 'queued' | 'downloading' | 'preparing' | 'waiting-idle' | 'activating' | 'applied' | 'failed' | 'removed';
export type HealthState = 'ready' | 'disconnected' | 'needs-auth' | 'unsupported' | 'disabled';
export const CAPABILITY_PROTOCOL: 1;
export const CAPABILITY_KINDS: readonly CapabilityKind[];
export const DEPLOYMENT_PHASES: readonly DeploymentPhase[];
export const HEALTH_STATES: readonly HealthState[];

/** Error messages and details must never contain credentials. */
export interface ApiError { error: { code: string; message: string; details?: JsonValue } }
export interface Accepted { operationId: string }
export interface RevisionWrite<T> { expectedRevision: number; value: T }
export interface CredentialInfo { credentialId: string; configured: boolean; revision: number }
export interface Provider {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  credentialRef: string | null;
  enabled: boolean;
  revision: number;
}
/** Fields retain runtime-models names; model-specific optional values remain JSON. */
export interface Model {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: string[];
  reasoning: boolean;
  thinkingLevelMap?: JsonObject;
  cost?: JsonObject;
  compat?: JsonObject;
  inputLimits?: JsonObject;
  enabled: boolean;
  revision: number;
}
export interface ModelSelection { modelRef?: string | null; thinkingLevel?: string | null }
export interface ModelConfig { global: ModelSelection; revision: number }
export interface BotModelConfig { global: ModelSelection; overrides: ModelSelection; effective: ModelSelection; revision: number }
export interface NativeManifest {
  manifestVersion: 1;
  id: string;
  version: string;
  kind: 'plugin';
  displayName: string;
  hostApi: string;
  durableApi: string;
  components: { host?: { entry: string }; center?: { entry: string } };
  platforms: ('windows' | 'linux' | 'android')[];
  configSchema: string;
  uiSchema?: string;
  stateVersion?: number;
  contributions?: ('tools' | 'context' | 'background' | 'actions')[];
}
export interface PackageVersion {
  packageId: string;
  version: string;
  kind: CapabilityKind;
  digest: string;
  artifactRef: string | null;
  manifest: JsonObject;
  resolved: string | null;
  integrity: string | null;
}
export interface Installation {
  installationId: string;
  packageId: string;
  kind: CapabilityKind;
  targetVersion: string;
  enabled: boolean;
  revision: number;
}
export interface InstallationConfig {
  globalConfig: JsonObject;
  configSchema: JsonSchema;
  uiSchema?: JsonObject;
  revision: number;
}
export interface PutInstallationConfig { expectedRevision: number; globalConfig: JsonObject }
export interface BotBinding {
  deviceId: string;
  botId: string;
  installationId: string;
  enabled: boolean;
  overrides: JsonObject;
  revision: number;
}
export interface BotCapabilityConfig extends BotBinding {
  globalConfig: JsonObject;
  effectiveConfig: JsonObject;
  configSchema: JsonSchema;
}
export interface PutBotCapability { expectedRevision: number; enabled: boolean; overrides: JsonObject }
export interface Device { deviceId: string; name: string; online: boolean }
export interface BotRef { deviceId: string; botId: string; name: string }
export interface DeploymentReceipt {
  deviceId: string;
  installationId: string;
  operationId: string;
  desiredRevision: number;
  appliedRevision: number | null;
  actualVersion: string | null;
  phase: DeploymentPhase;
  health: HealthState;
  error: ApiError['error'] | null;
}
export interface Operation {
  operationId: string;
  requestId: string;
  action: 'install' | 'update' | 'disable' | 'uninstall' | 'rollback';
  installationId: string;
  phase: DeploymentPhase;
  error: ApiError['error'] | null;
}
export type InstallSource =
  | { type: 'npm'; spec: string }
  | { type: 'artifact'; artifactRef: string }
  | { type: 'http'; url: string };
export interface InstallRequest { requestId: string; kind: CapabilityKind; source: InstallSource; target: 'center' | 'host' }
export interface OperationRequest { requestId: string }
export interface UpdateRequest extends OperationRequest { targetVersion: string }
export interface DeploymentPlan {
  protocol: 1;
  operationId: string;
  installationId: string;
  kind: CapabilityKind;
  targetVersion: string;
  artifactRef: string | null;
  digest: string | null;
  resolved: string | null;
  integrity: string | null;
  /** npm lockfile contents when target-platform dependency installation is required. */
  lockfile: JsonObject | null;
  action: 'install' | 'update' | 'disable' | 'uninstall' | 'rollback';
}
export interface EffectiveCapability {
  installationId: string;
  kind: CapabilityKind;
  targetVersion: string;
  enabled: boolean;
  revision: number;
  effectiveConfig: JsonObject;
}
export interface RuntimeBot {
  botId: string;
  model: ModelSelection;
  capabilities: EffectiveCapability[];
}
/** Secrets are available only to the authenticated assigned device, in memory. */
export interface DeviceRuntimeSnapshot {
  protocol: 1;
  deviceId: string;
  revision: number;
  linkUrl: string;
  providers: Provider[];
  models: Record<string, Model[]>;
  bots: RuntimeBot[];
  credentials: Record<string, string>;
}
export interface RuntimeReceipt {
  deviceId: string;
  revision: number;
  status: 'applied' | 'failed';
  error: ApiError['error'] | null;
}
export interface BootstrapRequest { deviceId: string; capabilityProtocol: 1 }
export interface BootstrapResponse { snapshot: DeviceRuntimeSnapshot }
export interface SessionInfo { authenticated: boolean; csrfToken: string | null }
export interface LoginRequest { password: string }
export interface CredentialWrite { value: string; expectedRevision: number | null }
export interface ProviderCheckRequest { deviceId: string }
export interface ProviderCheckResult { ok: boolean; message: string }
export interface DiscoveryResult { models: Model[] }
export interface ActionRequest { requestId: string; deviceId: string; botId: string; input: JsonValue }
export interface ActionResult { result: JsonValue }
