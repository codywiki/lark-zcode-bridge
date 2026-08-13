import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyZcodeModelOverride,
  applyZcodeReasoningOverride,
  isZcodeModelConfigReady,
  prepareZcodeProfileHome,
  setZcodeModelConfigApiKey,
  zcodeHomeDir,
  zcodeModelConfigFile,
  ZCODE_DEFAULT_BASE_URL,
  ZCODE_DEFAULT_MODEL,
  ZCODE_REASONING_LEVELS,
} from '../../../src/agent/zcode/profile-home.js';

describe('zcode profile-home', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'zcode-home-test-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function readConfig(homeDir: string): Record<string, unknown> {
    return JSON.parse(readFileSync(zcodeModelConfigFile(homeDir), 'utf8')) as Record<
      string,
      unknown
    >;
  }

  it('creates an isolated home with a generated model config', () => {
    const prepared = prepareZcodeProfileHome(stateDir, { apiKey: 'k-1' });
    expect(prepared.homeDir).toBe(zcodeHomeDir(stateDir));
    expect(prepared.env.HOME).toBe(prepared.homeDir);
    const config = readConfig(prepared.homeDir);
    expect(config.model).toEqual({
      main: ZCODE_DEFAULT_MODEL,
      lite: 'bigmodel/glm-5-turbo',
    });
    const provider = config.provider as Record<string, { options: { apiKey: string; baseURL: string } }>;
    expect(provider.bigmodel?.options.apiKey).toBe('k-1');
    expect(provider.bigmodel?.options.baseURL).toBe(ZCODE_DEFAULT_BASE_URL);
    // owner-only perms on the secret-bearing config
    expect(statSync(zcodeModelConfigFile(prepared.homeDir)).mode & 0o777).toBe(0o600);
  });

  it('never overwrites an existing config on prepare', () => {
    const first = prepareZcodeProfileHome(stateDir, { apiKey: 'original' });
    prepareZcodeProfileHome(stateDir, { apiKey: 'replaced' });
    const provider = readConfig(first.homeDir).provider as Record<
      string,
      { options: { apiKey: string } }
    >;
    expect(provider.bigmodel?.options.apiKey).toBe('original');
  });

  it('isZcodeModelConfigReady reflects key presence', () => {
    const prepared = prepareZcodeProfileHome(stateDir);
    expect(isZcodeModelConfigReady(prepared.homeDir)).toBe(false);
    setZcodeModelConfigApiKey(prepared.homeDir, 'k-2');
    expect(isZcodeModelConfigReady(prepared.homeDir)).toBe(true);
  });

  it('setZcodeModelConfigApiKey replaces only the key and preserves other fields', () => {
    const prepared = prepareZcodeProfileHome(stateDir, { apiKey: 'old' });
    const before = readConfig(prepared.homeDir);
    setZcodeModelConfigApiKey(prepared.homeDir, 'new');
    const after = readConfig(prepared.homeDir);
    const keyOf = (c: Record<string, unknown>) =>
      (c.provider as Record<string, { options: { apiKey: string } }>).bigmodel?.options.apiKey;
    expect(keyOf(after)).toBe('new');
    expect(after.model).toEqual(before.model);
    expect(after.permission).toEqual(before.permission);
  });

  it('setZcodeModelConfigApiKey rejects an empty key', () => {
    const prepared = prepareZcodeProfileHome(stateDir);
    expect(() => setZcodeModelConfigApiKey(prepared.homeDir, '   ')).toThrow();
  });

  it('setZcodeModelConfigApiKey creates the config when missing', () => {
    const homeDir = zcodeHomeDir(stateDir);
    mkdirSync(homeDir, { recursive: true });
    setZcodeModelConfigApiKey(homeDir, 'k-3');
    expect(isZcodeModelConfigReady(homeDir)).toBe(true);
  });

  it('applyZcodeModelOverride updates model.main and returns true', () => {
    const prepared = prepareZcodeProfileHome(stateDir, { apiKey: 'k' });
    expect(applyZcodeModelOverride(prepared.homeDir, 'bigmodel/glm-5-turbo')).toBe(true);
    expect(readConfig(prepared.homeDir).model).toMatchObject({
      main: 'bigmodel/glm-5-turbo',
    });
  });

  it('applyZcodeModelOverride returns false when the config is missing or broken', () => {
    const homeDir = zcodeHomeDir(stateDir);
    expect(applyZcodeModelOverride(homeDir, 'bigmodel/glm-5.2')).toBe(false);
    mkdirSync(join(homeDir, '.zcode', 'cli'), { recursive: true });
    writeFileSync(zcodeModelConfigFile(homeDir), 'not json', 'utf8');
    expect(applyZcodeModelOverride(homeDir, 'bigmodel/glm-5.2')).toBe(false);
  });

  it('prepare throws on an unparseable existing config', () => {
    const prepared = prepareZcodeProfileHome(stateDir);
    writeFileSync(prepared.configFile, '{broken', 'utf8');
    expect(() => prepareZcodeProfileHome(stateDir)).toThrow(/not valid JSON/);
  });

  function mainModelEntry(homeDir: string): Record<string, unknown> {
    const config = readConfig(homeDir);
    const provider = config.provider as Record<
      string,
      { models: Record<string, Record<string, unknown>> }
    >;
    return provider.bigmodel!.models['glm-5.2']!;
  }

  it('applyZcodeReasoningOverride writes the full mapping for high', () => {
    const prepared = prepareZcodeProfileHome(stateDir, { apiKey: 'k' });
    expect(applyZcodeReasoningOverride(prepared.homeDir, 'high')).toBe(true);
    const reasoning = mainModelEntry(prepared.homeDir).reasoning as Record<string, unknown>;
    expect(reasoning.enabled).toBe(true);
    expect(reasoning.levels).toEqual([...ZCODE_REASONING_LEVELS]);
    expect(reasoning.defaultLevel).toBe('high');
    // Partial blocks make zcode send NO thinking config at all — the full
    // providerOptionsByLevel mapping must always be present.
    expect(reasoning.providerOptionsByLevel).toEqual({
      max: { anthropic: { effort: 'max', thinking: { budgetTokens: 32000, type: 'enabled' } } },
      high: { anthropic: { effort: 'high', thinking: { budgetTokens: 16000, type: 'enabled' } } },
      nothink: { anthropic: { thinking: { type: 'disabled' } } },
    });
  });

  it('applyZcodeReasoningOverride disables thinking for nothink', () => {
    const prepared = prepareZcodeProfileHome(stateDir, { apiKey: 'k' });
    expect(applyZcodeReasoningOverride(prepared.homeDir, 'nothink')).toBe(true);
    const reasoning = mainModelEntry(prepared.homeDir).reasoning as {
      defaultLevel: string;
      providerOptionsByLevel: Record<string, unknown>;
    };
    expect(reasoning.defaultLevel).toBe('nothink');
    expect(reasoning.providerOptionsByLevel.nothink).toEqual({
      anthropic: { thinking: { type: 'disabled' } },
    });
  });

  it('applyZcodeReasoningOverride removes the block for undefined and max', () => {
    const prepared = prepareZcodeProfileHome(stateDir, { apiKey: 'k' });
    applyZcodeReasoningOverride(prepared.homeDir, 'high');
    expect(mainModelEntry(prepared.homeDir).reasoning).toBeDefined();

    expect(applyZcodeReasoningOverride(prepared.homeDir, 'max')).toBe(true);
    expect(mainModelEntry(prepared.homeDir).reasoning).toBeUndefined();

    applyZcodeReasoningOverride(prepared.homeDir, 'high');
    expect(applyZcodeReasoningOverride(prepared.homeDir, undefined)).toBe(true);
    expect(mainModelEntry(prepared.homeDir).reasoning).toBeUndefined();
  });

  it('applyZcodeReasoningOverride preserves the apiKey and other model fields', () => {
    const prepared = prepareZcodeProfileHome(stateDir, { apiKey: 'secret-k' });
    applyZcodeReasoningOverride(prepared.homeDir, 'high');
    const config = readConfig(prepared.homeDir);
    const provider = config.provider as Record<
      string,
      { options: { apiKey: string }; models: Record<string, Record<string, unknown>> }
    >;
    expect(provider.bigmodel?.options.apiKey).toBe('secret-k');
    expect(provider.bigmodel?.models['glm-5.2']?.name).toBe('GLM-5.2');
    expect(provider.bigmodel?.models['glm-5-turbo']).toBeDefined();
    // perms stay owner-only after the atomic rewrite
    expect(statSync(zcodeModelConfigFile(prepared.homeDir)).mode & 0o777).toBe(0o600);
  });

  it('applyZcodeReasoningOverride is a no-op when the config already matches', () => {
    const prepared = prepareZcodeProfileHome(stateDir, { apiKey: 'k' });
    applyZcodeReasoningOverride(prepared.homeDir, 'high');
    const before = readFileSync(zcodeModelConfigFile(prepared.homeDir), 'utf8');
    expect(applyZcodeReasoningOverride(prepared.homeDir, 'high')).toBe(true);
    expect(readFileSync(zcodeModelConfigFile(prepared.homeDir), 'utf8')).toBe(before);
  });

  it('applyZcodeReasoningOverride follows the main model after /model switches', () => {
    const prepared = prepareZcodeProfileHome(stateDir, { apiKey: 'k' });
    applyZcodeModelOverride(prepared.homeDir, 'bigmodel/glm-5-turbo');
    expect(applyZcodeReasoningOverride(prepared.homeDir, 'high')).toBe(true);
    const config = readConfig(prepared.homeDir);
    const provider = config.provider as Record<
      string,
      { models: Record<string, Record<string, unknown>> }
    >;
    const turbo = provider.bigmodel!.models['glm-5-turbo']!;
    expect((turbo.reasoning as { defaultLevel: string }).defaultLevel).toBe('high');
    expect(provider.bigmodel!.models['glm-5.2']!.reasoning).toBeUndefined();
  });

  it('applyZcodeReasoningOverride returns false when the config is missing or broken', () => {
    const homeDir = zcodeHomeDir(stateDir);
    expect(applyZcodeReasoningOverride(homeDir, 'high')).toBe(false);
    mkdirSync(join(homeDir, '.zcode', 'cli'), { recursive: true });
    writeFileSync(zcodeModelConfigFile(homeDir), 'not json', 'utf8');
    expect(applyZcodeReasoningOverride(homeDir, 'high')).toBe(false);
  });
});
