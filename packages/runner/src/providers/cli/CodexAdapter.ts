import { AppError, type CodexConfig, type Connection } from '@comitiva/contract';
import { CliHarnessAdapter, type TurnSpec } from './CliHarnessAdapter.js';
import { MCP_CALL_TIMEOUT_MS } from './ClaudeCodeAdapter.js';
import { CodexParser } from './parsers/codex.js';
import { stderrSummary, type HarnessParser, type ParserOptions } from './parsers/types.js';
import { runCommand } from './process.js';

/**
 * Codex `exec --json`. It never prompts (approval policy `never`); its own
 * sandbox is chosen per connection. Isolated from `~/.codex/config.toml`;
 * `extraArgs` come last. Flags verified against codex-cli 0.155.1
 * (docs/providers.md). `exec resume` has no `-s`, so the sandbox always goes
 * through `-c sandbox_mode`.
 */
export class CodexAdapter extends CliHarnessAdapter {
  readonly id = 'codex' as const;

  protected buildArgs(t: TurnSpec): string[] {
    const config = t.config as CodexConfig;
    const args = ['exec'];
    if (t.resume) args.push('resume');
    args.push('--json', '--skip-git-repo-check', '--ignore-user-config');
    // apply_patch cannot be turned off, so with the filesystem server Codex's own
    // sandbox is read-only: its native writes fail and it writes through the
    // built-in server, which asks first (ADR 0009).
    const sandbox = t.mcp?.hasFilesystem ? 'read-only' : (config.sandbox ?? 'workspace-write');
    args.push('-c', `sandbox_mode=${tomlString(sandbox)}`);
    if (t.model) args.push('-m', t.model);
    if (t.system) args.push('-c', `developer_instructions=${tomlString(t.system)}`);
    if (t.probe) args.push('--ephemeral');
    if (t.mcp) {
      const key = `mcp_servers.${t.mcp.serverName}`;
      args.push('-c', `${key}.command=${tomlString(t.mcp.command)}`);
      args.push('-c', `${key}.args=[${t.mcp.args.map(tomlString).join(', ')}]`);
      const env = Object.entries(t.mcp.env);
      if (env.length > 0) {
        const table = env.map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ');
        args.push('-c', `${key}.env={ ${table} }`);
      }
      // An approval can take a while.
      args.push('-c', `${key}.tool_timeout_sec=${MCP_CALL_TIMEOUT_MS / 1000}`);
      // Codex would decline tools without readOnlyHint itself (exec cannot ask);
      // the runner gates every call and asks the user, so Codex lets them through.
      args.push('-c', `${key}.default_tools_approval_mode="approve"`);
    }
    args.push(...t.config.extraArgs);
    if (t.resume) args.push(t.resume);
    args.push('-'); // prompt on stdin
    return args;
  }

  protected createParser(opts: ParserOptions): HarnessParser {
    return new CodexParser(opts);
  }

  protected async authCheck(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
    const r = await runCommand(bin, ['login', 'status'], { cwd, env, timeoutMs: 15_000 });
    if (r.code !== 0) {
      throw new AppError(
        'not_logged_in',
        'Codex is not logged in; run `codex login` in a terminal',
      );
    }
  }

  /** The OS sandbox cannot start on some systems (Ubuntu 24.04 AppArmor); `true` in it tells. */
  protected override async preflight(
    bin: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
    connection: Connection,
  ): Promise<void> {
    const sandbox = (connection.config as CodexConfig).sandbox ?? 'workspace-write';
    if (sandbox === 'danger-full-access') return;
    const r = await runCommand(bin, ['sandbox', '--', 'true'], { cwd, env, timeoutMs: 15_000 });
    if (r.code !== 0) {
      throw new AppError(
        'sandbox_unavailable',
        `The Codex sandbox cannot start on this system (${stderrSummary(r.stderr) || `exit ${r.code}`})`,
      );
    }
  }
}

/** A TOML basic string (what `-c key=value` parses). */
export function tomlString(value: string): string {
  const named: Record<string, string> = {
    '\\': '\\\\',
    '"': '\\"',
    '\n': '\\n',
    '\t': '\\t',
    '\r': '\\r',
  };
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (named[ch] !== undefined) out += named[ch];
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `"${out}"`;
}
