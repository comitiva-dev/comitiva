import { createHash } from 'node:crypto';
import type { ToolDef } from '@comitiva/contract';
import type { ToolResult } from '../providers/ProviderAdapter.js';
import { errorResult } from './content.js';
import type { ServerHandle } from './McpClientManager.js';

export interface CatalogEntry {
  /** What the model sees: `<slug>__<tool>` (≤ 64 chars, [A-Za-z0-9_-]). */
  name: string;
  serverId: string;
  /** The server's own definition (its own tool name). */
  tool: ToolDef;
  handle: ServerHandle;
}

/**
 * The tools of one run, aggregated from the agent's servers. Names are
 * prefixed per server (`fs__read_file`, `github__create_issue`) so two servers
 * can expose tools with the same name.
 */
export class ToolCatalog {
  private readonly byName = new Map<string, CatalogEntry>();

  constructor(handles: readonly ServerHandle[], filter: (tool: ToolDef) => boolean = () => true) {
    const slugs = new Set<string>();
    for (const handle of handles) {
      const slug = uniqueSlug(handle.builtin === 'filesystem' ? 'fs' : slugify(handle.name), slugs);
      for (const tool of handle.tools) {
        if (!filter(tool)) continue;
        const name = prefixed(slug, tool.name);
        this.byName.set(name, { name, serverId: handle.serverId, tool, handle });
      }
    }
  }

  static empty(): ToolCatalog {
    return new ToolCatalog([]);
  }

  get size(): number {
    return this.byName.size;
  }

  /** Definitions as the model gets them (prefixed names). */
  defs(): ToolDef[] {
    return [...this.byName.values()].map((e) => ({ ...e.tool, name: e.name }));
  }

  /** True when a built-in server (e.g. the filesystem) contributes tools. */
  hasBuiltin(builtin: 'filesystem'): boolean {
    return [...this.byName.values()].some((e) => e.handle.builtin === builtin);
  }

  resolve(name: string): CatalogEntry | undefined {
    return this.byName.get(name);
  }

  async call(name: string, input: unknown, signal: AbortSignal): Promise<ToolResult> {
    const entry = this.byName.get(name);
    if (!entry) return errorResult('invalid_request', `There is no tool named ${name}`);
    return entry.handle.call(entry.tool.name, input, signal);
  }
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  return s || 'mcp';
}

function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}_${n}`;
  taken.add(slug);
  return slug;
}

function prefixed(slug: string, tool: string): string {
  const name = `${slug}__${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  if (name.length <= 64) return name;
  const h = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `${name.slice(0, 55)}_${h}`;
}
