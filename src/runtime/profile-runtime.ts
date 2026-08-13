import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runRegistrationWizard } from '../bot/wizard';
import { defaultZcodeRuntimePath, detectInstalledAgents } from '../cli/agent-detection';
import {
  createBootstrapProfileConfig,
  createBootstrapZcodeConfig,
  resolveBootstrapWorkspace,
} from '../cli/profile-bootstrap';
import { promptPassword } from '../cli/prompt';
import { setSecret } from '../config/keystore';
import { resolveAppPaths, type AppPaths } from '../config/app-paths';
import {
  ActiveBridgeMigrationConflictError,
  collectLegacyDefaultWorkspace,
  migrateV1ToV2,
  type MigrateV2Options,
} from '../config/migrate-v2';
import {
  agentKindFromString,
  createRootConfig,
  hasPermissionDefaultsMigration,
  loadRootConfig,
  markPermissionDefaultsMigration,
  readActiveProfile,
  runtimeProfileConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../config/profile-store';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type CreateDefaultProfileConfigInput,
  type ProfileConfig,
  type RootConfig,
} from '../config/profile-schema';
import { permissionsToLegacySandbox } from '../config/permissions';
import type { AppConfig, SecretInput, TenantBrand } from '../config/schema';
import { isComplete, isSecretRef, secretKeyForApp } from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import {
  buildEncryptedAccountConfig,
  ensureSecretsGetterWrapper,
  loadConfig,
  saveConfig,
} from '../config/store';
import { log } from '../core/logger';
import {
  hasLegacyLarkCliSourceOverlay,
  recoverLegacyLarkCliSourceOverlay,
} from '../lark-cli/legacy-source-overlay';
import { validateAppCredentials } from '../utils/feishu-auth';

export interface ResolveProfileRuntimeOptions {
  config?: string;
  profile?: string;
  agent?: string;
  workspace?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
  allowBootstrap?: boolean;
  handleActiveBridgeMigrationConflict?: (
    err: ActiveBridgeMigrationConflictError,
  ) => boolean | Promise<boolean>;
}

export interface ProfileRuntime {
  cfg: AppConfig & { agentKind?: AgentKind };
  profileConfig: ProfileConfig;
  configPath: string;
  appPaths: AppPaths;
  profile: string;
}

export interface MaterializeEnvSecretForServiceOptions {
  config?: string;
  profile?: string;
}

const ENV_SECRET_TEMPLATE_RE = /^\$\{[A-Z][A-Z0-9_]{0,127}\}$/;

export function createRuntimeProfileConfig(
  input: CreateDefaultProfileConfigInput,
): ProfileConfig {
  return createDefaultProfileConfig({
    ...input,
    zcode: input.zcode ?? { runtimePath: defaultZcodeRuntimePath() },
  });
}

