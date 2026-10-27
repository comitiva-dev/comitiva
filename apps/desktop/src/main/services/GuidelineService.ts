import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  AppError,
  GuidelineDraft,
  guidelinesFor,
  guidelinesToMarkdown,
  parseGuidelinesMarkdown,
  type Agent,
  type Guideline,
  type RunGuideline,
  type ValidGuidelineDraft,
  type ValidGuidelinePatch,
} from '@comitiva/contract';
import type { GuidelineRepository } from '../db/repositories/GuidelineRepository';

type Filter = { name: string; extensions: string[] };

export interface GuidelineServiceDeps {
  repo: GuidelineRepository;
  saveFile(suggestedName: string, filter: Filter): Promise<string | null>;
  openFile(filter: Filter): Promise<string | null>;
}

const MARKDOWN: Filter = { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] };

/**
 * Guidelines (ADR 0020): blocks of instructions the runner adds to the system
 * prompt of the agents they reach. They move in and out as an AGENTS.md, one
 * guideline per `##` section.
 */
export class GuidelineService {
  constructor(private readonly deps: GuidelineServiceDeps) {}

  list(): Guideline[] {
    return this.deps.repo.list();
  }

  create(draft: ValidGuidelineDraft): Guideline {
    return this.deps.repo.create(draft);
  }

  update(id: string, patch: ValidGuidelinePatch): Guideline {
    return this.deps.repo.update(id, patch);
  }

  delete(id: string): void {
    this.deps.repo.delete(id);
  }

  move(id: string, index: number): Guideline[] {
    return this.deps.repo.move(id, index);
  }

  /** What a run of this agent gets, in prompt order. */
  forAgent(agent: Pick<Agent, 'tags' | 'guidelineIds'>): RunGuideline[] {
    return guidelinesFor(agent, this.deps.repo.list()).map(({ name, content }) => ({
      name,
      content,
    }));
  }

  /** Adds the sections of a Markdown file as guidelines; null when the dialog was cancelled. */
  async importMarkdown(): Promise<Guideline[] | null> {
    const path = await this.deps.openFile(MARKDOWN);
    if (!path) return null;
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      throw new AppError('invalid_request', `Could not read ${path}`, { cause: err });
    }
    return this.importText(text, basename(path, extname(path)));
  }

  /** Splits Markdown into guidelines and adds them; `invalid_request` when it has none. */
  importText(text: string, fallbackName: string): Guideline[] {
    const drafts = parseGuidelinesMarkdown(text, fallbackName).map((g) => GuidelineDraft.parse(g));
    if (drafts.length === 0) {
      throw new AppError('invalid_request', 'The file has no text to make guidelines from');
    }
    return this.deps.repo.createMany(drafts);
  }

  /** Every guideline as one AGENTS.md; the saved path, or null when cancelled. */
  async exportMarkdown(): Promise<string | null> {
    const path = await this.deps.saveFile('AGENTS.md', MARKDOWN);
    if (!path) return null;
    try {
      await writeFile(path, guidelinesToMarkdown(this.deps.repo.list()), 'utf8');
    } catch (err) {
      throw new AppError('internal', `Could not write ${path}`, { cause: err });
    }
    return path;
  }
}
