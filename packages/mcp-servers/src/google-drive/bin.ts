import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGoogleDriveServer, parseArgs } from './server.js';

// comitiva-mcp-gdrive [--gated-by-client]
// env: GDRIVE_ACCESS_TOKEN (required; given by the shell, which refreshes it),
//      GDRIVE_API_BASE_URL (optional; tests only).
// The token is never read from or written to disk. stdout is the MCP channel;
// diagnostics go to stderr.
const warn = (msg: string) => process.stderr.write(`[comitiva-google-drive] ${msg}\n`);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const accessToken = process.env.GDRIVE_ACCESS_TOKEN;
  if (!accessToken) throw new Error('GDRIVE_ACCESS_TOKEN is not set');
  // Keep the token out of anything this process might spawn or dump.
  delete process.env.GDRIVE_ACCESS_TOKEN;
  const server = createGoogleDriveServer({
    ...args,
    accessToken,
    apiBaseUrl: process.env.GDRIVE_API_BASE_URL || undefined,
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  warn((err as Error).message);
  process.exit(2);
});