export async function resolveProfileRuntime(
  opts: ResolveProfileRuntimeOptions,
): Promise<ProfileRuntime> {
  const rootDir = opts.config ? dirname(opts.config) : undefined;
  const recoveryConfigFile = opts.config ?? resolveAppPaths({ rootDir }).configFile;
  if (await hasLegacyLarkCliSourceOverlay(recoveryConfigFile)) {
    await recoverLegacyLarkCliSourceOverlay(recoveryConfigFile);
  }
  const requestedAgent = agentKindFromString(opts.agent);
  const explicitProfile = opts.profile;
  const activeProfile = explicitProfile ?? (await readActiveProfile(rootDir));
  let profile = activeProfile ?? requestedAgent;
  if (!profile && opts.allowBootstrap) {
    const detected = await detectInstalledAgents();
    if (detected.length === 0) {
      throw new Error('no supported local agent found; install the ZCode desktop app first');
    }
    profile = detected[0]?.kind;
  }
  if (!profile && !opts.allowBootstrap) {
    throw new Error('active profile is required');
  }
  profile ??= 'zcode';
  let appPaths = resolveAppPaths({ rootDir, profile });
  const configPath = opts.config ?? appPaths.configFile;

  const migrationAgent = requestedAgent ?? 'zcode';
  const needsMigration = await hasLegacyConfig(configPath);
  await migrateV1ToV2WithActiveBridgeHandling({
    rootDir: appPaths.rootDir,
    profile: appPaths.profile,
    configFile: configPath,
    workspace: opts.workspace,
    agentKind: migrationAgent,
    ...(needsMigration ? { zcode: await createBootstrapZcodeConfig(undefined) } : {}),
  }, opts.handleActiveBridgeMigrationConflict);

  let rootConfig = await loadRootConfig(configPath);
  if (rootConfig) {
    if (!explicitProfile && !activeProfile) {
      profile = rootConfig.activeProfile;
      appPaths = resolveAppPaths({ rootDir, profile });
    }
    const profileConfig = rootConfig.profiles[profile];
    if (!profileConfig) {
      if (opts.allowBootstrap && explicitProfile) {
        return bootstrapProfileIntoExistingRoot({
          rootConfig,
          profile,
          opts,
          appPaths,
          configPath,
        });
      }
      throw new Error(`profile not found: ${profile}`);
    }
    assertRequestedAgentMatchesExistingProfile(profile, profileConfig, requestedAgent);
    const runtimeUpgrade = upgradeLegacyRuntimeDefaults(rootConfig, profile);
    if (runtimeUpgrade.changed) {
      rootConfig = runtimeUpgrade.rootConfig;
    }
    const defaultWorkspaceUpgrade = await ensureProfileDefaultWorkspace(rootConfig, profile, appPaths);
    if (defaultWorkspaceUpgrade.changed) {
      rootConfig = defaultWorkspaceUpgrade.rootConfig;
    }
    if (runtimeUpgrade.changed || defaultWorkspaceUpgrade.changed) {
      await saveRootConfig(rootConfig, configPath);
      log.info('profile', 'legacy-runtime-defaults-upgraded', {
        profile,
        permissions: runtimeUpgrade.permissions,
        workspace: defaultWorkspaceUpgrade.changed,
      });
    }
    assertBootstrapAppMatchesExistingProfile(opts, profile, rootConfig.profiles[profile]!);
    const cfg = await maybeMigrateRootPlaintextSecret(rootConfig, profile, appPaths, configPath);
    return { cfg, profileConfig: rootConfig.profiles[profile]!, configPath, appPaths, profile };
  }

  const existing = await loadConfig(configPath);
  if (isComplete(existing)) {
    assertBootstrapAppMatchesExistingConfig(opts, profile, existing);
    const cfg = await maybeMigratePlaintextSecret(existing, configPath, appPaths);
    const profileConfig = createRuntimeProfileConfig({
      agentKind: 'zcode',
      accounts: cfg.accounts,
      preferences: cfg.preferences,
      secrets: cfg.secrets,
    });
    profileConfig.workspaces.default = await resolveConvertedLegacyDefaultWorkspace(opts, appPaths);
    const root = createRootConfig(profile, profileConfig, cfg.secrets);
    await saveRootConfig(root, configPath);
    await writeActiveProfile(appPaths.rootDir, profile);
    return {
      cfg: runtimeProfileConfig(root, profile),
      profileConfig: root.profiles[profile]!,
      configPath,
      appPaths,
      profile,
    };
  }

  if (!opts.allowBootstrap) {
    throw new Error('config not initialized');
  }
  const workspace = opts.workspace;
  const fresh = await resolveBootstrapAppConfig(opts);
  const encrypted = await encryptedConfigForProfile(fresh, appPaths);
  const profileConfig = await createBootstrapProfileConfig({
    agentKind: 'zcode',
    accounts: encrypted.accounts,
    preferences: encrypted.preferences,
    secrets: encrypted.secrets,
    workspace,
    defaultWorkspace: appPaths.defaultWorkspaceDir,
    profileDir: appPaths.profileDir,
  });
  const root = createRootConfig(profile, profileConfig, encrypted.secrets);
  await saveRootConfig(root, configPath);
  await writeActiveProfile(appPaths.rootDir, profile);
  console.log(`配置已保存到 ${configPath}\n`);
  return {
    cfg: runtimeProfileConfig(root, profile),
    profileConfig: root.profiles[profile]!,
    configPath,
    appPaths,
    profile,
  };
}

async function bootstrapProfileIntoExistingRoot(args: {
  rootConfig: RootConfig;
  profile: string;
  opts: ResolveProfileRuntimeOptions;
  appPaths: AppPaths;
  configPath: string;
}): Promise<ProfileRuntime> {
  const { rootConfig, profile, opts, appPaths, configPath } = args;
  const workspace = opts.workspace;
  const fresh = await resolveBootstrapAppConfig(opts);
  const encrypted = await encryptedConfigForProfile(fresh, appPaths);
  const profileConfig = await createBootstrapProfileConfig({
    agentKind: 'zcode',
    accounts: encrypted.accounts,
    preferences: encrypted.preferences,
    secrets: encrypted.secrets,
    workspace,
    defaultWorkspace: appPaths.defaultWorkspaceDir,
    profileDir: appPaths.profileDir,
  });
  const nextRoot: RootConfig = {
    ...rootConfig,
    ...(rootConfig.secrets ?? encrypted.secrets
      ? { secrets: rootConfig.secrets ?? encrypted.secrets }
      : {}),
    profiles: {
      ...rootConfig.profiles,
      [profile]: {
        ...profileConfig,
        secrets: undefined,
      },
    },
  };
  const storedRoot = markPermissionDefaultsMigration(nextRoot, profile);
  await saveRootConfig(storedRoot, configPath);
  console.log(`配置已保存到 ${configPath}\n`);
  return {
    cfg: runtimeProfileConfig(storedRoot, profile),
    profileConfig: storedRoot.profiles[profile]!,
    configPath,
    appPaths,
    profile,
  };
}

