import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildKimiLaunch,
  KIMI_SAFE_LOGIN_SHELL,
  seatbeltStringLiteral,
  type KimiLaunchInput,
  type KimiSeatbeltTestOverrides,
} from '../../../src/agent/kimi/seatbelt.js';
import { spawnProcessSync } from '../../../src/platform/spawn.js';

const cleanups: string[] = [];

describe('Kimi macOS Seatbelt policy', () => {
  afterEach(async () => {
    await Promise.all(
      cleanups.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('requires an explicit test switch for a direct non-Darwin spawn', () => {
    const input = {
      binary: 'kimi',
      args: ['acp'],
      cwd: '/does/not/need/to/exist',
      env: {},
      profileStateDir: '/also/missing',
      imageOutputDir: '/also/missing/images',
    };
    expect(() =>
      buildKimiLaunch({
        ...input,
        testOverrides: { platform: 'linux' },
      }),
    ).toThrow(/refusing unsandboxed run on linux/);
    expect(
      buildKimiLaunch({
        ...input,
        testOverrides: { platform: 'linux', allowUnsandboxed: true },
      }),
    ).toEqual({ command: 'kimi', args: ['acp'] });
  });

  it('builds sandbox-exec argv with canonical read, write, and exec exceptions', async () => {
    const fixture = await seatbeltFixture('spawn-profile-');
    const cwdLink = join(fixture.root, 'cwd-link');
    await symlink(fixture.cwd, cwdLink, 'dir');
    const launch = buildKimiLaunch(
      fixtureInput(fixture, {
        cwd: cwdLink,
        binary: fixture.kimi,
        args: ['acp'],
      }),
    );

    expect(launch.command).toBe(await realpath(fixture.sandboxExec));
    expect(launch.args.slice(0, 2)).toEqual(['-p', launch.seatbeltProfile]);
    expect(launch.args.slice(2)).toEqual([await realpath(fixture.kimi), 'acp']);
    const profile = launch.seatbeltProfile!;
    expect(profile).toContain('(allow default)');
    expect(profile).toContain(`(deny file-read* (subpath ${seatbeltStringLiteral(await realpath(fixture.home))}))`);
    expect(profile).toContain(
      `(deny file-read-data (subpath ${seatbeltStringLiteral(await realpath(fixture.cwd))}))`,
    );
    expect(profile).toContain(
      `(allow file-read-metadata (subpath ${seatbeltStringLiteral(await realpath(fixture.cwd))})`,
    );
    expect(profile).toContain(
      `(allow file-read-metadata (literal ${seatbeltStringLiteral(await realpath(fixture.home))})`,
    );
    expect(profile).toContain(
      `(allow file-read* (subpath ${seatbeltStringLiteral(dirname(await realpath(fixture.kimi)))})`,
    );
    expect(profile).not.toContain(
      `(allow file-read* (subpath ${seatbeltStringLiteral(await realpath(fixture.cwd))})`,
    );
    expect(profile).not.toContain(seatbeltStringLiteral(cwdLink));
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain(
      `(allow file-write* (subpath ${seatbeltStringLiteral(await realpath(fixture.kimiHome))})`,
    );
    expect(profile).not.toContain(
      `(allow file-write* (subpath ${seatbeltStringLiteral(await realpath(fixture.cwd))})`,
    );
    expect(profile).toContain('(deny process-exec*)');
    expect(profile).toContain(`(literal ${seatbeltStringLiteral(await realpath(fixture.kimi))})`);
    expect(profile).toContain(`(literal ${seatbeltStringLiteral(KIMI_SAFE_LOGIN_SHELL)})`);
    expect(profile).not.toContain('/usr/bin/git');
    expect(profile).not.toContain('/rg"');
    expect(profile).not.toContain('/bin/sh');
    for (const path of [
      join(await realpath(fixture.cwd), '.mcp.json'),
      join(await realpath(fixture.cwd), '.kimi-code', 'local.toml'),
      join(await realpath(fixture.cwd), '.kimi-code', 'mcp.json'),
    ]) {
      expect(profile).toContain(`(literal ${seatbeltStringLiteral(path)})`);
    }
  });

  it('uses a cwd-only workspace Seatbelt for Shell, reads, and edits', async () => {
    const fixture = await seatbeltFixture('workspace-profile-');
    const otherAuthorizedRoot = join(fixture.root, 'other-authorized-root');
    await mkdir(otherAuthorizedRoot);
    const launch = buildKimiLaunch(
      fixtureInput(fixture, {
        accessMode: 'workspace',
        env: {
          ...process.env,
          KIMI_CODE_HOME: fixture.kimiHome,
          SHELL: '/bin/sh',
        },
      }),
    );

    const profile = launch.seatbeltProfile!;
    expect(profile.split('\n')).toContain('(deny file-read*)');
    expect(profile.split('\n')).toContain('(import "system.sb")');
    expect(profile).toContain(
      `(subpath ${seatbeltStringLiteral(await realpath(fixture.cwd))})`,
    );
    expect(profile).not.toContain(
      seatbeltStringLiteral(await realpath(otherAuthorizedRoot)),
    );
    expect(
      profile.split(seatbeltStringLiteral(await realpath(fixture.cwd))).length - 1,
    ).toBe(3);
    expect(profile).not.toContain('(deny process-exec*)');
    expect(profile).toContain('(deny file-write*)');
  });

  it('runs full access directly without a Seatbelt wrapper', async () => {
    const fixture = await seatbeltFixture('full-profile-');
    const launch = buildKimiLaunch(
      fixtureInput(fixture, {
        accessMode: 'full',
        testOverrides: { platform: 'linux' },
      }),
    );

    expect(launch).toEqual({
      command: await realpath(fixture.kimi),
      args: ['acp'],
    });
  });

  it('escapes quotes and backslashes instead of allowing policy injection', async () => {
    const fixture = await seatbeltFixture('escape-profile-');
    const escapedCwd = join(fixture.home, 'work") (allow file-write*) ;\\repo');
    await mkdir(escapedCwd, { recursive: true });

    const launch = buildKimiLaunch(fixtureInput(fixture, { cwd: escapedCwd }));
    const canonical = await realpath(escapedCwd);
    expect(launch.seatbeltProfile).toContain(
      `(subpath ${seatbeltStringLiteral(canonical)})`,
    );
    expect(launch.seatbeltProfile).not.toContain(`(subpath "${canonical}")`);
    expect(() => seatbeltStringLiteral('/tmp/line\nbreak')).toThrow(/control-character/);
  });

  it('fails closed when sandbox-exec is missing or an exception exposes all of Home', async () => {
    const fixture = await seatbeltFixture('fail-closed-');
    expect(() =>
      buildKimiLaunch(
        fixtureInput(fixture, {
          testOverrides: {
            ...fixture.overrides,
            sandboxExecPath: join(fixture.root, 'missing-sandbox-exec'),
          },
        }),
      ),
    ).toThrow(/could not resolve sandbox-exec/);

    expect(() =>
      buildKimiLaunch(fixtureInput(fixture, { cwd: fixture.home })),
    ).toThrow(/would expose the OS user Home/);

    expect(() =>
      buildKimiLaunch(
        fixtureInput(fixture, {
          env: { ...process.env, KIMI_CODE_HOME: fixture.kimiHome, SHELL: '/bin/sh' },
        }),
      ),
    ).toThrow(/fixed no-op login shell/);
  });

  it('fails closed when the Kimi install directory overlaps the workspace', async () => {
    const fixture = await seatbeltFixture('binary-workspace-overlap-');
    const binaryInsideWorkspace = await executable(join(fixture.cwd, 'bin', 'kimi'));
    expect(() =>
      buildKimiLaunch(fixtureInput(fixture, { binary: binaryInsideWorkspace })),
    ).toThrow(/overlapping Kimi binary directory and Kimi cwd/i);

    const workspaceInsideBinaryDir = join(dirname(fixture.kimi), 'nested-workspace');
    await mkdir(workspaceInsideBinaryDir, { recursive: true });
    expect(() =>
      buildKimiLaunch(fixtureInput(fixture, { cwd: workspaceInsideBinaryDir })),
    ).toThrow(/overlapping Kimi binary directory and Kimi cwd/i);
  });

  it('fails closed when KIMI_CODE_HOME and the workspace overlap', async () => {
    const fixture = await seatbeltFixture('kimi-home-workspace-overlap-');
    expect(() =>
      buildKimiLaunch(fixtureInput(fixture, { cwd: fixture.kimiHome })),
    ).toThrow(/overlapping KIMI_CODE_HOME and Kimi cwd/i);

    const kimiHomeInsideWorkspace = join(fixture.cwd, '.profile-kimi-home');
    await mkdir(kimiHomeInsideWorkspace, { recursive: true });
    expect(() =>
      buildKimiLaunch(
        fixtureInput(fixture, {
          env: {
            ...process.env,
            KIMI_CODE_HOME: kimiHomeInsideWorkspace,
            SHELL: KIMI_SAFE_LOGIN_SHELL,
          },
        }),
      ),
    ).toThrow(/overlapping KIMI_CODE_HOME and Kimi cwd/i);
  });

  it('fails closed when workspace bootstrap config exists or is symlinked', async () => {
    const candidates = [
      ['.mcp.json'],
      ['.kimi-code', 'local.toml'],
      ['.kimi-code', 'mcp.json'],
    ] as const;
    for (const parts of candidates) {
      const fixture = await seatbeltFixture('workspace-bootstrap-config-');
      const path = join(fixture.cwd, ...parts);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'untrusted', 'utf8');
      expect(() => buildKimiLaunch(fixtureInput(fixture))).toThrow(/bootstrap configuration file/i);
    }

    const fixture = await seatbeltFixture('workspace-bootstrap-symlink-');
    const target = join(fixture.kimiHome, 'credentials', 'oauth.json');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'credential', 'utf8');
    await symlink(target, join(fixture.cwd, '.mcp.json'), 'file');
    expect(() => buildKimiLaunch(fixtureInput(fixture))).toThrow(/symlinked bootstrap path/i);
  });

  it('fails closed for a Git workspace before allowing metadata probes', async () => {
    const fixture = await seatbeltFixture('git-workspace-');
    await mkdir(join(fixture.cwd, '.git'));
    expect(() => buildKimiLaunch(fixtureInput(fixture))).toThrow(/refuses Git workspaces/i);
  });

  it('uses a distinct trusted read policy for profile config validation', async () => {
    const fixture = await seatbeltFixture('config-validation-policy-');
    const launch = buildKimiLaunch(
      fixtureInput(fixture, {
        cwd: fixture.kimiHome,
        args: ['doctor', 'config', join(fixture.kimiHome, 'config.toml')],
        purpose: 'config-validation',
      }),
    );
    const profile = launch.seatbeltProfile!;
    expect(profile.split('\n')).not.toContain('(deny file-read*)');
    expect(profile.split('\n')).not.toContain('(import "system.sb")');
    expect(profile).toContain(
      `(subpath ${seatbeltStringLiteral(await realpath(fixture.kimiHome))})`,
    );
    expect(profile).not.toContain(
      `(deny file-read-data (subpath ${seatbeltStringLiteral(await realpath(fixture.kimiHome))})`,
    );
  });

  it.runIf(process.platform === 'darwin')(
    'enforces read and write boundaries with the system sandbox-exec',
    async () => {
      const fixture = await seatbeltFixture('enforcement-files-', {
        sandboxExec: '/usr/bin/sandbox-exec',
      });
      const allowedRead = join(fixture.cwd, 'allowed.txt');
      const deniedRead = join(fixture.home, 'private', 'secret.txt');
      await mkdir(join(fixture.home, 'private'), { recursive: true });
      await Promise.all([
        writeFile(allowedRead, 'allowed', 'utf8'),
        writeFile(deniedRead, 'secret', 'utf8'),
      ]);

      const deniedCat = buildKimiLaunch(
        fixtureInput(fixture, { binary: '/bin/cat', args: [allowedRead] }),
      );
      expect(run(deniedCat).status).not.toBe(0);
      const allowedStat = buildKimiLaunch(
        fixtureInput(fixture, { binary: '/usr/bin/stat', args: [allowedRead] }),
      );
      expect(run(allowedStat).status).toBe(0);
      const deniedList = buildKimiLaunch(
        fixtureInput(fixture, { binary: '/bin/ls', args: [fixture.cwd] }),
      );
      expect(run(deniedList).status).not.toBe(0);
      const deniedStat = buildKimiLaunch(
        fixtureInput(fixture, { binary: '/usr/bin/stat', args: [deniedRead] }),
      );
      expect(run(deniedStat).status).not.toBe(0);
      const allowedHomeMetadata = buildKimiLaunch(
        fixtureInput(fixture, { binary: '/usr/bin/stat', args: [fixture.home] }),
      );
      expect(run(allowedHomeMetadata).status).toBe(0);
      const deniedHomeList = buildKimiLaunch(
        fixtureInput(fixture, { binary: '/bin/ls', args: [fixture.home] }),
      );
      expect(run(deniedHomeList).status).not.toBe(0);

      const outsideCwd = join(fixture.root, 'outside-home-workspace');
      const outsideRead = join(outsideCwd, 'source.txt');
      await mkdir(outsideCwd, { recursive: true });
      await writeFile(outsideRead, 'outside-home-source', 'utf8');
      const outsideInput = fixtureInput(fixture, { cwd: outsideCwd });
      expect(
        run(buildKimiLaunch({ ...outsideInput, binary: '/bin/cat', args: [outsideRead] }))
          .status,
      ).not.toBe(0);
      expect(
        run(buildKimiLaunch({ ...outsideInput, binary: '/usr/bin/stat', args: [outsideRead] }))
          .status,
      ).toBe(0);
      expect(
        run(buildKimiLaunch({ ...outsideInput, binary: '/bin/ls', args: [outsideCwd] })).status,
      ).not.toBe(0);

      const allowedWrite = join(fixture.kimiHome, 'state.json');
      const deniedWrite = join(fixture.cwd, 'source-change.txt');
      expect(
        run(
          buildKimiLaunch(
            fixtureInput(fixture, { binary: '/usr/bin/touch', args: [allowedWrite] }),
          ),
        ).status,
      ).toBe(0);
      await expect(access(allowedWrite)).resolves.toBeUndefined();
      expect(
        run(
          buildKimiLaunch(
            fixtureInput(fixture, { binary: '/usr/bin/touch', args: [deniedWrite] }),
          ),
        ).status,
      ).not.toBe(0);
      await expect(access(deniedWrite)).rejects.toThrow();
    },
  );

  it.runIf(process.platform === 'darwin')(
    'enforces workspace reads and writes against only the active canonical cwd',
    async () => {
      const fixture = await seatbeltFixture('enforcement-workspace-', {
        sandboxExec: '/usr/bin/sandbox-exec',
      });
      const activeFile = join(fixture.cwd, 'active.txt');
      const otherAuthorizedRoot = join(fixture.root, 'other-authorized-root');
      const otherFile = join(otherAuthorizedRoot, 'other.txt');
      const escapeLink = join(fixture.cwd, 'escape-link.txt');
      await mkdir(otherAuthorizedRoot);
      await Promise.all([
        writeFile(activeFile, 'active', 'utf8'),
        writeFile(otherFile, 'other', 'utf8'),
      ]);
      await symlink(otherFile, escapeLink, 'file');

      const workspaceInput = (binary: string, args: string[]) =>
        fixtureInput(fixture, {
          accessMode: 'workspace',
          binary,
          args,
          env: {
            ...process.env,
            KIMI_CODE_HOME: fixture.kimiHome,
            SHELL: '/bin/sh',
          },
        });

      expect(run(buildKimiLaunch(workspaceInput('/bin/cat', [activeFile]))).status).toBe(0);
      expect(run(buildKimiLaunch(workspaceInput('/bin/cat', [otherFile]))).status).not.toBe(0);
      expect(run(buildKimiLaunch(workspaceInput('/bin/cat', [escapeLink]))).status).not.toBe(0);
      expect(
        run(buildKimiLaunch(workspaceInput('/usr/bin/stat', ['/etc/hosts']))).status,
      ).not.toBe(0);

      const activeWrite = join(fixture.cwd, 'active-write.txt');
      const otherWrite = join(otherAuthorizedRoot, 'other-write.txt');
      expect(
        run(buildKimiLaunch(workspaceInput('/usr/bin/touch', [activeWrite]))).status,
      ).toBe(0);
      expect(
        run(buildKimiLaunch(workspaceInput('/usr/bin/touch', [otherWrite]))).status,
      ).not.toBe(0);
      await expect(access(activeWrite)).resolves.toBeUndefined();
      await expect(access(otherWrite)).rejects.toThrow();
    },
  );

  it.runIf(process.platform === 'darwin')(
    'rejects git, rg, and every other child exec',
    async () => {
      const fixture = await seatbeltFixture('enforcement-exec-', {
        sandboxExec: '/usr/bin/sandbox-exec',
      });
      const childEnv = {
        ...process.env,
        KIMI_CODE_HOME: fixture.kimiHome,
        SHELL: KIMI_SAFE_LOGIN_SHELL,
        DEVELOPER_DIR: join(fixture.root, 'attacker-controlled-toolchain'),
      };
      const controller = '/usr/bin/env';
      const git = run(
        buildKimiLaunch(
          fixtureInput(fixture, {
            binary: controller,
            args: ['/usr/bin/git', '--version'],
            env: childEnv,
          }),
        ),
      );
      expect(git.status).not.toBe(0);

      const rgPath = await executableOnPath('rg');
      if (rgPath !== undefined) {
        const rg = run(
          buildKimiLaunch(
            fixtureInput(fixture, {
              binary: controller,
              args: [rgPath, '--version'],
              env: childEnv,
            }),
          ),
        );
        expect(rg.status).not.toBe(0);
      }

      const forbidden = run(
        buildKimiLaunch(
          fixtureInput(fixture, {
            binary: controller,
            args: ['/bin/bash', '-c', '/usr/bin/true'],
          }),
        ),
      );
      expect(forbidden.status).not.toBe(0);
      expect(forbidden.stderr).toMatch(/Operation not permitted/i);

      const noOpProbe = run(
        buildKimiLaunch(
          fixtureInput(fixture, {
            binary: controller,
            args: [KIMI_SAFE_LOGIN_SHELL],
          }),
        ),
      );
      expect(noOpProbe.status).toBe(1);
    },
  );
});

interface SeatbeltFixture {
  root: string;
  home: string;
  cwd: string;
  profile: string;
  kimiHome: string;
  images: string;
  sandboxExec: string;
  kimi: string;
  overrides: KimiSeatbeltTestOverrides;
}

async function seatbeltFixture(
  prefix: string,
  options: {
    sandboxExec?: string;
  } = {},
): Promise<SeatbeltFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(root);
  const home = join(root, 'home');
  const cwd = join(home, 'workspace');
  const profile = join(home, 'profile');
  const kimiHome = join(profile, 'kimi-home');
  const images = join(profile, 'images');
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(kimiHome, { recursive: true }),
    mkdir(images, { recursive: true }),
  ]);
  const sandboxExec = options.sandboxExec ?? (await executable(join(root, 'sandbox-exec')));
  const kimi = await executable(join(home, 'bin', 'kimi'));
  const overrides: KimiSeatbeltTestOverrides = {
    platform: 'darwin',
    sandboxExecPath: sandboxExec,
    osHomeDir: home,
  };
  return { root, home, cwd, profile, kimiHome, images, sandboxExec, kimi, overrides };
}

function fixtureInput(
  fixture: SeatbeltFixture,
  options: Partial<KimiLaunchInput> = {},
): KimiLaunchInput {
  const { env: optionEnv, ...rest } = options;
  return {
    binary: fixture.kimi,
    args: ['acp'],
    cwd: fixture.cwd,
    env: {
      ...process.env,
      KIMI_CODE_HOME: fixture.kimiHome,
      SHELL: KIMI_SAFE_LOGIN_SHELL,
      ...optionEnv,
    },
    profileStateDir: fixture.profile,
    imageOutputDir: fixture.images,
    testOverrides: fixture.overrides,
    ...rest,
  };
}

async function executable(path: string): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(path, 0o755);
  return path;
}

async function executableOnPath(name: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    try {
      const path = join(dir, name);
      await access(path);
      return await realpath(path);
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

function run(launch: ReturnType<typeof buildKimiLaunch>): {
  status: number | null;
  stderr: string;
} {
  const result = spawnProcessSync(launch.command, launch.args, { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr?.toString() ?? '' };
}
