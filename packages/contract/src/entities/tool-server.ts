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
