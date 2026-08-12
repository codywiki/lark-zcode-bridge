import { describe, expect, it } from 'vitest';
import { isSignificantTool } from '../../../src/card/tool-significance.js';
import type { ToolEntry, ToolStatus } from '../../../src/card/run-state.js';

function tool(
  name: string,
  input: unknown = undefined,
  status: ToolStatus = 'done',
): ToolEntry {
  return { id: 't1', name, input, status };
}

function shell(command: string, status: ToolStatus = 'done'): ToolEntry {
  return tool('Bash', { command }, status);
}

describe('isSignificantTool', () => {
  it('hides read-only inspection tools', () => {
    for (const name of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TaskList']) {
      expect(isSignificantTool(tool(name)), name).toBe(false);
    }
  });

  it('shows tools that change state or spawn work', () => {
    for (const name of ['Edit', 'Write', 'NotebookEdit', 'Task', 'Agent', 'Workflow']) {
      expect(isSignificantTool(tool(name)), name).toBe(true);
    }
  });

  it('shows any failed tool, including ones normally hidden', () => {
    expect(isSignificantTool(tool('Read', { file_path: '/missing' }, 'error'))).toBe(true);
    expect(isSignificantTool(shell('ls', 'error'))).toBe(true);
  });

  it('treats a running read as noise, so live cards do not churn', () => {
    expect(isSignificantTool(tool('Read', { file_path: '/a.ts' }, 'running'))).toBe(false);
    expect(isSignificantTool(tool('Edit', { file_path: '/a.ts' }, 'running'))).toBe(true);
  });

  describe('shell commands', () => {
    it('hides inspection', () => {
      for (const cmd of ['ls -la', 'grep -rn foo src/', 'cat pkg.json', 'ps aux', 'echo hi']) {
        expect(isSignificantTool(shell(cmd)), cmd).toBe(false);
      }
    });

    it('shows mutation', () => {
      for (const cmd of ['git commit -m x', 'npm install', 'rm -rf dist', 'mkdir -p a/b']) {
        expect(isSignificantTool(shell(cmd)), cmd).toBe(true);
      }
    });

    it('splits git by subcommand', () => {
      expect(isSignificantTool(shell('git status'))).toBe(false);
      expect(isSignificantTool(shell('git diff HEAD'))).toBe(false);
      expect(isSignificantTool(shell('git push origin main'))).toBe(true);
      // A subcommand we do not classify should not be assumed read-only.
      expect(isSignificantTool(shell('git rebase main'))).toBe(true);
    });

    it('finds mutations hidden later in a compound command', () => {
      expect(isSignificantTool(shell('cd /repo && git commit -m x'))).toBe(true);
      expect(isSignificantTool(shell('ls; rm -rf tmp'))).toBe(true);
      expect(isSignificantTool(shell('cat a | tee b'))).toBe(true);
      expect(isSignificantTool(shell('cd /repo && ls -la'))).toBe(false);
    });

    it('treats output redirection as mutation whatever the program is', () => {
      expect(isSignificantTool(shell('echo hi > /tmp//out'))).toBe(true);
      expect(isSignificantTool(shell('ls >> log.txt'))).toBe(true);
      // Comparison operators and fd-dup are not writes.
      expect(isSignificantTool(shell('ls 2>&1'))).toBe(false);
      expect(isSignificantTool(shell('test 1 -gt 0'))).toBe(false);
    });

    it('shows test and build runs — the checkpoint of a run', () => {
      for (const cmd of ['npm test', 'npx vitest run', 'pnpm build', 'npx tsc --noEmit', 'pytest -q']) {
        expect(isSignificantTool(shell(cmd)), cmd).toBe(true);
      }
    });

    it('judges the wrapped program, not the runner', () => {
      // Same action, same verdict, however it is invoked.
      expect(isSignificantTool(shell('vitest run'))).toBe(true);
      expect(isSignificantTool(shell('npx vitest run'))).toBe(true);
      expect(isSignificantTool(shell('cd /repo && npx vitest run tests/'))).toBe(true);
      // A wrapper around a lookup is still a lookup.
      expect(isSignificantTool(shell('npx tsx -e "console.log(1)"'))).toBe(false);
      // A bare wrapper says nothing either way.
      expect(isSignificantTool(shell('npx'))).toBe(false);
    });

    it('looks past env assignments, sudo, and absolute paths', () => {
      expect(isSignificantTool(shell('FOO=1 git push'))).toBe(true);
      expect(isSignificantTool(shell('sudo rm -rf /tmp/x'))).toBe(true);
      expect(isSignificantTool(shell('/usr/bin/git commit -m x'))).toBe(true);
      expect(isSignificantTool(shell('FOO=1 ls'))).toBe(false);
    });

    it('classifies codex command_execution the same way as Bash', () => {
      expect(isSignificantTool(tool('command_execution', { command: 'ls' }))).toBe(false);
      expect(isSignificantTool(tool('command_execution', { command: 'git commit -m x' }))).toBe(true);
    });

    it('is not fooled by a missing or malformed input', () => {
      expect(isSignificantTool(tool('Bash'))).toBe(false);
      expect(isSignificantTool(tool('Bash', { command: '' }))).toBe(false);
      expect(isSignificantTool(tool('Bash', { command: 42 }))).toBe(false);
      expect(isSignificantTool(tool('Bash', 'ls'))).toBe(false);
    });
  });
});
