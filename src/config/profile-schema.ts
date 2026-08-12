import { isAbsolute } from 'node:path';
import type {
  AppCredentials,
  AppPreferences,
  MessageReplyMode,
  SecretsConfig,
} from './schema';
import {
  normalizePermissions,
  permissionsToLegacySandbox,
  type AccessMode,
  type CodexSandboxMode,
  type PermissionConfig,
  type PermissionSource,
} from './permissions';

export type AgentKind = 'claude' | 'codex' | 'kimi';
export type SandboxMode = CodexSandboxMode;
export type { AccessMode, PermissionConfig, PermissionSource };

export interface ProfileAccess {
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  requireMentionInGroup: boolean;
}

export interface SandboxConfig {
  default?: SandboxMode;
  max?: SandboxMode;
  defaultMode: SandboxMode;
  maxMode: SandboxMode;
}

/** Difficulty-aware routing: classify each message, then pick the main run's reasoning effort. */
export interface CodexModelRouterConfig {
  enabled?: boolean;
  /** Optional absolute executable for a shared local classifier. Receives the message on stdin. */
  classifierCommand?: string;
  /** Arguments passed to classifierCommand. */
  classifierArgs?: string[];
  /** Model used for the classifier call (cheap tier). Defaults to the run's model. */
  classifierModel?: string;
  /** Reasoning effort for the classifier call itself. Defaults to low. */
  classifierEffort?: string;
  /** Hard timeout for one classification attempt, ms. */
  timeoutMs?: number;
  /** Requested fallback effort. Runtime enforces an ultra safety floor on classifier failure. */
  fallbackEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'ultra';
}

export interface CodexConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  router?: CodexModelRouterConfig;
}

export interface KimiConfig {
  binaryPath: string;
  defaultModel?: string;
}

export interface AttachmentConfig {
  maxCount: number;
  maxBytes: number;
  maxFileBytes: number;
  imageMaxBytes: number;
  cacheTtlMs: number;
  cacheMaxBytes: number;
}

export type CommentConfig = Record<string, never>;

export type LarkCliIdentityPreset = 'bot-only' | 'user-default';

export type LarkCliUserImportStatus =
  | 'not-needed'
  | 'imported'
  | 'skipped-existing-private-user'
  | 'skipped-no-local-user'
  | 'failed';

export interface LarkCliConfig {
  identityPreset: LarkCliIdentityPreset;
  localUserImport?: {
    status: LarkCliUserImportStatus;
    attemptedAt?: string;
    importedAt?: string;
    reason?: string;
  };
}

export interface ProfileConfig {
  schemaVersion: 2;
  agentKind: AgentKind;
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  preferences: Omit<AppPreferences, 'access' | 'requireMentionInGroup'>;
  access: ProfileAccess;
  workspaces: {
    default?: string;
    allowedRoots?: string[];
  };
  sandbox: SandboxConfig;
  permissions: PermissionConfig;
  permissionSource?: PermissionSource;
  codex?: CodexConfig;
  kimi?: KimiConfig;
  attachments: AttachmentConfig;
  comments: CommentConfig;
  larkCli: LarkCliConfig;
}

export interface RootConfig {
  schemaVersion: 2;
  activeProfile: string;
  preferences: Record<string, never>;
  secrets?: SecretsConfig;
  migrations?: {
    permissionDefaultsV1?: string[];
  };
  profiles: Record<string, ProfileConfig>;
}

export interface CreateDefaultProfileConfigInput {
  agentKind: AgentKind;
  accounts: {
    app: AppCredentials;
  };
  preferences?: AppPreferences;
  access?: Partial<ProfileAccess>;
  sandbox?: Partial<SandboxConfig>;
  permissions?: Partial<PermissionConfig>;
  codex?: CodexConfig;
  kimi?: KimiConfig;
  secrets?: SecretsConfig;
}

export function createDefaultProfileConfig(
  input: CreateDefaultProfileConfigInput,
): ProfileConfig {
  return normalizeProfileConfig({
    schemaVersion: 2,
    ...input,
  });
}