function upgradeLegacyRuntimeDefaults(
  rootConfig: RootConfig,
  profile: string,
): { rootConfig: RootConfig; changed: boolean; permissions: boolean } {
  const profileConfig = rootConfig.profiles[profile];
  if (!profileConfig) {
    return { rootConfig, changed: false, permissions: false };
  }

  const permissionDefaultsMigrated = hasPermissionDefaultsMigration(rootConfig, profile);
  const legacySandboxPolicy = profileConfig.permissionSource === 'sandbox';
  const permissionsChanged = legacySandboxPolicy;
  const permissionDefaultsMarkerChanged = !permissionDefaultsMigrated;
  if (!permissionsChanged && !permissionDefaultsMarkerChanged) {
    return { rootConfig, changed: false, permissions: false };
  }

  const nextProfile: ProfileConfig = {
    ...profileConfig,
    ...(permissionsChanged
      ? {
          permissionSource: 'permissions' as const,
          sandbox: permissionsToLegacySandbox(profileConfig.permissions),
        }
      : {}),
  };

  const nextRoot = {
    ...rootConfig,
    profiles: {
      ...rootConfig.profiles,
      [profile]: nextProfile,
    },
  };

  return {
    changed: true,
    permissions: permissionsChanged,
    rootConfig: permissionDefaultsMarkerChanged
      ? markPermissionDefaultsMigration(nextRoot, profile)
      : nextRoot,
  };
}

async function ensureProfileDefaultWorkspace(
  rootConfig: RootConfig,
  profile: string,
  appPaths: AppPaths,
): Promise<{ rootConfig: RootConfig; changed: boolean }> {
  const profileConfig = rootConfig.profiles[profile];
  if (!profileConfig || profileConfig.workspaces.default) {
    return { rootConfig, changed: false };
  }

  await mkdir(appPaths.defaultWorkspaceDir, { recursive: true, mode: 0o700 });
  const defaultWorkspace = await realpath(appPaths.defaultWorkspaceDir);
  const nextProfile: ProfileConfig = {
    ...profileConfig,
    workspaces: {
      ...profileConfig.workspaces,
      default: defaultWorkspace,
    },
  };

  return {
    changed: true,
    rootConfig: {
      ...rootConfig,
      profiles: {
        ...rootConfig.profiles,
        [profile]: nextProfile,
      },
    },
  };
}

async function resolveConvertedLegacyDefaultWorkspace(
  opts: ResolveProfileRuntimeOptions,
  appPaths: AppPaths,
): Promise<string> {
  if (opts.workspace) return resolveBootstrapWorkspace(opts.workspace);
  const legacyDefault = await collectLegacyDefaultWorkspace(appPaths.rootDir);
  if (legacyDefault) return legacyDefault;
  await mkdir(appPaths.defaultWorkspaceDir, { recursive: true, mode: 0o700 });
  return realpath(appPaths.defaultWorkspaceDir);
}

async function hasLegacyConfig(configPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  const parsed = JSON.parse(raw) as { schemaVersion?: unknown };
  return parsed.schemaVersion !== 2;
}

async function migrateV1ToV2WithActiveBridgeHandling(
  options: MigrateV2Options,
  handler: ResolveProfileRuntimeOptions['handleActiveBridgeMigrationConflict'],
): Promise<void> {
  for (;;) {
    try {
      await migrateV1ToV2(options);
      return;
    } catch (err) {
      if (!(err instanceof ActiveBridgeMigrationConflictError) || !handler) throw err;
      const shouldRetry = await handler(err);
      if (!shouldRetry) throw err;
    }
  }
}

