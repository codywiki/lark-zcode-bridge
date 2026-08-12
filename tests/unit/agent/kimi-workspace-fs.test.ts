import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadTextFileRequest, WriteTextFileRequest } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { KimiWorkspaceFs } from '../../../src/agent/kimi/workspace-fs.js';

const cleanups: string[] = [];

describe('Kimi ACP workspace filesystem boundary', () => {
  afterEach(async () => {
    await Promise.all(
      cleanups.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('reads only valid UTF-8 regular files and implements ACP line windows', async () => {
    const fixture = await workspaceFixture();
    const file = join(fixture.workspace, 'source.ts');
    await writeFile(file, 'one\r\ntwo\nthree', 'utf8');
    const boundary = new KimiWorkspaceFs({ cwd: fixture.workspace });

    expect(await boundary.readTextFile(readRequest(file, 'session-new'))).toEqual({
      content: 'one\r\ntwo\nthree',
    });
    boundary.bindSessionId('session-new');
    expect(
      await boundary.readTextFile({
        ...readRequest(file, 'session-new'),
        line: 2,
        limit: 1,
      }),
    ).toEqual({ content: 'two\n' });
  });

  it('rejects relative, sibling, shared-prefix, and symlink escapes', async () => {
    const fixture = await workspaceFixture();
    const sibling = join(fixture.root, 'secret.txt');
    const sharedPrefix = join(fixture.root, 'workspace-evil', 'secret.txt');
    const escapeLink = join(fixture.workspace, 'apparently-safe.txt');
    await mkdir(join(fixture.root, 'workspace-evil'));
    await writeFile(sibling, 'outside', 'utf8');
    await writeFile(sharedPrefix, 'outside too', 'utf8');
    await symlink(sibling, escapeLink, 'file');
    const boundary = new KimiWorkspaceFs({ cwd: fixture.workspace });

    await expect(boundary.readTextFile(readRequest('../secret.txt'))).rejects.toThrow(
      /absolute path/i,
    );
    for (const path of [sibling, sharedPrefix, escapeLink]) {
      await expect(boundary.readTextFile(readRequest(path))).rejects.toThrow(/outside.*workspace/i);
    }
  });

  it('rejects sensitive names, VCS metadata, and explicitly denied runtime roots', async () => {
    const fixture = await workspaceFixture();
    const runtime = join(fixture.workspace, '.bridge-runtime');
    const sensitive = [
      join(fixture.workspace, '.env.production'),
      join(fixture.workspace, 'server.pem'),
      join(fixture.workspace, 'credentials.json'),
      join(fixture.workspace, '.git', 'config'),
      join(runtime, 'kimi-home', 'credentials', 'oauth.json'),
    ];
    for (const path of sensitive) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'secret', 'utf8');
    }
    const allowedTemplate = join(fixture.workspace, '.env.example');
    await writeFile(allowedTemplate, 'NAME=value\n', 'utf8');
    const boundary = new KimiWorkspaceFs({ cwd: fixture.workspace, deniedRoots: [runtime] });

    for (const path of sensitive.slice(0, -1)) {
      await expect(boundary.readTextFile(readRequest(path))).rejects.toThrow(/sensitive/i);
    }
    await expect(boundary.readTextFile(readRequest(sensitive.at(-1)!))).rejects.toThrow(
      /runtime or credential/i,
    );
    await expect(boundary.readTextFile(readRequest(allowedTemplate))).resolves.toEqual({
      content: 'NAME=value\n',
    });
  });

  it('rejects directories, oversized files, and malformed UTF-8', async () => {
    const fixture = await workspaceFixture();
    const oversized = join(fixture.workspace, 'oversized.txt');
    const malformed = join(fixture.workspace, 'malformed.txt');
    await writeFile(oversized, '12345', 'utf8');
    await writeFile(malformed, Buffer.from([0xc3, 0x28]));
    const boundary = new KimiWorkspaceFs({ cwd: fixture.workspace, maxBytes: 4 });

    await expect(boundary.readTextFile(readRequest(fixture.workspace))).rejects.toThrow(
      /regular files/i,
    );
    await expect(boundary.readTextFile(readRequest(oversized))).rejects.toThrow(/oversized/i);
    await expect(boundary.readTextFile(readRequest(malformed))).rejects.toThrow(/UTF-8/i);
  });

  it('claims the first new-session request, verifies the returned id, and isolates later requests', async () => {
    const fixture = await workspaceFixture();
    const file = join(fixture.workspace, 'source.ts');
    await writeFile(file, 'source', 'utf8');
    const boundary = new KimiWorkspaceFs({ cwd: fixture.workspace });

    await expect(boundary.readTextFile(readRequest(file, 'session-a'))).resolves.toEqual({
      content: 'source',
    });
    expect(() => boundary.bindSessionId('session-b')).toThrow(/different sessionId/i);
    boundary.bindSessionId('session-a');
    await expect(boundary.readTextFile(readRequest(file, 'session-b'))).rejects.toThrow(
      /wrong sessionId/i,
    );
  });

  it('defaults to read-only and redacts rejected write requests', async () => {
    const fixture = await workspaceFixture();
    const target = join(fixture.workspace, 'new', 'file.txt');
    const boundary = new KimiWorkspaceFs({ cwd: fixture.workspace });
    const request: WriteTextFileRequest = {
      sessionId: 'session-write',
      path: target,
      content: 'must not be written',
    };

    await expect(boundary.writeTextFile(request)).rejects.toThrow(/writes are disabled/i);
    expect(request).toEqual({
      sessionId: '[redacted]',
      path: '[redacted]',
      content: '[redacted]',
    });
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(target, '..'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates parent directories and writes UTF-8 text when explicitly writable', async () => {
    const fixture = await workspaceFixture();
    const target = join(fixture.workspace, 'new', 'nested', 'file.txt');
    const boundary = new KimiWorkspaceFs({ cwd: fixture.workspace, writable: true });

    await expect(
      boundary.writeTextFile({
        sessionId: 'session-write',
        path: target,
        content: '你好, Kimi\n',
      }),
    ).resolves.toEqual({});
    boundary.bindSessionId('session-write');
    await expect(readFile(target, 'utf8')).resolves.toBe('你好, Kimi\n');

    await expect(
      boundary.writeTextFile({
        sessionId: 'session-write',
        path: target,
        content: 'updated ✓',
      }),
    ).resolves.toEqual({});
    await expect(readFile(target, 'utf8')).resolves.toBe('updated ✓');
  });

  it('rejects writes outside the workspace, into denied roots, and to sensitive paths', async () => {
    const fixture = await workspaceFixture();
    const runtime = join(fixture.workspace, '.bridge-runtime');
    await mkdir(runtime);
    const outside = join(fixture.root, 'outside.txt');
    const denied = join(runtime, 'state.txt');
    const sensitive = join(fixture.workspace, '.git', 'config');
    const boundary = new KimiWorkspaceFs({
      cwd: fixture.workspace,
      deniedRoots: [runtime],
      writable: true,
    });
    boundary.bindSessionId('session-write');

    await expect(
      boundary.writeTextFile(writeRequest(outside)),
    ).rejects.toThrow(/outside.*workspace/i);
    await expect(boundary.writeTextFile(writeRequest(denied))).rejects.toThrow(
      /runtime or credential/i,
    );
    await expect(boundary.writeTextFile(writeRequest(sensitive))).rejects.toThrow(/sensitive/i);

    for (const path of [outside, denied, sensitive]) {
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(access(join(fixture.workspace, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows full-access ACP reads and writes outside cwd and denied roots', async () => {
    const fixture = await workspaceFixture();
    const runtime = join(fixture.root, 'profile-runtime');
    const outsideSecret = join(fixture.root, '.env');
    const runtimeFile = join(runtime, 'kimi-home', 'credentials.txt');
    const outsideWrite = join(fixture.root, 'outside', 'edited.txt');
    await mkdir(join(runtimeFile, '..'), { recursive: true });
    await writeFile(outsideSecret, 'TOKEN=visible-in-full\n', 'utf8');
    await writeFile(runtimeFile, 'profile state', 'utf8');
    const boundary = new KimiWorkspaceFs({
      cwd: fixture.workspace,
      deniedRoots: [runtime],
      writable: true,
      unrestricted: true,
    });

    await expect(boundary.readTextFile(readRequest(outsideSecret, 'session-full'))).resolves.toEqual({
      content: 'TOKEN=visible-in-full\n',
    });
    boundary.bindSessionId('session-full');
    await expect(
      boundary.writeTextFile({
        sessionId: 'session-full',
        path: outsideWrite,
        content: 'edited outside cwd',
      }),
    ).resolves.toEqual({});
    await expect(
      boundary.writeTextFile({
        sessionId: 'session-full',
        path: runtimeFile,
        content: 'updated profile state',
      }),
    ).resolves.toEqual({});
    await expect(readFile(outsideWrite, 'utf8')).resolves.toBe('edited outside cwd');
    await expect(readFile(runtimeFile, 'utf8')).resolves.toBe('updated profile state');
  });

  it('rejects parent symlink escapes and never follows a final symlink', async () => {
    const fixture = await workspaceFixture();
    const outsideDirectory = join(fixture.root, 'outside');
    const outsideFile = join(outsideDirectory, 'existing.txt');
    const parentLink = join(fixture.workspace, 'linked-directory');
    const finalLink = join(fixture.workspace, 'linked-file.txt');
    await mkdir(outsideDirectory);
    await writeFile(outsideFile, 'unchanged', 'utf8');
    await symlink(outsideDirectory, parentLink, 'dir');
    await symlink(outsideFile, finalLink, 'file');
    const boundary = new KimiWorkspaceFs({ cwd: fixture.workspace, writable: true });

    await expect(
      boundary.writeTextFile(
        writeRequest(join(parentLink, 'created.txt'), 'session-symlink'),
      ),
    ).rejects.toThrow(/outside.*workspace/i);
    await expect(
      boundary.writeTextFile(writeRequest(finalLink, 'session-symlink')),
    ).rejects.toThrow(/symlink/i);

    await expect(access(join(outsideDirectory, 'created.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('unchanged');
  });

  it('isolates writable sessions and redacts rejected requests', async () => {
    const fixture = await workspaceFixture();
    const target = join(fixture.workspace, 'wrong-session.txt');
    const boundary = new KimiWorkspaceFs({ cwd: fixture.workspace, writable: true });
    boundary.bindSessionId('session-a');
    const request = writeRequest(target, 'session-b');

    await expect(boundary.writeTextFile(request)).rejects.toThrow(/wrong sessionId/i);
    expect(request).toEqual({
      sessionId: '[redacted]',
      path: '[redacted]',
      content: '[redacted]',
    });
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function readRequest(path: string, sessionId = 'session-test'): ReadTextFileRequest {
  return { sessionId, path };
}

function writeRequest(path: string, sessionId = 'session-write'): WriteTextFileRequest {
  return { sessionId, path, content: 'must not escape' };
}

async function workspaceFixture(): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-workspace-fs-'));
  cleanups.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  return { root, workspace };
}