export function normalizeProfileConfig(input: unknown): ProfileConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('profile config must be an object');
  }
  const raw = input as {
    schemaVersion?: unknown;
    agentKind?: unknown;
    accounts?: unknown;
    secrets?: SecretsConfig;
    preferences?: (AppPreferences & { access?: Partial<ProfileAccess> }) | undefined;
    access?: Partial<ProfileAccess>;
    workspaces?: {
      default?: unknown;
      allowedRoots?: unknown;
      // Legacy workspace authorization fields are accepted for config
      // compatibility only; normalizeWorkspaces drops them.
      trusted?: unknown;
      trustedRoots?: unknown;
      riskFlags?: unknown;
    };
    sandbox?: Partial<SandboxConfig>;
    permissions?: Partial<PermissionConfig>;
    codex?: CodexConfig & { flags?: unknown };
    kimi?: KimiConfig;
    attachments?: Partial<AttachmentConfig>;
    comments?: unknown;
    larkCli?: unknown;
  };

  if (raw.schemaVersion !== 2) {
    throw new Error('profile schemaVersion must be 2');
  }
  if (raw.agentKind !== 'claude' && raw.agentKind !== 'codex' && raw.agentKind !== 'kimi') {
    throw new Error('agentKind must be claude, codex, or kimi');
  }
  const accounts = normalizeAccounts(raw.accounts);
  if (raw.agentKind === 'codex' && !raw.codex) {
    throw new Error('codex profile requires codex configuration');
  }
  if (
    raw.agentKind === 'kimi' &&
    (!raw.kimi || typeof raw.kimi.binaryPath !== 'string' || !raw.kimi.binaryPath.trim())
  ) {
    throw new Error('kimi profile requires kimi.binaryPath');
  }

  const preferences = normalizePreferences(raw.preferences);
  const access = normalizeAccess(
    raw.access ?? raw.preferences?.access,
    raw.preferences?.requireMentionInGroup,
  );
  const { permissions, source: permissionSource } = normalizePermissions({
    permissions:
      raw.permissions ??
      (raw.agentKind === 'kimi' && raw.sandbox === undefined
        ? { defaultAccess: 'read-only', maxAccess: 'read-only' }
        : undefined),
    sandbox: raw.sandbox,
  });
  const sandbox = permissionsToLegacySandbox(permissions);
  const workspaces = normalizeWorkspaces(raw.workspaces);
  if (raw.agentKind !== 'kimi' && workspaces.allowedRoots) {
    throw new Error('workspaces.allowedRoots is supported only for Kimi profiles');
  }
  const comments = normalizeComments(raw.comments);
  const larkCli = normalizeLarkCli(raw.larkCli);

  return {
    schemaVersion: 2,
    agentKind: raw.agentKind,
    accounts,
    ...(raw.secrets ? { secrets: raw.secrets } : {}),
    preferences,
    access,
    workspaces,
    sandbox,
    permissions,
    permissionSource,
    ...(raw.codex ? { codex: normalizeCodex(raw.codex) } : {}),
    ...(raw.kimi ? { kimi: normalizeKimi(raw.kimi) } : {}),
    attachments: {
      maxCount: numberOr(raw.attachments?.maxCount, 10),
      maxBytes: numberOr(raw.attachments?.maxBytes, 100 * 1024 * 1024),
      maxFileBytes: numberOr(raw.attachments?.maxFileBytes, 25 * 1024 * 1024),
      imageMaxBytes: numberOr(raw.attachments?.imageMaxBytes, 25 * 1024 * 1024),
      cacheTtlMs: numberOr(raw.attachments?.cacheTtlMs, 24 * 60 * 60 * 1000),
      cacheMaxBytes: numberOr(raw.attachments?.cacheMaxBytes, 512 * 1024 * 1024),
    },
    comments,
    larkCli,
  };
}

function normalizeAccounts(input: unknown): ProfileConfig['accounts'] {
  if (!input || typeof input !== 'object') {
    throw new Error('accounts.app is required');
  }
  const accounts = input as { app?: Partial<AppCredentials> };
  const app = accounts.app;
  if (!app?.id || !app.secret || (app.tenant !== 'feishu' && app.tenant !== 'lark')) {
    throw new Error('accounts.app is incomplete');
  }
  return {
    app: {
      id: app.id,
      secret: app.secret,
      tenant: app.tenant,
    },
  };
}

function normalizePreferences(
  preferences: AppPreferences | undefined,
): ProfileConfig['preferences'] {
  const {
    access: _access,
    requireMentionInGroup: _mention,
    messageReply,
    ...rest
  } = preferences ?? {};
  if (messageReply !== undefined && isMessageReply(messageReply)) {
    return {
      ...rest,
      messageReply,
    };
  }
  return rest;
}

function isMessageReply(value: unknown): value is MessageReplyMode {
  return value === 'card' || value === 'markdown' || value === 'text';
}

function normalizeAccess(
  access: Partial<ProfileAccess> | undefined,
  legacyRequireMentionInGroup: boolean | undefined,
): ProfileAccess {
  return {
    allowedUsers: stringArray(access?.allowedUsers),
    allowedChats: stringArray(access?.allowedChats),
    admins: stringArray(access?.admins),
    requireMentionInGroup: access?.requireMentionInGroup ?? legacyRequireMentionInGroup ?? true,
  };
}

function normalizeWorkspaces(input: {
  default?: unknown;
  allowedRoots?: unknown;
  trusted?: unknown;
  trustedRoots?: unknown;
  riskFlags?: unknown;
} | undefined): ProfileConfig['workspaces'] {
  const defaultWorkspace = typeof input?.default === 'string' && input.default.trim()
    ? input.default.trim()
    : undefined;
  const allowedRoots = normalizeAllowedWorkspaceRoots(input?.allowedRoots, defaultWorkspace);
  return {
    ...(defaultWorkspace ? { default: defaultWorkspace } : {}),
    ...(allowedRoots.length > 0 ? { allowedRoots } : {}),
  };
}

