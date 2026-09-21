/**
 * Starter roles for new agents. The text lives in i18n
 * (`agents.templates.<id>.name` / `.role`), so the prompt is written in the
 * user's language. Generic on purpose: nothing assumes code.
 */
export const roleTemplateIds = [
  'generic',
  'researcher',
  'writer',
  'reviewer',
  'fileOrganizer',
] as const;

export type RoleTemplateId = (typeof roleTemplateIds)[number];

/** The template the sample agent uses. */
export const sampleTemplate: RoleTemplateId = 'generic';
