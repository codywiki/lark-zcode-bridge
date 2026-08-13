import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { ZCODE_DEFAULT_RUNTIME_PATH } from '../agent/zcode/profile-home';
import type { AgentKind } from '../config/profile-schema';

export type { AgentKind } from '../config/profile-schema';

export interface DetectedAgent {
  kind: AgentKind;
  binaryPath: string;
}

export async function resolveExecutablePath(command: string): Promise<string> {
  if (isAbsolute(command)) {
    await access(command, constants.X_OK);
    return command;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const candidate of executableCandidates(dir, command)) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new Error(`executable not found: ${command}`);
}

function executableCandidates(dir: string, command: string): string[] {
  const candidates = [join(dir, command)];
  if (extname(command)) return candidates;
  for (const ext of pathExts()) {
    candidates.push(join(dir, `${command}${ext}`));
  }
  return candidates;
}

function pathExts(): string[] {
  return (process.env.PATHEXT ?? '')
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
}

/** The ZCode runtime is a bundled .cjs file, so detect readability, not +x. */
export async function resolveZcodeRuntimePath(command: string): Promise<string> {
  await access(command, constants.R_OK);
  return command;
}

export function defaultZcodeRuntimePath(): string {
  return process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH ?? ZCODE_DEFAULT_RUNTIME_PATH;
}

export async function detectInstalledAgents(): Promise<DetectedAgent[]> {
  try {
    return [
      { kind: 'zcode', binaryPath: await resolveZcodeRuntimePath(defaultZcodeRuntimePath()) },
    ];
  } catch {
    return [];
  }
}