function normalizeAllowedWorkspaceRoots(value: unknown, defaultWorkspace?: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('workspaces.allowedRoots must be an array of absolute paths');
  }

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || !isAbsolute(item.trim())) {
      throw new Error('workspaces.allowedRoots must contain only absolute paths');
    }
    const root = item.trim();
    if (root === defaultWorkspace || seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
  }
  return roots;
}

function normalizeCodex(input: CodexConfig & { flags?: unknown }): CodexConfig {
  const codex: CodexConfig = {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.codexHome === 'string' ? { codexHome: input.codexHome } : {}),
    inheritCodexHome: input.inheritCodexHome !== false,
    ignoreUserConfig: input.ignoreUserConfig === true,
    ignoreRules: input.ignoreRules !== false,
    ...(input.router ? { router: normalizeCodexRouter(input.router) } : {}),
  };
  return codex;
}

function normalizeCodexRouter(
  input: CodexModelRouterConfig,
): CodexModelRouterConfig {
  const classifierCommand =
    typeof input.classifierCommand === 'string' && input.classifierCommand.trim()
      ? input.classifierCommand.trim()
      : undefined;
  if (classifierCommand && !isAbsolute(classifierCommand)) {
    throw new Error('codex.router.classifierCommand must be an absolute path');
  }
  const fallbackEffort =
    typeof input.fallbackEffort === 'string' && input.fallbackEffort.trim()
      ? input.fallbackEffort.trim()
      : undefined;
  if (
    fallbackEffort &&
    !['low', 'medium', 'high', 'xhigh', 'ultra'].includes(fallbackEffort)
  ) {
    throw new Error(
      'codex.router.fallbackEffort must be one of low, medium, high, xhigh, ultra',
    );
  }
  return {
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
    ...(classifierCommand ? { classifierCommand } : {}),
    ...(input.classifierArgs !== undefined
      ? { classifierArgs: normalizeClassifierArgs(input.classifierArgs) }
      : {}),
    ...(typeof input.classifierModel === 'string' && input.classifierModel.trim()
      ? { classifierModel: input.classifierModel.trim() }
      : {}),
    ...(typeof input.classifierEffort === 'string' && input.classifierEffort.trim()
      ? { classifierEffort: input.classifierEffort.trim() }
      : {}),
    ...(typeof input.timeoutMs === 'number' && input.timeoutMs > 0
      ? { timeoutMs: Math.floor(input.timeoutMs) }
      : {}),
    ...(fallbackEffort
      ? {
          fallbackEffort: fallbackEffort as NonNullable<
            CodexModelRouterConfig['fallbackEffort']
          >,
        }
      : {}),
  };
}

function normalizeClassifierArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('codex.router.classifierArgs must contain only strings');
  }
  return [...value];
}

function normalizeKimi(input: KimiConfig): KimiConfig {
  const defaultModel =
    typeof input.defaultModel === 'string' && input.defaultModel.trim()
      ? input.defaultModel.trim()
      : undefined;
  return {
    binaryPath: input.binaryPath.trim(),
    ...(defaultModel ? { defaultModel } : {}),
  };
}

function normalizeComments(_input: unknown): CommentConfig {
  return {};
}

function normalizeLarkCli(input: unknown): LarkCliConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { identityPreset: 'bot-only' };
  }
  const raw = input as {
    identityPreset?: unknown;
    localUserImport?: unknown;
  };
  const identityPreset: LarkCliIdentityPreset =
    raw.identityPreset === 'user-default' ? 'user-default' : 'bot-only';
  const localUserImport = normalizeLarkCliUserImport(raw.localUserImport);
  return {
    identityPreset,
    ...(localUserImport ? { localUserImport } : {}),
  };
}

function normalizeLarkCliUserImport(input: unknown): LarkCliConfig['localUserImport'] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as {
    status?: unknown;
    attemptedAt?: unknown;
    importedAt?: unknown;
    reason?: unknown;
  };
  if (!isLarkCliUserImportStatus(raw.status)) return undefined;
  return {
    status: raw.status,
    ...(typeof raw.attemptedAt === 'string' ? { attemptedAt: raw.attemptedAt } : {}),
    ...(typeof raw.importedAt === 'string' ? { importedAt: raw.importedAt } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

function isLarkCliUserImportStatus(value: unknown): value is LarkCliUserImportStatus {
  return (
    value === 'not-needed' ||
    value === 'imported' ||
    value === 'skipped-existing-private-user' ||
    value === 'skipped-no-local-user' ||
    value === 'failed'
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
