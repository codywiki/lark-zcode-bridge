import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Isolated ZCode home for a bridge profile.
 *
 * ZCode's CLI resolves its config, session DB, and logs under `$HOME/.zcode`.
 * The bridge runs every run with `HOME=<profileStateDir>/zcode-home` so it
 * never reads or writes the user's real `~/.zcode` (which holds the user's
 * live API key). The `--settings <path>` flag advertised by `--help` is
 * rejected by the 0.16.x parser, so HOME redirection is the only isolation
 * mechanism that actually works — verified against zcode 0.16.3.
 */

/**
 * Default ZCode runtime path on macOS — the runtime ships inside the
 * ZCode.app bundle. Kept for backwards compatibility; prefer
 * {@link defaultZcodeRuntimePathForPlatform} for new code.
 */
export const ZCODE_DEFAULT_RUNTIME_PATH =
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

/** Relative location of the bundled CLI inside an installed ZCode app. */
const APP_RUNTIME_REL = join('resources', 'glm', 'zcode.cjs');

/**
 * Candidate install roots for the ZCode desktop app on Windows, in priority
 * order. Electron installers (Squirrel / NSIS per-user) land in %LOCALAPPDATA%;
 * machine-wide NSIS installs land in %ProgramFiles%. The bundled CLI lives at
 * `<root>/resources/glm/zcode.cjs` (Electron lowercases the folder).
 */
function windowsRuntimeCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  const localAppData = env.LOCALAPPDATA;
  if (localAppData) {
    // Squirrel (ZCode) and per-user NSIS (Programs\ZCode) layouts.
    roots.push(join(localAppData, 'ZCode'), join(localAppData, 'Programs', 'ZCode'));
  }
  for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (pf) roots.push(join(pf, 'ZCode'));
  }
  return roots.map((root) => join(root, APP_RUNTIME_REL));
}

/** Candidate locations for a Linux install (AppImage-extracted / unpacked). */
function linuxRuntimeCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? '';
  const roots = ['/opt/ZCode', '/usr/lib/ZCode', ...(home ? [join(home, '.local', 'lib', 'ZCode')] : [])];
  return roots.map((root) => join(root, APP_RUNTIME_REL));
}

/**
 * Resolve the default ZCode runtime path for the current platform.
 *
 * Returns the first candidate that exists on disk; if none match, returns the
 * platform's conventional install path so the error message points the user at
 * a real location. Set `LARK_ZCODE_BRIDGE_RUNTIME_PATH` to override detection
 * entirely (handled by callers in agent-detection).
 */
export function defaultZcodeRuntimePathForPlatform(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'darwin') return ZCODE_DEFAULT_RUNTIME_PATH;
  const candidates = platform === 'win32' ? windowsRuntimeCandidates(env) : linuxRuntimeCandidates(env);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Fall back to the first candidate so the "not found" error names a sane path.
  return candidates[0] ?? ZCODE_DEFAULT_RUNTIME_PATH;
}
export const ZCODE_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
export const ZCODE_ZAI_BASE_URL = 'https://api.z.ai/api/anthropic';
export const ZCODE_DEFAULT_MODEL = 'bigmodel/glm-5.2';
export const ZCODE_DEFAULT_LITE_MODEL = 'bigmodel/glm-5-turbo';
export const ZCODE_API_KEY_ENV = 'ZCODE_API_KEY';

export interface PreparedZcodeProfileHome {
  /** Directory used as HOME for the zcode child process. */
  homeDir: string;
  /** Extra environment for the child (currently just HOME). */
  env: Record<string, string>;
  /** Absolute path of the model config file inside the isolated home. */
  configFile: string;
}

export interface ZcodeModelConfigOptions {
  /** API key written into a newly generated config; ignored when one exists. */
  apiKey?: string;
  /** Main model id (default bigmodel/glm-5.2). */
  model?: string;
  /** Anthropic-compatible base URL (default BigModel Coding Plan). */
  baseURL?: string;
}

export function zcodeHomeDir(profileStateDir: string): string {
  return join(profileStateDir, 'zcode-home');
}

export function zcodeModelConfigFile(homeDir: string): string {
  return join(homeDir, '.zcode', 'cli', 'config.json');
}

/**
 * Create the isolated home (0700) and generate a model config when missing.
 * An existing config is left untouched — profile-home never overwrites a key
 * the operator already set. Returns paths plus the child env overlay.
 */
export function prepareZcodeProfileHome(
  profileStateDir: string,
  options: ZcodeModelConfigOptions = {},
): PreparedZcodeProfileHome {
  const homeDir = zcodeHomeDir(profileStateDir);
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  chmodSync(homeDir, 0o700);
  const configFile = zcodeModelConfigFile(homeDir);
  if (!existsSync(configFile)) {
    writeZcodeModelConfigAtomic(configFile, buildZcodeModelConfig(options));
  } else {
    // Fail fast on a config zcode itself cannot parse; never echo contents.
    assertZcodeModelConfigReadable(configFile);
    chmodSync(configFile, 0o600);
  }
  return {
    homeDir,
    env: { HOME: homeDir },
    configFile,
  };
}

