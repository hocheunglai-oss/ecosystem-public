import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInboxPolling, type InboxRefreshResult } from '../src/lib/inboxPolling';

function harness() {
  let time = 0, allowed = true, foreground = true;
  const timers = new Map<object, { at: number; callback: () => void }>();
  const calls: { more: boolean; done: (result: InboxRefreshResult) => void }[] = [];
  const loop = createInboxPolling({
    canRead: () => allowed,
    canPoll: () => allowed && foreground,
    read: more => new Promise(resolve => calls.push({ more, done: resolve })),
    schedule: (callback, delay) => { const id = {}; timers.set(id, { at: time + delay, callback }); return () => { timers.delete(id); }; },
  });
  const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
  return { loop, calls, timers, flush,
    allow: (value: boolean) => { allowed = value; },
    foreground: (value: boolean) => { foreground = value; loop.wake(); },
    finish: async (result: InboxRefreshResult) => { calls.at(-1)!.done(result); await flush(); },
    advance: async (duration: number) => {
      time += duration;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); }
      await flush();
    },
  };
}

test('slow reads are never restarted by timer, focus or visibility events; five seconds starts at completion', async () => {
  const h = harness(); h.loop.wake(); await h.flush();
  await h.advance(15_000); h.loop.wake(); h.loop.wake(); await h.flush();
  assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
  await h.finish('success'); await h.advance(4_999); assert.equal(h.calls.length, 1);
  await h.advance(1); assert.equal(h.calls.length, 2);
  h.loop.stop(); await h.finish('success'); assert.equal(h.timers.size, 0);
});

test('failures back off to 10, 20, 40 and 60 seconds; success resets to five seconds', async () => {
  const h = harness(); h.loop.wake(); await h.flush();
  for (const delay of [10_000, 20_000, 40_000, 60_000, 60_000]) {
    const count = h.calls.length; await h.finish('failure');
    await h.advance(delay - 1); assert.equal(h.calls.length, count);
    await h.advance(1); assert.equal(h.calls.length, count + 1);
  }
  await h.finish('success'); const count = h.calls.length;
  await h.advance(4_999); assert.equal(h.calls.length, count);
  await h.advance(1); assert.equal(h.calls.length, count + 1); h.loop.stop();
});

test('hidden or offline work is suspended; returning foreground refreshes immediately without overlap', async () => {
  const h = harness(); h.foreground(false); await h.advance(90_000); assert.equal(h.calls.length, 0);
  h.foreground(true); await h.flush(); assert.equal(h.calls.length, 1);
  h.foreground(false); await h.finish('success'); await h.advance(90_000); assert.equal(h.calls.length, 1);
  h.foreground(true); h.foreground(true); await h.flush(); assert.equal(h.calls.length, 2); h.loop.stop();
});

test('manual retry bypasses backoff and pagination completion owns the next automatic deadline', async () => {
  const h = harness(); h.loop.wake(); await h.flush(); await h.finish('failure');
  void h.loop.refresh(); await h.flush(); assert.equal(h.calls.length, 2); await h.finish('success');
  await h.advance(2_000); void h.loop.refresh(true); await h.flush(); assert.equal(h.calls[2].more, true);
  await h.advance(8_000); assert.equal(h.calls.length, 3); await h.finish('success');
  await h.advance(4_999); assert.equal(h.calls.length, 3); await h.advance(1);
  assert.equal(h.calls.length, 4); assert.equal(h.calls[3].more, false); h.loop.stop();
});

test('mutation refresh waits for an invalidated read and concurrent receipts share its replacement', async () => {
  const h = harness(); h.loop.wake(); await h.flush();
  const first = h.loop.refreshAfterCurrent(), second = h.loop.refreshAfterCurrent();
  await h.flush(); assert.equal(h.calls.length, 1);
  await h.finish('cancelled'); assert.equal(h.calls.length, 2);
  await h.finish('success'); assert.equal(await first, 'success'); assert.equal(await second, 'success');
  assert.equal(h.calls.length, 2); h.loop.stop();
});

test('scope removal and stop prevent old responses or queued mutation refreshes from scheduling work', async () => {
  const h = harness(); h.loop.wake(); await h.flush(); const after = h.loop.refreshAfterCurrent();
  h.allow(false); h.loop.stop(); await h.finish('success');
  assert.equal(await after, 'cancelled'); await h.advance(90_000); h.loop.wake();
  assert.equal(await h.loop.refresh(), 'cancelled'); assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
});
