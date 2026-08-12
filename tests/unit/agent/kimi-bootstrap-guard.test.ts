import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertKimiBootstrapPathsSafe } from '../../../src/agent/kimi/bootstrap-guard.js';

const cleanups: string[] = [];

describe('Kimi local bootstrap guard', () => {
  afterEach(async () => {
    await Promise.all(
      cleanups.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('accepts a workspace with no local context or extension files', async () => {
    const fixture = await guardFixture();
    expect(() => assertKimiBootstrapPathsSafe(fixture)).not.toThrow();
  });

  it('rejects every direct local config and instruction surface', async () => {
    const candidates = [
      ['workspace', 'AGENTS.md'],
      ['workspace', '.kimi-code', 'AGENTS.md'],
      ['workspace', '.kimi-code', 'local.toml'],
      ['workspace', '.mcp.json'],
      ['workspace', '.kimi-code', 'mcp.json'],
      ['kimiHome', 'AGENTS.md'],
      ['kimiHome', 'mcp.json'],
      ['kimiHome', 'plugins', 'installed.json'],
    ] as const;

    for (const [rootName, ...parts] of candidates) {
      const fixture = await guardFixture();
      const root = fixture[rootName];
      const path = join(root, ...parts);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'untrusted', 'utf8');
      expect(() => assertKimiBootstrapPathsSafe(fixture), path).toThrow(/bootstrap file/i);
    }
  });

  it('rejects project and profile skill roots even when the Skill tool is disabled', async () => {
    const candidates = [
      ['workspace', '.kimi-code', 'skills'],
      ['workspace', '.agents', 'skills'],
      ['kimiHome', 'skills'],
    ] as const;

    for (const [rootName, ...parts] of candidates) {
      const fixture = await guardFixture();
      await mkdir(join(fixture[rootName], ...parts), { recursive: true });
      expect(() => assertKimiBootstrapPathsSafe(fixture)).toThrow(/extension path/i);
    }
  });

  it('rejects an AGENTS.md symlink to profile credentials before spawn', async () => {
    const fixture = await guardFixture();
    const credential = join(fixture.kimiHome, 'credentials', 'oauth.json');
    await mkdir(join(credential, '..'), { recursive: true });
    await writeFile(credential, 'oauth-secret', 'utf8');
    await symlink(credential, join(fixture.workspace, 'AGENTS.md'), 'file');

    expect(() => assertKimiBootstrapPathsSafe(fixture)).toThrow(/workspace\/AGENTS\.md/i);
  });

  it('allows normal OS Home agent entries but rejects symlinked bootstrap paths', async () => {
    const fixture = await guardFixture();
    await mkdir(join(fixture.osHome, '.agents', 'skills'), { recursive: true });
    await writeFile(join(fixture.osHome, '.agents', 'AGENTS.md'), 'normal global context', 'utf8');
    expect(() => assertKimiBootstrapPathsSafe(fixture)).not.toThrow();

    await rm(join(fixture.osHome, '.agents', 'AGENTS.md'));
    const credential = join(fixture.kimiHome, 'credentials', 'oauth.json');
    await mkdir(join(credential, '..'), { recursive: true });
    await writeFile(credential, 'oauth-secret', 'utf8');
    await symlink(credential, join(fixture.osHome, '.agents', 'AGENTS.md'), 'file');
    expect(() => assertKimiBootstrapPathsSafe(fixture)).toThrow(
      /symlinked OS Home bootstrap path.*AGENTS\.md/i,
    );
  });

  it('rejects an OS Home skills symlink into the Kimi profile', async () => {
    const fixture = await guardFixture();
    const credentialDir = join(fixture.kimiHome, 'credentials');
    await mkdir(join(fixture.osHome, '.agents'), { recursive: true });
    await mkdir(credentialDir, { recursive: true });
    await symlink(credentialDir, join(fixture.osHome, '.agents', 'skills'), 'dir');
    expect(() => assertKimiBootstrapPathsSafe(fixture)).toThrow(
      /symlinked OS Home bootstrap path.*skills/i,
    );
  });

  it('checks AGENTS.md and MCP config at an ancestor Git project root', async () => {
    const fixture = await guardFixture();
    const nested = join(fixture.workspace, 'packages', 'app');
    await mkdir(join(fixture.workspace, '.git'));
    await mkdir(nested, { recursive: true });
    await writeFile(join(fixture.workspace, 'AGENTS.md'), 'root instructions', 'utf8');

    expect(() => assertKimiBootstrapPathsSafe({ ...fixture, cwd: nested })).toThrow(
      /workspace\/AGENTS\.md/i,
    );
  });
});

async function guardFixture(): Promise<{
  cwd: string;
  workspace: string;
  kimiHome: string;
  osHome: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-bootstrap-guard-'));
  cleanups.push(root);
  const workspace = join(root, 'workspace');
  const kimiHome = join(root, 'profile', 'kimi-home');
  const osHome = join(root, 'os-home');
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(kimiHome, { recursive: true }),
    mkdir(osHome, { recursive: true }),
  ]);
  return { cwd: workspace, workspace, kimiHome, osHome };
}