/**
 * True when the isolated config exists and carries a non-empty API key.
 * ZCode 0.16.x reports an empty key as "Model config is missing", so key
 * presence is the actionable readiness signal for the bridge.
 */
export function isZcodeModelConfigReady(homeDir: string): boolean {
  const configFile = zcodeModelConfigFile(homeDir);
  try {
    const parsed = JSON.parse(readFileSync(configFile, 'utf8')) as unknown;
    return Boolean(findApiKey(parsed));
  } catch {
    return false;
  }
}

/**
 * Write (or keep) the model config with the given API key. When the config
 * already exists, only the apiKey field is replaced; all other operator
 * edits (models, baseURL, permission defaults) are preserved. The key is
 * written with 0600 perms and never logged.
 */
export function setZcodeModelConfigApiKey(homeDir: string, apiKey: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error('API key must not be empty');
  const configFile = zcodeModelConfigFile(homeDir);
  if (!existsSync(configFile)) {
    writeZcodeModelConfigAtomic(configFile, buildZcodeModelConfig({ apiKey: trimmed }));
    return configFile;
  }
  const parsed = assertZcodeModelConfigReadable(configFile);
  const updated = replaceApiKey(parsed, trimmed);
  writeZcodeModelConfigAtomic(configFile, updated);
  return configFile;
}

/**
 * Point the isolated config's main model at `model` (profile-wide default for
 * subsequent runs). Returns false when the config is missing/unparseable —
 * the run should proceed with the configured default rather than fail.
 */
export function applyZcodeModelOverride(homeDir: string, model: string): boolean {
  const trimmed = model.trim();
  if (!trimmed) return false;
  const configFile = zcodeModelConfigFile(homeDir);
  if (!existsSync(configFile)) return false;
  let parsed: Record<string, unknown>;
  try {
    parsed = assertZcodeModelConfigReadable(configFile);
  } catch {
    return false;
  }
  const current = parsed.model;
  const nextModel =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>), main: trimmed }
      : { main: trimmed };
  writeZcodeModelConfigAtomic(configFile, { ...parsed, model: nextModel });
  return true;
}

/**
 * Reasoning levels understood by the GLM models behind BigModel / z.ai,
 * reverse-engineered from zcode 0.16.3 (`Rx/j1/lU` + `xKo()` in zcode.cjs)
 * and verified live against the Anthropic-compatible endpoint:
 *   max     → output_config.effort=max,  thinking budget 32000 (builtin default)
 *   high    → output_config.effort=high, thinking budget 16000
 *   nothink → thinking disabled entirely (no effort field)
 */
export const ZCODE_REASONING_LEVELS = ['max', 'high', 'nothink'] as const;
export type ZcodeReasoningLevel = (typeof ZCODE_REASONING_LEVELS)[number];

const ZCODE_REASONING_PROVIDER_OPTIONS: Record<ZcodeReasoningLevel, unknown> = {
  max: { anthropic: { effort: 'max', thinking: { budgetTokens: 32000, type: 'enabled' } } },
  high: { anthropic: { effort: 'high', thinking: { budgetTokens: 16000, type: 'enabled' } } },
  nothink: { anthropic: { thinking: { type: 'disabled' } } },
};

/**
 * Reconcile the main model's `reasoning` block in the isolated config with
 * the requested level. `undefined` (or 'max', the builtin default) removes
 * the override so zcode's own defaults apply; any other level writes the full
 * levels + providerOptionsByLevel mapping — a partial block (e.g. only
 * defaultLevel) makes zcode send NO thinking/output_config at all, which is
 * silently wrong, so the mapping is always written in full.
 *
 * Returns false when the config is missing/unparseable or the main model
 * entry cannot be located; the run proceeds with zcode defaults.
 */
export function applyZcodeReasoningOverride(
  homeDir: string,
  level: ZcodeReasoningLevel | undefined,
): boolean {
  const configFile = zcodeModelConfigFile(homeDir);
  if (!existsSync(configFile)) return false;
  let parsed: Record<string, unknown>;
  try {
    parsed = assertZcodeModelConfigReadable(configFile);
  } catch {
    return false;
  }
  const entry = findMainModelEntry(parsed);
  if (!entry) return false;
  const current = entry.reasoning;
  const wantsDefault = level === undefined || level === 'max';
  // No-op when the config already matches intent (avoid a write per run).
  if (wantsDefault && current === undefined) return true;
  if (!wantsDefault && isReasoningBlockFor(current, level)) return true;
  if (wantsDefault) {
    delete entry.reasoning;
  } else {
    entry.reasoning = {
      enabled: true,
      levels: [...ZCODE_REASONING_LEVELS],
      defaultLevel: level,
      providerOptionsByLevel: ZCODE_REASONING_PROVIDER_OPTIONS,
    };
  }
  writeZcodeModelConfigAtomic(configFile, parsed);
  return true;
}

