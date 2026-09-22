import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../db/Database';
import { PricingRepository } from '../db/repositories/PricingRepository';
import { UsageRepository, type NewUsageRecord } from '../db/repositories/UsageRepository';
import { Pricing } from './Pricing';
import { UsageService } from './UsageService';
import { toCsv } from './csv';

const migrations = join(__dirname, '..', 'db', 'migrations');
/** The BOM the export starts with, built so it stays visible in the source. */
const BOM = String.fromCharCode(0xfeff);
let db: Database;
let usage: UsageRepository;
let service: UsageService;
let saveFile: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = Database.open(':memory:');
  db.migrate(migrations);
  const prices = new PricingRepository(db);
  const pricing = new Pricing(prices);
  usage = new UsageRepository(db, pricing);
  saveFile = vi.fn().mockResolvedValue(null);
  service = new UsageService({
    db,
    usage,
    prices,
    pricing,
    saveFile: saveFile as unknown as UsageService['deps']['saveFile'],
  });
});
afterEach(() => db.close());

const record = (over: Partial<NewUsageRecord> = {}): NewUsageRecord => ({
  connectionId: 'conn-a',
  agentId: 'agent-a',
  conversationId: 'conv-1',
  messageId: 'msg-1',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  estimated: false,
  latencyMs: 500,
  createdAt: '2026-09-10T12:00:00.000Z',
  ...over,
});

const SEPTEMBER = {
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-10-01T00:00:00.000Z',
  tzOffsetMinutes: 0,
};

describe('toCsv', () => {
  it('quotes only what would otherwise be misread, and doubles quotes', () => {
    expect(toCsv(['a', 'b'], [['plain', 'has,comma']])).toBe(`${BOM}a,b\r\nplain,"has,comma"\r\n`);
    expect(toCsv(['a'], [['say "hi"']])).toContain('"say ""hi"""');
    expect(toCsv(['a'], [['two\nlines']])).toContain('"two\nlines"');
  });

  it('opens with a BOM so a spreadsheet reads it as UTF-8', () => {
    expect(toCsv(['nome'], [['Pesquisador Sénior']]).startsWith(BOM)).toBe(true);
  });

  it('writes an empty cell for null and undefined, not the words', () => {
    expect(toCsv(['a', 'b'], [[null, undefined]])).toBe(`${BOM}a,b\r\n,\r\n`);
  });
});

describe('the timeseries', () => {
  it('includes the days nothing ran, so a gap is not read as missing data', () => {
    usage.insert(record({ createdAt: '2026-09-10T12:00:00.000Z' }));
    usage.insert(record({ createdAt: '2026-09-13T12:00:00.000Z' }));
    const days = service.timeseries({
      from: '2026-09-10T00:00:00.000Z',
      to: '2026-09-14T00:00:00.000Z',
      tzOffsetMinutes: 0,
    });
    expect(days.map((d) => [d.day, d.runs])).toEqual([
      ['2026-09-10', 1],
      ['2026-09-11', 0],
      ['2026-09-12', 0],
      ['2026-09-13', 1],
    ]);
  });

  it('counts a day on the viewer calendar', () => {
    usage.insert(record({ createdAt: '2026-09-10T23:30:00.000Z' }));
    const berlin = service.timeseries({
      from: '2026-09-10T00:00:00.000Z',
      to: '2026-09-12T00:00:00.000Z',
      tzOffsetMinutes: 120,
    });
    // 23:30 UTC is already the 11th two hours east.
    expect(berlin.find((d) => d.day === '2026-09-11')?.runs).toBe(1);
  });

  it('is empty for a window that ends before it starts', () => {
    expect(
      service.timeseries({
        from: '2026-09-10T00:00:00.000Z',
        to: '2026-09-09T00:00:00.000Z',
        tzOffsetMinutes: 0,
      }),
    ).toEqual([]);
  });
});

