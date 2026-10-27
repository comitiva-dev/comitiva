import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../db/Database';
import { GuidelineRepository } from '../db/repositories/GuidelineRepository';
import { GuidelineService } from './GuidelineService';

let db: Database;
let dir: string;
let saveFile: ReturnType<typeof vi.fn<(name: string, filter: unknown) => Promise<string | null>>>;
let openFile: ReturnType<typeof vi.fn<(filter: unknown) => Promise<string | null>>>;
let service: GuidelineService;

beforeEach(() => {
  db = Database.open(':memory:');
  db.migrate(join(__dirname, '..', 'db', 'migrations'));
  dir = mkdtempSync(join(tmpdir(), 'comitiva-guidelines-'));
  saveFile = vi.fn();
  openFile = vi.fn();
  service = new GuidelineService({ repo: new GuidelineRepository(db), saveFile, openFile });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const AGENTS_MD = `# House rules

## Tone

Plain words.

## Sources
<!-- comitiva scope="tags" tags="research" -->

Cite every claim.
`;

describe('GuidelineService', () => {
  it('imports a file one section per guideline, after the ones already there', async () => {
    service.create({ name: 'First', content: 'x', scope: 'all', agentTags: [] });
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(path, AGENTS_MD);
    openFile.mockResolvedValue(path);
    const added = await service.importMarkdown();
    expect(added!.map((g) => [g.name, g.scope, g.agentTags, g.position])).toEqual([
      ['Tone', 'agents', [], 1],
      ['Sources', 'tags', ['research'], 2],
    ]);
    openFile.mockResolvedValue(null);
    expect(await service.importMarkdown()).toBeNull();
  });

  it('names a file without headings after the file, and refuses an empty one', () => {
    expect(service.importText('Be brief.', 'notes').map((g) => g.name)).toEqual(['notes']);
    expect(() => service.importText('  \n', 'empty')).toThrow(/no text/);
  });

  it('exports every guideline as an AGENTS.md that imports back the same', async () => {
    service.importText(AGENTS_MD, 'AGENTS');
    const path = join(dir, 'out.md');
    saveFile.mockResolvedValue(path);
    expect(await service.exportMarkdown()).toBe(path);
    expect(saveFile).toHaveBeenCalledWith(
      'AGENTS.md',
      expect.objectContaining({ name: 'Markdown' }),
    );
    const before = service
      .list()
      .map(({ name, content, scope, agentTags }) => ({ name, content, scope, agentTags }));
    const again = service.importText(readFileSync(path, 'utf8'), 'x');
    expect(
      again.map(({ name, content, scope, agentTags }) => ({ name, content, scope, agentTags })),
    ).toEqual(before);
  });

  it('gives each agent the guidelines that reach it, as the runner wants them', () => {
    const picked = service.create({ name: 'Picked', content: 'p', scope: 'agents', agentTags: [] });
    service.create({ name: 'All', content: 'a', scope: 'all', agentTags: [] });
    expect(service.forAgent({ tags: [], guidelineIds: [picked.id] })).toEqual([
      { name: 'Picked', content: 'p' },
      { name: 'All', content: 'a' },
    ]);
  });
});
