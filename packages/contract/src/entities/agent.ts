import { z } from 'zod';
import { Id, IsoDate } from '../common.js';

export const RootMode = z.enum(['read', 'readwrite']);
export type RootMode = z.infer<typeof RootMode>;

export const AgentRoot = z.object({ path: z.string().min(1), mode: RootMode });
export type AgentRoot = z.infer<typeof AgentRoot>;

export const PermissionPolicy = z.enum(['ask', 'allow-writes', 'read-only']);
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

export const AgentParams = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
});
export type AgentParams = z.infer<typeof AgentParams>;

/** A persistent persona. */
export const Agent = z.object({
  id: Id,
  name: z.string().min(1),
  avatar: z.string(),
  connectionId: Id,
  model: z.string().nullable(),
  role: z.string(),
  params: AgentParams,
  toolServerIds: z.array(Id),
  roots: z.array(AgentRoot),
  permissionPolicy: PermissionPolicy,
  fallbackConnectionIds: z.array(Id),
  tags: z.array(z.string()),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Agent = z.infer<typeof Agent>;
