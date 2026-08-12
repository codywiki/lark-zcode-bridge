import { describe, expect, it } from 'vitest';
import { toolHeaderText } from '../../../src/card/tool-render.js';
import type { ToolEntry, ToolStatus } from '../../../src/card/run-state.js';

function header(name: string, input: unknown, status: ToolStatus = 'done'): string {
  return toolHeaderText({ id: 't1', name, input, status } satisfies ToolEntry);
}

describe('toolHeaderText', () => {
  it('marks only failures', () => {
    expect(header('Edit', { file_path: '/a.ts' })).toBe('**Edit** — /a.ts');
    expect(header('Edit', { file_path: '/a.ts' }, 'running')).toBe('**Edit** — /a.ts');
    expect(header('Edit', { file_path: '/a.ts' }, 'error')).toBe('⚠️ **Edit** — /a.ts');
  });

  it('falls back to a bare name when there is nothing to summarize', () => {
    expect(header('TaskList', undefined)).toBe('**TaskList**');
    expect(header('Bash', { command: '' })).toBe('**Bash**');
  });

  describe('paths', () => {
    it('collapses the home directory to ~', () => {
      const home = process.env.HOME;
      if (!home) return;
      expect(header('Read', { file_path: `${home}/notes.md` })).toBe('**Read** — ~/notes.md');
    });

    it('keeps the filename and its parent when a path is too long', () => {
      const summary = header('Edit', {
        file_path: '/Users/someone/very/deeply/nested/project/src/card/tool-render.ts',
      });
      expect(summary).toContain('card/tool-render.ts');
      expect(summary).toContain('…');
      // The identifying tail survives; the middle is what gets dropped.
      expect(summary).not.toContain('deeply/nested');
    });

    it('bounds a long path even with no separator to cut on', () => {
      const summary = header('Read', { file_path: `/${'x'.repeat(300)}` });
      expect(summary.length).toBeLessThan(80);
    });

    it('leaves a short path exactly as it is', () => {
      expect(header('Write', { file_path: 'src/a.ts' })).toBe('**Write** — src/a.ts');
    });
  });

  describe('shell commands', () => {
    it('drops leading cd navigation', () => {
      expect(header('Bash', { command: 'cd /repo && git commit -m x' }))
        .toBe('**Bash** — git commit -m x');
    });

    it('skips echo banners in favour of the real command', () => {
      expect(header('Bash', { command: 'echo "=== status ===" ; git status' }))
        .toBe('**Bash** — git status');
    });

    it('signals that a compound command ran more than it shows', () => {
      expect(header('Bash', { command: 'git add -A && git commit -m x' }))
        .toBe('**Bash** — git add -A …');
    });

    it('keeps a plain single command untouched', () => {
      expect(header('Bash', { command: 'npx vitest run' })).toBe('**Bash** — npx vitest run');
    });

    it('falls back to the original when every segment is noise', () => {
      expect(header('Bash', { command: 'cd /repo' })).toBe('**Bash** — cd /repo');
      expect(header('Bash', { command: 'echo hi' })).toBe('**Bash** — echo hi');
    });

    it('summarizes codex command_execution like Bash', () => {
      expect(header('command_execution', { command: 'cd /repo && npm install' }))
        .toBe('**command_execution** — npm install');
    });

    it('bounds a very long command', () => {
      const summary = header('Bash', { command: `grep -rn ${'pattern'.repeat(50)} src/` });
      expect(summary.length).toBeLessThan(110);
      expect(summary.endsWith('…')).toBe(true);
    });
  });
});
