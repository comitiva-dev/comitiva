import { AppError } from '@comitiva/contract';
import { CliHarnessAdapter, type TurnSpec } from './CliHarnessAdapter.js';
import { ClaudeCodeParser } from './parsers/claudeCode.js';
import type { HarnessParser, ParserOptions } from './parsers/types.js';
import { runCommand } from './process.js';

/**
 * Claude Code in print mode with streaming JSON. Auto-accept
 * (`bypassPermissions`) and isolated from the user's settings and MCP servers;
 * `extraArgs` come last and can override both. Flags verified against
 * Claude Code 2.1.278 (docs/providers.md).
 */
export class ClaudeCodeAdapter extends CliHarnessAdapter {
  readonly id = 'claude-code' as const;

  protected buildArgs(t: TurnSpec): string[] {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'bypassPermissions',
      '--setting-sources',
      '',
      '--strict-mcp-config',
    ];
    if (t.model) args.push('--model', t.model);
    if (t.system) args.push('--append-system-prompt', t.system);
    if (t.resume) args.push('--resume', t.resume);
    if (t.mcpConfigPath) args.push('--mcp-config', t.mcpConfigPath);
    if (t.probe) args.push('--no-session-persistence', '--tools', '');
    return [...args, ...t.config.extraArgs];
  }

  protected createParser(opts: ParserOptions): HarnessParser {
    return new ClaudeCodeParser(opts);
  }

  protected async authCheck(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
    const r = await runCommand(bin, ['auth', 'status'], { cwd, env, timeoutMs: 15_000 });
    let loggedIn: unknown;
    try {
      loggedIn = (JSON.parse(r.stdout) as { loggedIn?: unknown }).loggedIn;
    } catch {
      // Older builds print text; the test prompt settles it.
      return;
    }
    if (loggedIn !== true) {
      throw new AppError(
        'not_logged_in',
        'Claude Code is not logged in; run `claude auth login` in a terminal',
      );
    }
  }
}
