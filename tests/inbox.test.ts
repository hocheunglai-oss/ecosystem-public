import { test } from "node:test";
import assert from "node:assert/strict";
import { actors, canTrade } from "../src/lib/model";
import {
  actionableInboxItems,
  createDemoIncoming,
  createSeedInbox,
  clearInboxNotifications,
  dismissInboxNotification,
  demoContacts,
  deserializeInbox,
  linkInboxMessage,
  normalizeInboxSender,
  receiveInboxMessage,
  routeInboxSender,
  selectInboxMessage,
} from "../src/inbox";

const now = new Date("2026-09-28T04:00:00.000Z");

function incomingPair() {
  const first = receiveInboxMessage([], createDemoIncoming('whatsapp', 'otto', now, 'test-wa')).items;
  return receiveInboxMessage(first, createDemoIncoming('email', 'otto', now, 'test-email')).items;
}

test('fresh inbox is empty and obsolete inbox storage cannot restore test enquiries', () => {
  assert.deepEqual(createSeedInbox(), []);
  assert.equal(deserializeInbox(JSON.stringify({ version: 1, items: incomingPair() })), null);
});

test("explicit demo arrivals produce forwarded enquiries routed to the trader", () => {
  const items = incomingPair();
  assert.equal(items.length, 2);
  assert.deepEqual(new Set(items.map((item) => item.channel)), new Set(["whatsapp", "email"]));
  assert(items.every((item) => item.owner === "otto" && !item.read && item.providerMessageId.startsWith("demo-")));
  assert(items.every((item) => item.rawText.includes("Forwarded") && item.rawText.includes("Buyer:") && item.rawText.includes("LSMGO:")));
  assert(items.find((item) => item.channel === "whatsapp")?.rawText.includes("HSFO: 350-400 MT"));
});

test("inbox sender routing normalizes verified phone and email identities", () => {
  assert.equal(normalizeInboxSender("whatsapp", "+852 0000 0001"), "+85200000001");
  assert.equal(normalizeInboxSender("whatsapp", "0085200000001"), "+85200000001");
  assert.equal(routeInboxSender("whatsapp", "+852 (0000) 0001").owner, "otto");
  assert.equal(routeInboxSender("email", " OTTO@ECOSYSTEM.EXAMPLE ").owner, "otto");
  assert.equal(routeInboxSender("email", "gianmichele+unknown@ecosystem.example").owner, null);
  assert.equal(normalizeInboxSender("email", "Gianmichele <gianmichele@ecosystem.example>"), "");
});

test("unknown, ambiguous and unverified senders never fall back to the active trader", () => {
  const initial = incomingPair();
  const message = createDemoIncoming("whatsapp", "otto", now, "unknown");
  const unknown = receiveInboxMessage(initial, { ...message, sender: "+85211111111" });
  assert.equal(unknown.reason, "unknown-sender");
  assert.strictEqual(unknown.items, initial);
  assert.equal(unknown.received, null);
  const ambiguousContacts = [...demoContacts, { ...demoContacts[0], owner: "elena" }];
  const ambiguous = receiveInboxMessage(initial, message, ambiguousContacts);
  assert.equal(ambiguous.reason, "ambiguous-sender");
  assert.strictEqual(ambiguous.items, initial);
  const unverified = receiveInboxMessage(initial, message, [{ ...demoContacts[0], verified: false }]);
  assert.equal(unverified.reason, "unknown-sender");
});

test("provider message retries do not create duplicate enquiries or alter read state", () => {
  const message = createDemoIncoming("whatsapp", "otto", now, "repeat");
  const first = receiveInboxMessage([], message);
  const read = selectInboxMessage(first.items, message.id, "otto");
  const duplicate = receiveInboxMessage(read.items, { ...message, id: "second-transport-attempt" });
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(duplicate.items.length, 1);
  assert.equal(duplicate.items[0].read, true);
});

test("selection and linking enforce the enquiry owner", () => {
  const items = incomingPair();
  assert.equal(selectInboxMessage(items, items[0].id, "elena").selected, null);
  assert.strictEqual(selectInboxMessage(items, items[0].id, "elena").items, items);
  const denied = linkInboxMessage(items, items[0].id, "enquiry-not-owned", "elena");
  assert.equal(denied[0].enquiryId, undefined);
  const selection = selectInboxMessage(items, items[0].id, "otto");
  assert.equal(selection.selected?.read, true);
  const linked = linkInboxMessage(selection.items, items[0].id, "enquiry-from-inbox", "otto");
  assert.equal(linked[0].enquiryId, "enquiry-from-inbox");
  assert.equal(linked[1].read, false);
});

test("inbox serialization preserves drafts, read state and ownership without reseeding", () => {
  const seeded = incomingPair();
  const linked = linkInboxMessage(seeded, seeded[0].id, "enquiry-saved", "otto");
  assert.deepEqual(deserializeInbox(JSON.stringify({ version: 2, items: linked })), linked);
  assert.deepEqual(deserializeInbox(JSON.stringify({ version: 2, items: [] })), []);
  assert.equal(deserializeInbox("invalid json"), null);
  assert.equal(deserializeInbox(JSON.stringify({ version: 2, items: [{ ...seeded[0], owner: "unknown-person" }] })), null);
  assert.equal(deserializeInbox(JSON.stringify({ version: 2, items: [seeded[0], seeded[0]] })), null);
});

test("demo arrivals use each profile's own mapping", () => {
  for (const { id: owner } of actors.filter(canTrade)) {
    for (const channel of ["whatsapp", "email"] as const) {
      const message = createDemoIncoming(channel, owner, now);
      assert.equal(receiveInboxMessage([], message).received?.owner, owner);
    }
  }
  assert.throws(() => createDemoIncoming("email", "unknown", now), /No verified demo sender/);
});


