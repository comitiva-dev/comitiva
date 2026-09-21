import { AppError } from '@comitiva/contract';
import { CliHarnessAdapter, type TurnSpec } from './CliHarnessAdapter.js';
import { ClaudeCodeParser } from './parsers/claudeCode.js';
import type { HarnessParser, ParserOptions } from './parsers/types.js';
import { runCommand } from './process.js';

/** Built-in tools kept when the agent has the filesystem server: nothing that touches files. */
export const NATIVE_TOOLS_WITH_FILESYSTEM = 'WebSearch,WebFetch';
export const MCP_CALL_TIMEOUT_MS = 30 * 60_000;

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
    if (t.mcp) {
      args.push('--mcp-config', t.mcp.path);
      // Every file access goes through the built-in server and its approvals:
      // no Read/Write/Edit, and no Bash (it can write files too).
      if (t.mcp.hasFilesystem) args.push('--tools', NATIVE_TOOLS_WITH_FILESYSTEM);
    }
    if (t.probe) args.push('--no-session-persistence', '--tools', '');
    return [...args, ...t.config.extraArgs];
  }

  /** An approval can take a while: MCP calls wait up to 30 min (the default is much shorter). */
  protected override turnEnv(t: TurnSpec): Record<string, string> {
    return t.mcp ? { MCP_TOOL_TIMEOUT: String(MCP_CALL_TIMEOUT_MS) } : {};
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
