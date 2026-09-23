import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../Database';
import { AgentRepository } from './AgentRepository';
import { ConnectionRepository } from './ConnectionRepository';
import { ConversationRepository } from './ConversationRepository';
import { MessageRepository } from './MessageRepository';
import { ftsQuery, SearchRepository, toSnippet } from './SearchRepository';

let db: Database;
let conversations: ConversationRepository;
let messages: MessageRepository;
let search: SearchRepository;

const text = (t: string) => [{ type: 'text' as const, text: t }];
const words = (r: ReturnType<SearchRepository['search']>) =>
  r.messages.map((m) => m.snippet.map((p) => (p.match ? `[${p.text}]` : p.text)).join(''));

beforeEach(() => {
  db = Database.open(':memory:');
  db.migrate(join(__dirname, '..', 'migrations'));
  conversations = new ConversationRepository(db);
  messages = new MessageRepository(db);
  search = new SearchRepository(db);
  new ConnectionRepository(db).create({
    id: 'c1',
    name: 'Ollama',
    provider: 'ollama',
    config: { defaultModel: 'llama3' },
    secretRef: null,
  });
  new AgentRepository(db).create({
    id: 'a1',
    name: 'a1',
    avatar: { color: 'indigo' },
    connectionId: 'c1',
    model: null,
    role: '',
    params: {},
    tags: [],
    toolServerIds: [],
    roots: [],
    permissionPolicy: 'ask',
  });
});

function conversation(title: string | null = null) {
  const c = conversations.create('a1');
  if (title) conversations.rename(c.id, title);
  return c.id;
}

describe('ftsQuery', () => {
  it('quotes every word and makes the last one a prefix', () => {
    expect(ftsQuery('quarterly rep')).toBe('"quarterly" "rep"*');
    expect(ftsQuery('  "NEAR(a b)" OR -x  ')).toBe('"NEAR(a" "b)" "OR" "-x"*');
    expect(ftsQuery(' -- ! ')).toBeNull();
  });
});

describe('toSnippet', () => {
  it('splits at the markers and folds whitespace', () => {
    expect(toSnippet('a \u0002b\u0003\n c')).toEqual([
      { text: 'a ', match: false },
      { text: 'b', match: true },
      { text: ' c', match: false },
    ]);
  });
});

describe('SearchRepository', () => {
  it('finds words in finished messages, ignoring accents, case and word ends', () => {
    const c = conversation('Planning');
    messages.insert(c, 'user', text('Write the quarterly relatório'), 'complete');
    messages.insert(c, 'assistant', text('Here is the REPORT.'), 'complete');
    expect(words(search.search('relatorio', 10))).toEqual(['Write the quarterly [relatório]']);
    expect(words(search.search('rep', 10))).toEqual(['Here is the [REPORT].']);
    const [hit] = search.search('quarterly', 10).messages;
    expect(hit).toMatchObject({ conversationId: c, agentId: 'a1', seq: 0, role: 'user' });
    expect(hit!.conversationTitle).toBe('Planning');
  });

  it('indexes a reply only once it stops streaming, with its final text', () => {
    const c = conversation();
    const reply = messages.insert(c, 'assistant', [], 'streaming');
    messages.setContent(reply.id, text('partial draft'));
    expect(search.search('partial', 10).messages).toEqual([]);
    messages.finish(reply.id, 'complete', text('final answer'), null);
    expect(search.search('partial', 10).messages).toEqual([]);
    expect(search.search('final', 10).messages).toHaveLength(1);
    // A retry resets it to streaming: it leaves the index until it finishes again.
    messages.reset(reply.id);
    expect(search.search('final', 10).messages).toEqual([]);
  });

  it('indexes attachment names but not tool calls', () => {
    const c = conversation();
    messages.insert(
      c,
      'user',
      [
        {
          type: 'document',
          name: 'budget.csv',
          mediaType: 'text/csv',
          source: { kind: 'file', path: '01JAAAAAAAAAAAAAAAAAAAAAAA.csv' },
        },
      ],
      'complete',
    );
    messages.insert(
      c,
      'assistant',
      [{ type: 'tool_use', id: 't', toolServerId: 'fs', name: 'fs__secret_tool', input: {} }],
      'complete',
    );
    expect(search.search('budget', 10).messages).toHaveLength(1);
    expect(search.search('secret_tool', 10).messages).toEqual([]);
  });

  it('matches titles as substrings and leaves archived conversations out', () => {
    const kept = conversation('Launch 50% plan');
    const archived = conversation('Launch retro');
    messages.insert(archived, 'user', text('launch notes'), 'complete');
    conversations.setArchived(archived, true);
    const r = search.search('launch', 10);
    expect(r.conversations.map((h) => h.conversationId)).toEqual([kept]);
    expect(r.messages).toEqual([]);
    expect(search.search('50%', 10).conversations).toHaveLength(1);
    expect(search.search('5_%', 10).conversations).toHaveLength(0);
  });

  it('drops a deleted conversation from the index', () => {
    const c = conversation();
    messages.insert(c, 'user', text('ephemeral words'), 'complete');
    db.raw.prepare('DELETE FROM conversations WHERE id = ?').run(c);
    expect(search.search('ephemeral', 10).messages).toEqual([]);
    expect(db.raw.prepare('SELECT count(*) AS n FROM messages_fts').get()).toEqual({ n: 0 });
  });

  it('survives input FTS5 would reject', () => {
    const c = conversation();
    messages.insert(c, 'user', text('a "quoted" thing'), 'complete');
    for (const q of ['"', 'AND', '(', '*', 'NEAR(', 'thing"']) {
      expect(() => search.search(q, 10)).not.toThrow();
    }
    expect(search.search('quoted', 10).messages).toHaveLength(1);
  });
});