test("clearing one notification preserves its incoming enquiry and linked record", () => {
  const seeded = incomingPair();
  const linked = linkInboxMessage(seeded, seeded[0].id, "enquiry-preserved", "otto");
  const cleared = dismissInboxNotification(linked, linked[0].id, "otto");
  assert.equal(cleared.length, linked.length);
  assert.equal(cleared[0].dismissed, true);
  assert.equal(cleared[0].enquiryId, "enquiry-preserved");
  assert.equal(cleared[0].rawText, linked[0].rawText);
  assert.equal(cleared[0].read, linked[0].read);
  assert.equal(cleared[1].dismissed, undefined);
  assert.equal(selectInboxMessage(cleared, cleared[0].id, "otto").selected?.enquiryId, "enquiry-preserved");
  const restored = deserializeInbox(JSON.stringify({ version: 2, items: cleared }));
  assert.deepEqual(restored, cleared);
});

test("clear all notifications affects only the current trader and keeps unread enquiry history", () => {
  const seeded = incomingPair();
  const all = receiveInboxMessage(seeded, createDemoIncoming("email", "luca", now, "luca-message")).items;
  const cleared = clearInboxNotifications(all, "otto");
  assert.equal(cleared.length, all.length);
  assert(cleared.filter((item) => item.owner === "otto").every((item) => item.dismissed && !item.read));
  assert.equal(cleared.find((item) => item.owner === "luca")?.dismissed, undefined);
  const denied = dismissInboxNotification(all, seeded[0].id, "elena");
  assert.equal(denied.find((item) => item.id === seeded[0].id)?.dismissed, undefined);
  const newArrival = receiveInboxMessage(cleared, createDemoIncoming("whatsapp", "otto", now, "new-after-clear"));
  assert.equal(newArrival.received?.dismissed, undefined);
  assert.equal(newArrival.items.filter((item) => item.owner === "otto" && !item.dismissed).length, 1);
});

test("notification clearing survives reload and provider retries without reseeding", () => {
  const original = createDemoIncoming("email", "otto", now, "cleared-retry");
  const received = receiveInboxMessage([], original);
  const cleared = clearInboxNotifications(received.items, "otto");
  const restored = deserializeInbox(JSON.stringify({ version: 2, items: cleared }));
  assert.equal(restored?.length, 1);
  assert.equal(restored?.[0].dismissed, true);
  assert.equal(restored?.[0].read, false);
  const retry = receiveInboxMessage(restored!, { ...original, id: "new-transport-id" });
  assert.equal(retry.reason, "duplicate");
  assert.equal(retry.items[0].dismissed, true);
  assert.equal(deserializeInbox(JSON.stringify({ version: 2, items: [{ ...cleared[0], dismissed: "true" }] })), null);
});

test('admin and credit profiles cannot create or receive a trading inbox enquiry', () => {
  const items = incomingPair();
  const snapshot = structuredClone(items);
  for (const actor of actors.filter(actor => !canTrade(actor))) {
    for (const channel of ['whatsapp', 'email'] as const) {
      assert.throws(() => createDemoIncoming(channel, actor.id, now), /cannot receive trading enquiries/);
      const contact = demoContacts.find(item => item.owner === actor.id)!;
      const sender = channel === 'whatsapp' ? contact.phone : contact.email;
      assert.deepEqual(routeInboxSender(channel, sender), { owner: null, reason: 'non-trading-owner' });
      const message = { ...createDemoIncoming(channel, 'otto', now, `wrong-role-${actor.id}-${channel}`), sender };
      const received = receiveInboxMessage(items, message);
      assert.equal(received.received, null);
      assert.equal(received.reason, 'non-trading-owner');
      assert.strictEqual(received.items, items);
    }
  }
  assert.deepEqual(items, snapshot);
});

test('legacy Guido inbox messages keep their original ownership and content but are not selectable trading work', () => {
  const traderItems = incomingPair();
  const legacy = { ...traderItems[0], id: 'legacy-guido-message', providerMessageId: 'demo-email-legacy-guido', sender: 'guido@ecosystem.example', owner: 'marco', enquiryId: 'legacy-guido-enquiry' };
  const stored = [legacy, ...traderItems];
  const restored = deserializeInbox(JSON.stringify({ version: 2, items: stored }))!;
  assert.deepEqual(restored, stored, 'Legacy admin messages must never be deleted or reassigned.');
  assert.deepEqual(actionableInboxItems(restored, 'marco'), []);
  assert.deepEqual(actionableInboxItems(restored, 'elena'), []);
  assert.deepEqual(actionableInboxItems(restored, 'unknown'), []);
  assert.deepEqual(actionableInboxItems(restored, 'otto'), traderItems);
  const selection = selectInboxMessage(restored, legacy.id, 'marco');
  assert.equal(selection.selected, null);
  assert.strictEqual(selection.items, restored);
  assert.strictEqual(linkInboxMessage(restored, legacy.id, 'different-enquiry', 'marco'), restored);
  assert.deepEqual(deserializeInbox(JSON.stringify({ version: 2, items: restored })), stored);
  assert.equal(selectInboxMessage(restored, traderItems[0].id, 'otto').selected?.owner, 'otto');
});

test('a non-trading contact collision never redirects an enquiry to another matching trading profile', () => {
  const contacts = [...demoContacts, { ...demoContacts.find(item => item.owner === 'marco')!, phone: demoContacts[0].phone }];
  const message = createDemoIncoming('whatsapp', 'otto', now, 'role-collision');
  assert.equal(receiveInboxMessage([], message, contacts).reason, 'ambiguous-sender');
  assert.equal(receiveInboxMessage([], message, contacts).received, null);
});
