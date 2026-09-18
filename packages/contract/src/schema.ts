import { z } from 'zod';
import { Block } from './blocks.js';
import {
  Agent,
  Connection,
  Conversation,
  Message,
  ToolApproval,
  ToolServer,
  UsagePolicy,
  UsageRecord,
} from './entities/index.js';
import { AppErrorShape } from './errors.js';
import { RunnerEvent, RunnerRequest } from './runner-protocol.js';

/** Schemas published as JSON Schema for non-TypeScript consumers (the Laravel hub). */
export const publishedSchemas = {
  Agent,
  AppError: AppErrorShape,
  Block,
  Connection,
  Conversation,
  Message,
  RunnerEvent,
  RunnerRequest,
  ToolApproval,
  ToolServer,
  UsagePolicy,
  UsageRecord,
} as const;

const BASE_ID = 'https://comitiva.dev/schema/';

/** Generates one JSON Schema document per published schema, keyed by file name. */
export function generateJsonSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(publishedSchemas)) {
    const json = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'any',
    });
    out[`${name}.json`] = { $id: `${BASE_ID}${name}.json`, title: name, ...json };
  }
  return out;
}
