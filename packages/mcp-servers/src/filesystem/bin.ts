import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFilesystemServer, parseArgs } from './server.js';

// comitiva-mcp-filesystem --root <path>:<mode> … [--gated-by-client]
// stdout is the MCP channel; diagnostics go to stderr.
const warn = (msg: string) => process.stderr.write(`[comitiva-filesystem] ${msg}\n`);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const server = await createFilesystemServer({ ...args, warn });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  warn((err as Error).message);
  process.exit(2);
});
