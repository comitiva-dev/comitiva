import { describe, expect, it } from 'vitest';
import type { MessagePage } from '@comitiva/contract';
import { BackendError } from '../backend/Backend';
import { createMessagesStore } from './messages';
import { fakeBackend, message } from './testBackend';

const text = (t: string) => [{ type: 'text' as const, text: t }];
const page = (over: Partial<MessagePage> = {}): MessagePage => ({
  messages: [],
  hasMore: false,
  rev: 0,
  ...over,
});
const delta = (rev: number, t: string, messageId = 'r') =>
  ({ type: 'message.delta', conversationId: 'k1', messageId, rev, text: t }) as const;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('messages store', () => {
  it('applies deltas to the streaming reply only, keeping other rows as they were', async () => {
    const backend = fakeBackend();
    const user = message('u', { role: 'user', seq: 0, content: text('hi') });
    const reply = message('r', { seq: 1, status: 'streaming', content: [] });
    backend.messages.list.mockResolvedValue(page({ messages: [user, reply], rev: 2 }));
    const store = createMessagesStore(backend);
    await store.getState().load('k1');
    store.getState().handleEvent(delta(3, 'Hel'));
    store.getState().handleEvent(delta(4, 'lo'));
    const { items, rev } = store.getState().byConversation.k1!;
    expect(items[0]).toBe(user);
    expect(items[1]!.content).toEqual(text('Hello'));
    expect(rev).toBe(4);

    const block = {
      type: 'tool_use' as const,
      id: 't',
      toolServerId: 'harness:codex',
      name: 'shell',
      input: {},
    };
    store
      .getState()
      .handleEvent({ type: 'message.block', conversationId: 'k1', messageId: 'r', rev: 5, block });
    store.getState().handleEvent(delta(6, 'Done'));
    expect(store.getState().byConversation.k1!.items[1]!.content).toEqual([
      ...text('Hello'),
      block,
      ...text('Done'),
    ]);

    store.getState().handleEvent({
      type: 'message.updated',
      message: { ...reply, status: 'complete', content: text('final') },
      rev: 7,
    });
    expect(store.getState().byConversation.k1!.items[1]).toMatchObject({
      status: 'complete',
      content: text('final'),
    });
  });

  it('buffers events while the page loads and drops those the page already has', async () => {
    const backend = fakeBackend();
    const pending = deferred<MessagePage>();
    backend.messages.list.mockReturnValueOnce(pending.promise);
    const store = createMessagesStore(backend);
    const loading = store.getState().load('k1');
    // Emitted before the snapshot (already in it) and after it.
    const empty = message('r', { seq: 1, status: 'streaming', content: [] });
    store.getState().handleEvent({ type: 'message.updated', message: empty, rev: 2 });
    store.getState().handleEvent(delta(3, 'Hel'));
    store.getState().handleEvent(delta(4, 'lo'));
    pending.resolve(page({ messages: [{ ...empty, content: text('Hel') }], rev: 3 }));
    await loading;
    expect(store.getState().byConversation.k1).toMatchObject({
      status: 'ready',
      rev: 4,
      buffered: [],
    });
    expect(store.getState().byConversation.k1!.items[0]!.content).toEqual(text('Hello'));
  });

  it('reloads the page when an event went missing or names an unknown message', async () => {
    const backend = fakeBackend();
    backend.messages.list.mockResolvedValue(
      page({ messages: [message('r', { status: 'streaming', content: [] })], rev: 1 }),
    );
    const store = createMessagesStore(backend);
    await store.getState().load('k1');
    store.getState().handleEvent(delta(3, 'skipped rev 2'));
    await Promise.resolve();
    expect(backend.messages.list).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    store.getState().handleEvent(delta(2, 'x', 'ghost'));
    expect(backend.messages.list).toHaveBeenCalledTimes(3);
  });

  it('ignores events of conversations never opened', () => {
    const store = createMessagesStore(fakeBackend());
    store.getState().handleEvent(delta(1, 'x'));
    expect(store.getState().byConversation).toEqual({});
  });

  it('inserts new messages in seq order', async () => {
    const backend = fakeBackend();
    backend.messages.list.mockResolvedValue(page({ messages: [message('a', { seq: 0 })], rev: 1 }));
    const store = createMessagesStore(backend);
    await store.getState().load('k1');
    store
      .getState()
      .handleEvent({ type: 'message.updated', message: message('c', { seq: 2 }), rev: 2 });
    store
      .getState()
      .handleEvent({ type: 'message.updated', message: message('b', { seq: 1 }), rev: 3 });
    expect(store.getState().byConversation.k1!.items.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('loads older pages before the oldest seq', async () => {
    const backend = fakeBackend();
    backend.messages.list
      .mockResolvedValueOnce(page({ messages: [message('m5', { seq: 5 })], hasMore: true, rev: 9 }))
      .mockResolvedValueOnce(page({ messages: [message('m4', { seq: 4 })], hasMore: false }));
    const store = createMessagesStore(backend);
    await store.getState().load('k1');
    await store.getState().loadOlder('k1');
    expect(backend.messages.list).toHaveBeenLastCalledWith('k1', { beforeSeq: 5 });
    expect(store.getState().byConversation.k1).toMatchObject({ hasMore: false, rev: 9 });
    expect(store.getState().byConversation.k1!.items.map((m) => m.id)).toEqual(['m4', 'm5']);
  });

  it('sends the trimmed draft and clears it only when the backend took it', async () => {
    const backend = fakeBackend();
    const store = createMessagesStore(backend);
    store.getState().setDraft('k1', '  hello \n');
    await store.getState().send('k1');
    expect(backend.messages.send).toHaveBeenCalledWith('k1', text('hello'));
    expect(store.getState().drafts.k1).toBe('');

    store.getState().setDraft('k1', 'again');
    backend.messages.send.mockRejectedValueOnce(
      new BackendError('conversation_busy', 'busy', false),
    );
    await store.getState().send('k1');
    expect(store.getState().drafts.k1).toBe('again');
    expect(store.getState().actionError.k1).toBe('conversation_busy');
    expect(store.getState().sending.k1).toBe(false);

    store.getState().setDraft('k1', '   ');
    await store.getState().send('k1');
    expect(backend.messages.send).toHaveBeenCalledTimes(2);
  });

  it('keeps drafts per conversation and cancels or retries by conversation', async () => {
    const backend = fakeBackend();
    const store = createMessagesStore(backend);
    store.getState().setDraft('k1', 'one');
    store.getState().setDraft('k2', 'two');
    expect(store.getState().drafts).toEqual({ k1: 'one', k2: 'two' });
    await store.getState().cancel('k1');
    await store.getState().retry('k2');
    expect(backend.messages.cancel).toHaveBeenCalledWith('k1');
    expect(backend.messages.retry).toHaveBeenCalledWith('k2');
  });
});

describe('messages store: attachments', () => {
  const picked = (name: string, type = 'text/markdown', size = 10) => ({
    name,
    type,
    size,
    read: async () => 'IyBoaQ==',
  });

  it('stores picked files and sends them with the text, then clears the draft', async () => {
    const backend = fakeBackend();
    const store = createMessagesStore(backend);
    store.getState().setDraft('k1', 'See attached');
    await store.getState().attach('k1', [picked('a.md')]);
    const [a] = store.getState().attachments.k1!;
    expect(a).toMatchObject({ name: 'a.md', status: 'ready' });
    expect(backend.attachments.add).toHaveBeenCalledWith({
      name: 'a.md',
      mediaType: 'text/markdown',
      dataBase64: 'IyBoaQ==',
    });

    await store.getState().send('k1');
    expect(backend.messages.send).toHaveBeenCalledWith('k1', [
      { type: 'text', text: 'See attached' },
      a!.block,
    ]);
    expect(store.getState().attachments.k1).toEqual([]);
    expect(store.getState().drafts.k1).toBe('');
  });

  it('refuses files over the limit or past ten, and keeps the refusal on the chip', async () => {
    const backend = fakeBackend();
    backend.attachments.add.mockRejectedValueOnce(
      new BackendError('unsupported_attachment', 'binary', false),
    );
    const store = createMessagesStore(backend);
    await store
      .getState()
      .attach('k1', [picked('a.zip', 'application/zip'), picked('big.png', 'image/png', 6e6)]);
    expect(store.getState().attachments.k1!.map((a) => [a.status, a.error])).toEqual([
      ['failed', 'unsupported_attachment'],
      ['failed', 'attachment_too_large'],
    ]);
    // A draft of refused files only cannot be sent.
    await store.getState().send('k1');
    expect(backend.messages.send).not.toHaveBeenCalled();

    await store.getState().attach(
      'k1',
      Array.from({ length: 11 }, (_, i) => picked(`${i}.md`)),
    );
    expect(store.getState().attachments.k1!.filter((a) => a.status === 'ready')).toHaveLength(10);
    expect(store.getState().actionError.k1).toBe('attachment_too_many');
  });

  it('moves a draft with its files to a new conversation', async () => {
    const store = createMessagesStore(fakeBackend());
    store.getState().setDraft('new:a', 'hello');
    await store.getState().attach('new:a', [picked('a.md')]);
    store.getState().moveDraft('new:a', 'k9');
    expect(store.getState().drafts).toMatchObject({ 'new:a': '', k9: 'hello' });
    expect(store.getState().attachments.k9).toHaveLength(1);
    expect(store.getState().attachments['new:a']).toEqual([]);
    store.getState().detach('k9', store.getState().attachments.k9![0]!.id);
    expect(store.getState().attachments.k9).toEqual([]);
  });
});