/** Locate the live model entry object for `model.main` ("provider/model"). */
function findMainModelEntry(
  parsed: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const main = (parsed.model as { main?: unknown } | undefined)?.main;
  if (typeof main !== 'string' || !main.includes('/')) return undefined;
  const slash = main.indexOf('/');
  const providerName = main.slice(0, slash);
  const modelId = main.slice(slash + 1);
  const provider = (parsed.provider as Record<string, unknown> | undefined)?.[providerName];
  if (!provider || typeof provider !== 'object') return undefined;
  const models = (provider as { models?: unknown }).models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return undefined;
  const entry = (models as Record<string, unknown>)[modelId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  return entry as Record<string, unknown>;
}

function isReasoningBlockFor(current: unknown, level: ZcodeReasoningLevel): boolean {
  if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
  return (current as { defaultLevel?: unknown }).defaultLevel === level;
}


function buildZcodeModelConfig(options: ZcodeModelConfigOptions): Record<string, unknown> {
  const baseURL = options.baseURL?.trim() || ZCODE_DEFAULT_BASE_URL;
  const mainModel = options.model?.trim() || ZCODE_DEFAULT_MODEL;
  // The provider id is the part before the first slash; custom models outside
  // the bigmodel provider require a hand-written config (documented in README).
  const liteModel = mainModel === ZCODE_DEFAULT_MODEL ? ZCODE_DEFAULT_LITE_MODEL : mainModel;
  return {
    provider: {
      bigmodel: {
        kind: 'anthropic',
        name: 'BigModel Coding Plan',
        options: {
          // Empty by default: fill via `lark-zcode-bridge profile login`,
          // ZCODE_API_KEY at profile creation, or by editing this file.
          apiKey: options.apiKey?.trim() ?? '',
          baseURL,
        },
        headers: {},
        models: {
          'glm-5.2': { name: 'GLM-5.2' },
          'glm-5-turbo': { name: 'GLM-5-Turbo' },
        },
      },
    },
    model: { main: mainModel, lite: liteModel },
    permission: {
      // The bridge always passes --mode explicitly per run; this default only
      // governs ad-hoc TUI usage inside the isolated home.
      mode: 'yolo',
      allowedTools: [],
      disallowedTools: [],
      autoApproveHighRisk: false,
      allowMediumRiskInAuto: false,
    },
    storage: { dir: '~/.zcode', sessionDbPath: '~/.zcode/cli/db/db.sqlite' },
    network: { timeout: 180000 },
  };
}

function assertZcodeModelConfigReadable(configFile: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch {
    throw new Error(
      'zcode model config is not valid JSON; fix or remove it: <profile zcode-home>/.zcode/cli/config.json',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('zcode model config must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function findApiKey(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const provider = (parsed as { provider?: unknown }).provider;
  if (!provider || typeof provider !== 'object') return undefined;
  for (const entry of Object.values(provider)) {
    if (!entry || typeof entry !== 'object') continue;
    const options = (entry as { options?: unknown }).options;
    if (!options || typeof options !== 'object') continue;
    const apiKey = (options as { apiKey?: unknown }).apiKey;
    if (typeof apiKey === 'string' && apiKey.trim()) return apiKey;
  }
  return undefined;
}

function replaceApiKey(
  parsed: Record<string, unknown>,
  apiKey: string,
): Record<string, unknown> {
  const provider = parsed.provider;
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    return buildZcodeModelConfig({ apiKey });
  }
  const nextProvider: Record<string, unknown> = { ...(provider as Record<string, unknown>) };
  // Replace the key on the provider referenced by model.main, falling back to
  // the first provider with an options object.
  const mainModel = (parsed.model as { main?: unknown } | undefined)?.main;
  const preferred =
    typeof mainModel === 'string' && mainModel.includes('/')
      ? mainModel.slice(0, mainModel.indexOf('/'))
      : undefined;
  const names = Object.keys(nextProvider);
  const target =
    (preferred && names.includes(preferred) ? preferred : undefined) ??
    names.find(
      (name) =>
        nextProvider[name] &&
        typeof nextProvider[name] === 'object' &&
        (nextProvider[name] as { options?: unknown }).options !== undefined,
    );
  if (!target) return buildZcodeModelConfig({ apiKey });
  const entry = { ...(nextProvider[target] as Record<string, unknown>) };
  const options =
    entry.options && typeof entry.options === 'object' && !Array.isArray(entry.options)
      ? { ...(entry.options as Record<string, unknown>) }
      : {};
  options.apiKey = apiKey;
  entry.options = options;
  nextProvider[target] = entry;
  return { ...parsed, provider: nextProvider };
}

function writeZcodeModelConfigAtomic(configFile: string, config: Record<string, unknown>): void {
  mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
  const tempPath = join(
    dirname(configFile),
    `.config.json.lark-zcode-bridge-${String(process.pid)}-${randomBytes(6).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, configFile);
    chmodSync(configFile, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}
