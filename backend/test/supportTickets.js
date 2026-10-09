// ============================================================================
// Support tickets: the HQ server's ticket channels, without Discord
// ============================================================================
// The things worth holding are the ones that go wrong quietly: a ticket
// interaction from a TENANT's server being claimed (it runs before tenant
// resolution), the close button deleting a channel that isn't a ticket, and
// someone other than the opener or staff closing a ticket.
//
// Run:  node test/supportTickets.js       (from backend/)
const { PermissionFlagsBits } = require('discord.js');
const createSupportTickets = require('../supportTickets');
const { makeTopic, parseTopic, channelName, buildTranscript } = createSupportTickets;

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + label.padEnd(60) + detail);
  ok ? pass++ : fail++;
};

const HQ = '100000000000000001';
const OTHER = '200000000000000002';
const CATEGORY = '300000000000000003';
const ROLE = '400000000000000004';
const OPENER = '500000000000000005';
const STRANGER = '600000000000000006';

(async () => {
  console.log('\n1. topics and names');
  check('a topic round-trips', JSON.stringify(parseTopic(makeTopic(OPENER, 'billing'))) === JSON.stringify({ openerId: OPENER, type: 'billing' }));
  check('an ordinary topic is not a ticket', parseTopic('General chat, be nice') === null);
  check('an unknown type is not a ticket', parseTopic(`gh-ticket:${OPENER}:refundz`) === null);
  check('an empty topic is not a ticket', parseTopic(null) === null);
  check('names are lowercased and stripped', channelName('bug', 'Kéraunos.VT!') === 'bug-kraunosvt');
  check('an all-symbol name still gets one', channelName('setup', '✨✨') === 'setup-member');

  console.log('\n2. transcript');
  const t = buildTranscript([
    { createdTimestamp: Date.UTC(2026, 9, 8, 14, 5), author: { username: 'staff' }, content: 'Refund sent.', embeds: [], attachments: [] },
    { createdTimestamp: Date.UTC(2026, 9, 8, 14, 0), author: { username: 'buyer' }, content: '', embeds: [], attachments: [] },
    { createdTimestamp: Date.UTC(2026, 9, 8, 13, 59), author: { username: 'bot' }, content: '', embeds: [{ title: 'Billing', description: 'Thanks', fields: [{ name: 'Details', value: 'double charged' }] }], attachments: [{ url: 'https://cdn/x.png' }] },
  ], { channelName: 'billing-buyer', openerTag: 'buyer (1)', type: 'Billing & refunds', closedBy: 'staff (2)' });
  check('oldest message first', t.indexOf('13:59') < t.indexOf('14:00') && t.indexOf('14:00') < t.indexOf('14:05'));
  check('embed text and fields are kept', /\[embed\] Billing — Thanks/.test(t) && /Details: double charged/.test(t));
  check('attachments are listed', t.includes('[file] https://cdn/x.png'));
  check('hidden content is said, not blank', t.includes('buyer: (no text visible to the bot)'));

  console.log('\n3. configuration');
  check('no category: tickets are off', createSupportTickets({ guildId: HQ }) === null);
  check('no server: tickets are off', createSupportTickets({ categoryId: CATEGORY }) === null);
  const tickets = createSupportTickets({ guildId: HQ, categoryId: CATEGORY, supportRoleId: ROLE });
  check('the panel command is registered to the HQ only', tickets.guildId === HQ && tickets.commands[0].name === 'ticketpanel');

  console.log('\n4. only the HQ server is ever claimed');
  const button = (guildId, customId) => ({
    guildId, customId,
    isChatInputCommand: () => false, isButton: () => true, isModalSubmit: () => false,
  });
  check('an HQ ticket button is claimed', tickets.owns(button(HQ, 'ticket:open:bug')));
  check('the same button from a tenant server is not', !tickets.owns(button(OTHER, 'ticket:open:bug')));
  check('another HQ button is not', !tickets.owns(button(HQ, 'signup:join:abc')));
  check('a DM is not', !tickets.owns(button(null, 'ticket:close')));
  const cmd = (guildId, commandName) => ({ guildId, commandName, isChatInputCommand: () => true });
  check('/ticketpanel in the HQ is claimed', tickets.owns(cmd(HQ, 'ticketpanel')));
  check('/loa in the HQ is left to the tenant path', !tickets.owns(cmd(HQ, 'loa')));

  console.log('\n5. who can close');
  const closeClick = ({ userId, roles = [], manageGuild = false, topic = makeTopic(OPENER, 'bug'), parentId = CATEGORY }) => {
    const replies = [];
    let deleted = false;
    const i = {
      ...button(HQ, 'ticket:close'),
      user: { id: userId, username: 'u' },
      member: {
        roles: { cache: new Map(roles.map((r) => [r, true])) },
        permissions: { has: (p) => manageGuild && p === PermissionFlagsBits.ManageGuild },
      },
      channel: { topic, parentId, name: 'bug-x', delete: async () => { deleted = true; } },
      reply: async (m) => { replies.push(m); },
    };
    return { i, replies, wasDeleted: () => deleted };
  };
  let c = closeClick({ userId: OPENER });
  await tickets.handle(c.i);
  check('the opener is asked to confirm', c.replies[0] && Array.isArray(c.replies[0].components) && c.replies[0].components.length === 1);
  c = closeClick({ userId: STRANGER, roles: [ROLE] });
  await tickets.handle(c.i);
  check('staff (support role) are asked to confirm', c.replies[0] && c.replies[0].components);
  c = closeClick({ userId: STRANGER, manageGuild: true });
  await tickets.handle(c.i);
  check('a server manager is asked to confirm', c.replies[0] && c.replies[0].components);
  c = closeClick({ userId: STRANGER });
  await tickets.handle(c.i);
  check('anyone else is refused', c.replies[0] && /Only the person/.test(c.replies[0].content) && !c.replies[0].components);
  c = closeClick({ userId: OPENER, topic: 'just a channel' });
  c.i.customId = 'ticket:confirm';
  await tickets.handle(c.i);
  check('confirm in a non-ticket channel deletes nothing', /isn't an open ticket/.test(c.replies[0].content) && !c.wasDeleted());
  c = closeClick({ userId: OPENER, parentId: '999' });
  c.i.customId = 'ticket:confirm';
  await tickets.handle(c.i);
  check('a ticket topic outside the category deletes nothing', /isn't an open ticket/.test(c.replies[0].content) && !c.wasDeleted());

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
