import { mkdir, realpath } from 'node:fs/promises';
import { AgentPreflightError } from '../agent/preflight';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type ProfileConfig,
  type ZcodeConfig,
} from '../config/profile-schema';
import type { AppConfig } from '../config/schema';
import { resolveWorkingDirectory } from '../policy/workspace';
import { defaultZcodeRuntimePath, resolveZcodeRuntimePath } from './agent-detection';

export interface BootstrapProfileInput {
  agentKind: AgentKind;
  accounts: AppConfig['accounts'];
  preferences?: AppConfig['preferences'];
  secrets?: AppConfig['secrets'];
  workspace?: string;
  defaultWorkspace?: string;
  zcodeRuntimePath?: string;
  profileDir?: string;
}

export async function createBootstrapProfileConfig(
  input: BootstrapProfileInput,
): Promise<ProfileConfig> {
  const workspace = input.workspace
    ? await resolveBootstrapWorkspace(input.workspace)
    : input.defaultWorkspace
      ? await ensureManagedDefaultWorkspace(input.defaultWorkspace)
      : undefined;
  const zcode = await createBootstrapZcodeConfig(input.zcodeRuntimePath);
  const profile = createDefaultProfileConfig({
    agentKind: input.agentKind,
    accounts: input.accounts,
    preferences: input.preferences,
    secrets: input.secrets,
    zcode,
  });
  if (workspace) {
    profile.workspaces = {
      ...profile.workspaces,
      default: workspace,
    };
  }
  return profile;
}

export async function resolveBootstrapWorkspace(workspace: string): Promise<string> {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}

async function ensureManagedDefaultWorkspace(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
}

/**
 * The ZCode runtime is the bundled `zcode.cjs` inside ZCode.app; bootstrap
 * only verifies the file is readable (no PATH resolution — it is not a $PATH
 * binary) so a missing ZCode install fails fast at profile creation.
 */
export async function createBootstrapZcodeConfig(
  runtimePath: string | undefined,
): Promise<ZcodeConfig> {
  const command = runtimePath ?? defaultZcodeRuntimePath();
  try {
    return { runtimePath: await resolveZcodeRuntimePath(command) };
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: bootstrapRuntimeErrorCode(errno),
      agentId: 'zcode',
      agentName: 'ZCode CLI',
      command: 'zcode',
      binaryPath: command,
      errno,
    });
  }
}

function bootstrapRuntimeErrorCode(errno: string | undefined) {
  if (errno === 'EACCES' || errno === 'EPERM') return 'agent-binary-not-executable';
  if (errno === 'ELOOP' || errno === 'ENOTDIR' || errno === 'EINVAL') {
    return 'agent-binary-resolve-failed';
  }
  return 'agent-binary-not-found';
}
