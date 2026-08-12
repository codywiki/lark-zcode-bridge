import type { ToolEntry } from './run-state';

/**
 * Whether a tool call earns a line in the chat transcript.
 *
 * Feishu renders one run as a single card with a hard length cap. A run that
 * pokes around a repo emits dozens of tool calls, and one line each pushes the
 * actual answer past the cut — the user loses the conclusion to make room for
 * the search that found it.
 *
 * The split is by what a line would tell the user, not by cost: reads,
 * searches and lookups are how the agent *looked around*, and narrating them
 * adds nothing they act on. Calls that change something, spawn work, or fail
 * are events worth a line.
 */
const STATE_CHANGING_TOOLS = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Task',
  'Agent',
  'Workflow',
  'Skill',
  'SendMessage',
  'CronCreate',
  'CronDelete',
  'EnterWorktree',
  'ExitWorktree',
]);

/** Tools whose significance depends on the shell command they were handed. */
const SHELL_TOOLS = new Set(['Bash', 'command_execution', 'shell', 'local_shell']);

/**
 * Shell programs that change state. A `git commit` or an `npm install` is a
 * real event in the run; `ls` and `grep` are the agent reading the room.
 *
 * Deliberately a small allowlist rather than a read-only denylist: shell usage
 * is dominated by inspection, much of it commands we cannot enumerate, so an
 * unrecognized program is far more likely to be a lookup than a mutation.
 * Treating the unknown case as noise is what keeps the card short. A mutation
 * we miss here still reaches the user through the agent's own narration, and
 * through the error branch of {@link isSignificantTool} if it fails.
 */
const MUTATING_SHELL_PROGRAMS = new Set([
  'apply_patch',
  'cp',
  'curl',
  'gh',
  'git',
  'install',
  'kill',
  'launchctl',
  'ln',
  'make',
  'mkdir',
  'mv',
  'npm',
  'pnpm',
  'rm',
  'rmdir',
  'systemctl',
  'tee',
  'touch',
  'wget',
  'yarn',
  // Test and build runs change nothing on disk, but they are the step that
  // establishes whether the work holds up — the user reads them as the
  // checkpoint of a run, so they belong on the same footing as a commit.
  'cargo',
  'jest',
  'pytest',
  'tsc',
  'tsup',
  'vitest',
]);

/**
 * Runners that say nothing themselves — what matters is the command they wrap.
 * `npx vitest run` should be judged as `vitest`, not as an unknown program.
 */
const SHELL_RUNNER_PROGRAMS = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'poetry', 'time']);

/** Read-only `git` subcommands — `git status` is a lookup, `git push` is not. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'blame',
  'branch',
  'diff',
  'log',
  'ls-files',
  'show',
  'status',
]);

export function isSignificantTool(tool: ToolEntry): boolean {
  // Something the agent tried did not work — worth surfacing even when the run
  // goes on to recover.
  if (tool.status === 'error') return true;
  if (STATE_CHANGING_TOOLS.has(tool.name)) return true;
  if (SHELL_TOOLS.has(tool.name)) return isMutatingCommand(commandOf(tool.input));
  return false;
}

function commandOf(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const command = (input as Record<string, unknown>).command;
  return typeof command === 'string' ? command : '';
}

/**
 * Whether a shell command line looks like it changes something.
 *
 * Scans every program in the line, not just the first: mutations hide behind
 * `cd x && git commit`, and behind pipes. Redirection is treated as mutating
 * on the same reasoning — `foo > file` writes a file whatever `foo` is.
 */
function isMutatingCommand(command: string): boolean {
  if (!command.trim()) return false;
  if (/(^|[^0-9<>&])>>?[^&]/.test(command)) return true;

  const segments = command.split(/\|\||&&|[;|\n]/);
  return segments.some((segment) => {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    // Skip leading env assignments (`FOO=1 git push`), `sudo`, and wrappers
    // like `npx`, so the program actually being run is the one judged.
    let index = words.findIndex(
      (w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== 'sudo',
    );
    if (index === -1) return false;
    while (SHELL_RUNNER_PROGRAMS.has(basename(words[index] ?? ''))) {
      // A wrapper with nothing after it tells us nothing either way.
      if (index + 1 >= words.length) return false;
      index++;
    }
    const program = basename(words[index] ?? '');
    if (!MUTATING_SHELL_PROGRAMS.has(program)) return false;
    if (program === 'git') {
      const subcommand = words[index + 1];
      // A bare `git` or an unrecognized subcommand stays significant.
      return !subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
    }
    return true;
  });
}

function basename(program: string): string {
  const slash = program.lastIndexOf('/');
  return slash === -1 ? program : program.slice(slash + 1);
}
