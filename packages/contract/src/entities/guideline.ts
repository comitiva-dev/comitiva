import { z } from 'zod';
import { Id, IsoDate } from '../common.js';
import { AgentTags } from './agent.js';

/**
 * Which agents a guideline reaches on its own: every agent, the agents with
 * one of its tags, or none (only the agents that pick it). An agent can also
 * pick any guideline by id, whatever its scope.
 */
export const GuidelineScope = z.enum(['all', 'tags', 'agents']);
export type GuidelineScope = z.infer<typeof GuidelineScope>;

export const GuidelineName = z.string().trim().min(1).max(100);

/**
 * A block of instructions, rules or reference data added to the system prompt
 * of the agents it reaches, after their role. One section of an AGENTS.md.
 */
export const Guideline = z.object({
  id: Id,
  name: GuidelineName,
  /** Markdown. */
  content: z.string(),
  scope: GuidelineScope,
  /** `tags` scope: agents with any of these tags. Kept, but unused, under other scopes. */
  agentTags: AgentTags,
  /** Order in the prompt and in lists, lowest first. */
  position: z.number().int().nonnegative(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Guideline = z.infer<typeof Guideline>;

/** A guideline as the runner receives it for one run. */
export const RunGuideline = z.object({ name: GuidelineName, content: z.string() });
export type RunGuideline = z.infer<typeof RunGuideline>;
