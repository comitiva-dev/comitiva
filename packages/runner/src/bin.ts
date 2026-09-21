import { join } from 'node:path';
import { RunnerServer } from './server/RunnerServer.js';

// stdout is the protocol channel: route stray console output to stderr.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const server = new RunnerServer({
  input: process.stdin,
  output: process.stdout,
  // Bundled next to this file (dist/bin.cjs → dist/mcp-proxy.cjs).
  proxyPath: join(__dirname, 'mcp-proxy.cjs'),
  // Flush stdout first: pipes are asynchronous on macOS and Windows.
  onExit: () => process.stdout.write('', () => process.exit(0)),
});
server.start();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void server.stop());
}