describe('prices', () => {
  it('reports where each model price comes from', () => {
    usage.insert(record());
    usage.insert(record({ provider: 'google', model: 'gemini-internal' }));
    const prices = service.prices();
    expect(prices.find((p) => p.model === 'claude-sonnet-5')).toMatchObject({
      source: 'table',
      runs: 1,
      prices: { inputPer1M: 2, outputPer1M: 10 },
    });
    // Nothing prices this one yet; the screen offers to set it.
    expect(prices.find((p) => p.model === 'gemini-internal')).toMatchObject({
      source: 'none',
      prices: null,
    });
  });

  it('recosts the records of a model when its price is corrected', () => {
    usage.insert(record());
    const before = service.summary(SEPTEMBER).totals.costUsd;

    const after = service.setPrice('anthropic', 'claude-sonnet-5', {
      inputPer1M: 20,
      outputPer1M: 100,
      cacheReadPer1M: null,
      cacheWritePer1M: null,
    });
    expect(after.find((p) => p.model === 'claude-sonnet-5')?.source).toBe('override');
    expect(service.summary(SEPTEMBER).totals.costUsd).toBeCloseTo(before * 10, 12);
  });

  it('goes back to the shipped price when the correction is cleared', () => {
    usage.insert(record());
    const original = service.summary(SEPTEMBER).totals.costUsd;
    service.setPrice('anthropic', 'claude-sonnet-5', {
      inputPer1M: 20,
      outputPer1M: 100,
      cacheReadPer1M: null,
      cacheWritePer1M: null,
    });
    const back = service.clearPrice('anthropic', 'claude-sonnet-5');
    expect(back.find((p) => p.model === 'claude-sonnet-5')?.source).toBe('table');
    expect(service.summary(SEPTEMBER).totals.costUsd).toBeCloseTo(original, 12);
  });
});

describe('export', () => {
  it('writes nothing and returns null when the dialog is cancelled', async () => {
    usage.insert(record());
    expect(await service.export(SEPTEMBER, 'records')).toBeNull();
    expect(saveFile).toHaveBeenCalledOnce();
  });

  it('writes one row per run, naming title runs and flagging equivalent costs', async () => {
    usage.insert(record());
    usage.insert(record({ messageId: null, model: 'claude-haiku-4-5' }));
    usage.insert(record({ provider: 'claude-code', model: 'claude-opus-5' }));

    const dir = await mkdtemp(join(tmpdir(), 'comitiva-usage-'));
    const path = join(dir, 'out.csv');
    saveFile.mockResolvedValue(path);

    expect(await service.export(SEPTEMBER, 'records')).toBe(path);
    expect(saveFile).toHaveBeenCalledWith(
      'comitiva-usage-records-2026-09-01.csv',
      expect.any(String),
    );
    const csv = await readFile(path, 'utf8');
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toContain('created_at,provider,model');
    expect(lines).toHaveLength(4);
    expect(csv).toContain('(title)');
    expect(csv).toContain('equivalent');
    expect(csv).toContain('billed');
  });

  it('exports the grouped view with a row per group and per day', async () => {
    usage.insert(record());
    const dir = await mkdtemp(join(tmpdir(), 'comitiva-usage-'));
    const path = join(dir, 'summary.csv');
    saveFile.mockResolvedValue(path);

    await service.export(SEPTEMBER, 'summary');
    const csv = await readFile(path, 'utf8');
    expect(csv).toContain('group,name,provider,runs');
    expect(csv).toContain('total,,');
    expect(csv).toContain('connection,');
    expect(csv).toContain('agent,');
    expect(csv).toContain('model,claude-sonnet-5');
    expect(csv).toContain('day,2026-09-10');
  });

  it('fails with a stable code when the file cannot be written', async () => {
    usage.insert(record());
    saveFile.mockResolvedValue('/definitely/not/a/directory/out.csv');
    await expect(service.export(SEPTEMBER, 'records')).rejects.toMatchObject({ code: 'internal' });
  });
});
