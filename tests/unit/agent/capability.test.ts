import { describe, expect, it } from 'vitest';
import { BRIDGE_SYSTEM_PROMPT } from '../../../src/agent/bridge-system-prompt';
import {
  capabilityForProfile,
  zcodeCapability,
} from '../../../src/agent/capability';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

describe('agent capability contract', () => {
  it('defines ZCode capability with stdin prompt injection and native history', () => {
    const capability = zcodeCapability();

    expect(capability).toMatchObject({
      agentId: 'zcode',
      sessionKind: 'zcode-session',
      promptInjection: 'stdin-prefix',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: [],
      },
    });
  });

  it('defaults to full access when no profile is provided', () => {
    expect(zcodeCapability().permissions.maxAccess).toBe('full');
  });

  it('uses the ZCode profile max access as the static capability ceiling', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });

    expect(zcodeCapability(profile).permissions.maxAccess).toBe('read-only');
  });

  it('selects capability from the profile', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    });

    expect(capabilityForProfile(profile).permissions.maxAccess).toBe('workspace');
    expect(capabilityForProfile(profile).agentId).toBe('zcode');
  });
});
