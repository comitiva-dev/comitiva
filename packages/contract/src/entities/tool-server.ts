import { z } from 'zod';
import { Id, IsoDate } from '../common.js';

/** A plain value, or a reference to a secret resolved by the shell at start time. */
export const ValueOrSecret = z.union([
  z.object({ value: z.string() }),
  z.object({ secretRef: z.string() }),
]);
export type ValueOrSecret = z.infer<typeof ValueOrSecret>;

export const ToolServerTransport = z.enum(['stdio', 'http']);
export type ToolServerTransport = z.infer<typeof ToolServerTransport>;

/** Built-in servers ship with Comitiva; the shell knows how to launch them. */
export const BuiltinToolServer = z.enum(['filesystem', 'google-drive']);
export type BuiltinToolServer = z.infer<typeof BuiltinToolServer>;

/** The built-in filesystem server's fixed id (seeded by every shell). */
export const FILESYSTEM_TOOL_SERVER_ID = 'filesystem';

/** The built-in Google Drive server's fixed id (seeded by every shell). */
export const GOOGLE_DRIVE_TOOL_SERVER_ID = 'google-drive';

/** An MCP server. */
export const ToolServer = z.object({
  id: Id,
  name: z.string().min(1),
  transport: ToolServerTransport,
  command: z.string().nullable(),
  args: z.array(z.string()),
  env: z.record(z.string(), ValueOrSecret),
  url: z.url().nullable(),
  headers: z.record(z.string(), ValueOrSecret),
  builtin: z.boolean(),
  enabled: z.boolean(),
  createdAt: IsoDate,
});
export type ToolServer = z.infer<typeof ToolServer>;
