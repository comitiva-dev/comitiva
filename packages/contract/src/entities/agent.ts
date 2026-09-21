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
  /** API connections: model calls per run before the tool loop stops (default 25). */
  maxToolIterations: z.number().int().min(1).max(200).optional(),
});
export type AgentParams = z.infer<typeof AgentParams>;

/** Avatar background colors: palette names, so each shell picks light and dark shades. */
export const AvatarColor = z.enum([
  'indigo',
  'violet',
  'pink',
  'rose',
  'orange',
  'amber',
  'emerald',
  'teal',
  'sky',
  'slate',
]);
export type AvatarColor = z.infer<typeof AvatarColor>;

/** Always a color; without an emoji, shells show the name's initials. */
export const AgentAvatar = z.object({
  color: AvatarColor,
  emoji: z.string().trim().min(1).max(16).optional(),
});
export type AgentAvatar = z.infer<typeof AgentAvatar>;

export const AgentTag = z.string().trim().min(1).max(32);
export const AgentTags = z.array(AgentTag).max(20);

/** A persistent persona. */
export const Agent = z.object({
  id: Id,
  name: z.string().min(1),
  avatar: AgentAvatar,
  connectionId: Id,
  model: z.string().nullable(),
  role: z.string(),
  params: AgentParams,
  toolServerIds: z.array(Id),
  roots: z.array(AgentRoot),
  permissionPolicy: PermissionPolicy,
  fallbackConnectionIds: z.array(Id),
  tags: AgentTags,
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Agent = z.infer<typeof Agent>;
