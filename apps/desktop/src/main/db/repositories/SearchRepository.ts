import type {
  ConversationHit,
  MessageHit,
  MessageRole,
  SearchResult,
  SearchSnippet,
} from '@comitiva/contract';
import type { Database } from '../Database';

/** Marks around a match in `snippet()`; control characters never typed in a message. */
const OPEN = '\u0002';
const CLOSE = '\u0003';

/**
 * Turns what the user typed into an FTS5 query: each word quoted (so
 * operators, quotes and parentheses are plain text), every word required,
 * the last one as a prefix (the user is still typing it). Words without a
 * letter or digit are dropped. Null when nothing is left.
 */
export function ftsQuery(input: string): string | null {
  const words = input
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ''))
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}

/** `snippet()` output as pieces, split at the match markers. */
export function toSnippet(raw: string): SearchSnippet {
  const out: SearchSnippet = [];
  let match = false;
  for (const piece of raw.split(new RegExp(`([${OPEN}${CLOSE}])`))) {
    if (piece === OPEN) match = true;
    else if (piece === CLOSE) match = false;
    else if (piece !== '') {
      const last = out.at(-1);
      if (last && last.match === match) last.text += piece;
      else out.push({ text: piece, match });
    }
  }
  return out.map((p) => ({ ...p, text: p.text.replace(/\s+/g, ' ') }));
}

/** Escapes `%`, `_` and `\` for a LIKE pattern with `ESCAPE '\'`. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The quick switcher's search: conversation titles (substring, case
 * insensitive) and message text through `messages_fts` (migration 0007),
 * ranked by bm25 and then recency. Archived conversations are left out.
 */
export class SearchRepository {
  constructor(private readonly db: Database) {}

  search(query: string, limit: number): SearchResult {
    return {
      conversations: this.conversations(query, limit),
      messages: this.messages(query, limit),
    };
  }

  private conversations(query: string, limit: number): ConversationHit[] {
    const rows = this.db.raw
      .prepare(
        `SELECT id, agent_id, title, last_activity_at FROM conversations
          WHERE archived = 0 AND title LIKE @pattern ESCAPE '\\'
          ORDER BY last_activity_at DESC LIMIT @limit`,
      )
      .all({ pattern: `%${likeEscape(query.trim())}%`, limit }) as Array<{
      id: string;
      agent_id: string;
      title: string;
      last_activity_at: string;
    }>;
    return rows.map((r) => ({
      conversationId: r.id,
      agentId: r.agent_id,
      title: r.title,
      lastActivityAt: r.last_activity_at,
    }));
  }

  private messages(query: string, limit: number): MessageHit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const rows = this.db.raw
      .prepare(
        `SELECT m.id, m.conversation_id, c.agent_id, c.title, m.seq, m.role, m.created_at,
                snippet(messages_fts, 0, @open, @close, '…', 16) AS snippet
           FROM messages_fts f
           JOIN messages m ON m.rowid = f.rowid
           JOIN conversations c ON c.id = m.conversation_id
          WHERE messages_fts MATCH @match AND c.archived = 0
          ORDER BY bm25(messages_fts), m.created_at DESC
          LIMIT @limit`,
      )
      .all({ match, open: OPEN, close: CLOSE, limit }) as Array<{
      id: string;
      conversation_id: string;
      agent_id: string;
      title: string | null;
      seq: number;
      role: MessageRole;
      created_at: string;
      snippet: string;
    }>;
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      agentId: r.agent_id,
      messageId: r.id,
      seq: r.seq,
      role: r.role,
      createdAt: r.created_at,
      conversationTitle: r.title,
      snippet: toSnippet(r.snippet),
    }));
  }
}
