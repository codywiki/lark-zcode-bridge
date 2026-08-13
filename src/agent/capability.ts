import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'zcode';
export type AgentSessionKind = 'zcode-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function zcodeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  // Default full access (yolo), matching the upstream bridge's claude default.
  // Profiles can lower defaultAccess/maxAccess to 'workspace' (build) or
  // 'read-only' (plan) via the permissions config.
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'zcode',
    sessionKind: 'zcode-session',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    // `--resume sess_<id>` carries the full server-side conversation history.
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function capabilityForProfile(profile: ProfileConfig): AgentCapability {
  return zcodeCapability(profile);
}