async function resolveBootstrapAppConfig(opts: ResolveProfileRuntimeOptions): Promise<AppConfig> {
  if (!opts.appId) {
    if (!isInteractiveTerminal()) {
      throw new Error(
        '当前没有配置，非交互模式无法完成扫码创建应用。' +
          '请先在终端运行 `lark-zcode-bridge run` 完成首次初始化，' +
          '或传入 --app-id 和 --app-secret。',
      );
    }
    return runRegistrationWizard();
  }
  let appSecret = opts.appSecret;
  if (!appSecret) {
    if (!isInteractiveTerminal()) {
      throw new Error(
        `非交互模式缺少 App Secret: ${opts.appId}。` +
          '请传入 --app-secret <secret>，或在终端中重新运行命令后按提示输入。',
      );
    }
    appSecret = await promptPassword(`输入 ${opts.appId} 的 App Secret: `);
  }
  if (!appSecret) throw new Error('app secret is required');
  const tenant = tenantBrandFromString(opts.tenant);
  const result = await validateAppCredentials(opts.appId, appSecret, tenant);
  if (!result.ok) {
    throw new Error(`app credentials validation failed: ${result.reason ?? 'unknown'}`);
  }
  if (result.botName) {
    console.log(`✓ 应用凭证校验通过: ${result.botName}`);
  } else {
    console.log('✓ 应用凭证校验通过');
  }
  return {
    accounts: {
      app: {
        id: opts.appId,
        secret: appSecret,
        tenant,
      },
    },
  };
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function tenantBrandFromString(value: string | undefined): TenantBrand {
  if (value === undefined) return 'feishu';
  if (value === 'feishu' || value === 'lark') return value;
  throw new Error(`unsupported tenant: ${value}`);
}

function assertBootstrapAppMatchesExistingProfile(
  opts: ResolveProfileRuntimeOptions,
  profile: string,
  profileConfig: ProfileConfig,
): void {
  if (!opts.appId || opts.appId === profileConfig.accounts.app.id) return;
  throw new Error(
    `profile already exists: ${profile}; it uses app ${profileConfig.accounts.app.id}. ` +
      'omit --app-id or create another profile',
  );
}

function assertRequestedAgentMatchesExistingProfile(
  profile: string,
  profileConfig: ProfileConfig,
  requestedAgent: AgentKind | undefined,
): void {
  if (!requestedAgent || profileConfig.agentKind === requestedAgent) return;
  throw new Error(
    `profile ${profile} already exists with agentKind ${profileConfig.agentKind}, ` +
      `but this command requested --agent ${requestedAgent}. ` +
      `Profile names are labels; to use the existing ${profileConfig.agentKind} profile, omit --agent. ` +
      `To recreate it as ${requestedAgent}, remove profile ${profile} first.`,
  );
}

function assertBootstrapAppMatchesExistingConfig(
  opts: ResolveProfileRuntimeOptions,
  profile: string,
  cfg: AppConfig,
): void {
  if (!opts.appId || opts.appId === cfg.accounts.app.id) return;
  throw new Error(
    `profile already exists: ${profile}; it uses app ${cfg.accounts.app.id}. ` +
      'omit --app-id or create another profile',
  );
}

export async function materializeEnvSecretForService(
  opts: MaterializeEnvSecretForServiceOptions = {},
): Promise<boolean> {
  const rootDir = opts.config ? dirname(opts.config) : undefined;
  const explicitProfile = opts.profile;
  const activeProfile = explicitProfile ?? (await readActiveProfile(rootDir));
  let profile = activeProfile ?? 'zcode';
  let appPaths = resolveAppPaths({ rootDir, profile });
  const configPath = opts.config ?? appPaths.configFile;

  const rootConfig = await loadRootConfig(configPath);
  if (rootConfig) {
    if (!explicitProfile && !activeProfile) {
      profile = rootConfig.activeProfile;
      appPaths = resolveAppPaths({ rootDir, profile });
    }
    const profileConfig = rootConfig.profiles[profile];
    if (!profileConfig) throw new Error(`profile not found: ${profile}`);
    const cfg = runtimeProfileConfig(rootConfig, profile);
    if (!isEnvBackedSecret(cfg.accounts.app.secret)) return false;

    const encrypted = await encryptedConfigForResolvedSecret(
      cfg,
      await resolveAppSecret(cfg, appPaths),
      appPaths,
    );
    rootConfig.profiles[profile] = {
      ...profileConfig,
      accounts: encrypted.accounts,
    };
    if (encrypted.secrets) rootConfig.secrets = encrypted.secrets;
    await saveRootConfig(rootConfig, configPath);
    return true;
  }

  const existing = await loadConfig(configPath);
  if (!isComplete(existing) || !isEnvBackedSecret(existing.accounts.app.secret)) return false;
  const encrypted = await encryptedConfigForResolvedSecret(
    existing,
    await resolveAppSecret(existing, appPaths),
    appPaths,
  );
  await saveConfig(encrypted, configPath);
  return true;
}


async function maybeMigrateRootPlaintextSecret(
  rootConfig: RootConfig,
  profile: string,
  appPaths: Pick<AppPaths, 'secretsGetterScript' | 'secretsFile' | 'keystoreSaltFile'>,
  configPath: string,
): Promise<AppConfig & { agentKind?: AgentKind }> {
  const cfg = runtimeProfileConfig(rootConfig, profile);
  const secret = cfg.accounts.app.secret;
  if (typeof secret !== 'string' || /^\$\{[A-Z][A-Z0-9_]*\}$/.test(secret)) {
    return cfg;
  }

  const encrypted = await encryptedConfigForProfile(cfg, appPaths);
  const profileConfig = rootConfig.profiles[profile];
  if (!profileConfig) throw new Error(`profile not found: ${profile}`);
  rootConfig.profiles[profile] = {
    ...profileConfig,
    accounts: encrypted.accounts,
  };
  if (encrypted.secrets) rootConfig.secrets = encrypted.secrets;
  await saveRootConfig(rootConfig, configPath);
  return runtimeProfileConfig(rootConfig, profile);
}

async function encryptedConfigForProfile(
  cfg: AppConfig,
  appPaths: Pick<AppPaths, 'secretsGetterScript' | 'secretsFile' | 'keystoreSaltFile'>,
): Promise<AppConfig> {
  const secret = cfg.accounts.app.secret;
  if (typeof secret !== 'string') return cfg;
  const next = await buildEncryptedAccountConfig(
    cfg.accounts.app.id,
    cfg.accounts.app.tenant,
    cfg.preferences,
    appPaths,
  );
  await setSecret(secretKeyForApp(cfg.accounts.app.id), secret, appPaths);
  return next;
}

async function encryptedConfigForResolvedSecret(
  cfg: AppConfig,
  plaintext: string,
  appPaths: Pick<AppPaths, 'secretsGetterScript' | 'secretsFile' | 'keystoreSaltFile'>,
): Promise<AppConfig> {
  const next = await buildEncryptedAccountConfig(
    cfg.accounts.app.id,
    cfg.accounts.app.tenant,
    cfg.preferences,
    appPaths,
  );
  await setSecret(secretKeyForApp(cfg.accounts.app.id), plaintext, appPaths);
  return next;
}

function isEnvBackedSecret(secret: SecretInput): boolean {
  if (typeof secret === 'string') return ENV_SECRET_TEMPLATE_RE.test(secret);
  return isSecretRef(secret) && secret.source === 'env';
}

async function maybeMigratePlaintextSecret(
  cfg: AppConfig,
  configPath: string,
  appPaths: Pick<AppPaths, 'secretsGetterScript' | 'secretsFile' | 'keystoreSaltFile'>,
): Promise<AppConfig> {
  const s = cfg.accounts.app.secret;
  if (typeof s === 'string' && !/^\$\{[A-Z][A-Z0-9_]*\}$/.test(s)) {
    try {
      const next = await buildEncryptedAccountConfig(
        cfg.accounts.app.id,
        cfg.accounts.app.tenant,
        cfg.preferences,
        appPaths,
      );
      await setSecret(secretKeyForApp(cfg.accounts.app.id), s, appPaths);
      await saveConfig(next, configPath);
      console.log('🔒 已把 App Secret 加密迁移到 profile 的 secrets.enc');
      return next;
    } catch (err) {
      log.warn('config', 'migrate-encrypted-failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return cfg;
    }
  }

  if (typeof s === 'string') return cfg;

  try {
    const wrapperPath = await ensureSecretsGetterWrapper(appPaths);
    if (needsProviderRewrite(cfg, wrapperPath)) {
      const next = await buildEncryptedAccountConfig(
        cfg.accounts.app.id,
        cfg.accounts.app.tenant,
        cfg.preferences,
        appPaths,
      );
      await saveConfig(next, configPath);
      console.log('🔒 已把 secrets provider 切到 wrapper 形态');
      return next;
    }
  } catch (err) {
    log.warn('config', 'wrapper-refresh-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return cfg;
}

function needsProviderRewrite(cfg: AppConfig, wrapperPath: string): boolean {
  const provider = cfg.secrets?.providers?.bridge;
  if (!provider) return true;
  if (provider.command !== wrapperPath) return true;
  if (!Array.isArray(provider.args) || provider.args.length !== 0) return true;
  return false;
}
