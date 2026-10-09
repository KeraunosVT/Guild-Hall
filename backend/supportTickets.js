// backend/supportTickets.js — Support tickets in Guild Hall's own Discord server.
//
// Platform support, not a tenant feature: it answers in ONE server (the HQ),
// and only there. Every other server's clicks never reach it, and tenants
// never see its command (it is registered to the HQ only, not globally).
//
// A ticket is a private channel under one category. Nothing is stored in the
// database: the channel's topic records who opened it and what kind it is, so
// a restart, a redeploy or a second process all see the same open tickets.
//
//   /ticketpanel            staff post the panel (embed + one button per type)
//   ticket:open:<type>      a member picks a type → a short form (modal)
//   ticket:modal:<type>     the form is sent → the channel is created
//   ticket:close            opener or staff → asks to confirm
//   ticket:confirm          transcript to the log channel (and the opener), then delete
const {
  SlashCommandBuilder, MessageFlags, ChannelType, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, AttachmentBuilder,
} = require('discord.js');

const BRAND = 0xd64545;
const TOPIC_PREFIX = 'gh-ticket';

// The panel's buttons, in order. `intro` is what the ticket opens with, so a
// member who wrote one line still sees what staff will need from them.
const TYPES = [
  {
    id: 'billing', label: 'Billing & refunds', emoji: '💳',
    blurb: 'charges, cancelling, refunds (14 days from any payment)',
    intro: 'Thanks for reaching out about billing. If you haven\'t already, please add:\n'
      + '• your guild\'s name and Discord server ID\n'
      + '• the **email you used at checkout** (it\'s on your Paddle receipt)\n\n'
      + 'Want a refund right away? You can request one yourself at **paddle.net** with that email. '
      + 'Payments are handled by Paddle, our reseller.',
  },
  {
    id: 'setup', label: 'Setup help', emoji: '🛠️',
    blurb: 'adding your guild, the bot, roles and permissions',
    intro: 'Let\'s get your guild running. If you haven\'t already, tell us which setup step you\'re on '
      + '(sign in → pay → add bot → basics), your Discord server ID, and any error message — a screenshot is great.',
  },
  {
    id: 'bug', label: 'Bug report', emoji: '🐛',
    blurb: 'something\'s broken or wrong',
    intro: 'Thanks for the report! A screenshot, the page or slash command it happened on, '
      + 'and roughly when it happened will help us track it down.',
  },
  {
    id: 'mercs', label: 'Mercs / Threat Board', emoji: '⚔️',
    blurb: 'reports, leader verification, guild ratings',
    intro: 'Got it. Names and screenshots help — for a Threat Board correction, '
      + 'say which guild and cluster, and what should change.',
  },
];
const typeById = (id) => TYPES.find((t) => t.id === id) || null;

// ── Pure helpers (exported for tests) ───────────────────────────────────────

// "gh-ticket:<opener id>:<type>". Anything else is not one of our tickets — so
// the close button can't be used to delete an ordinary channel it was pasted into.
function makeTopic(openerId, typeId) {
  return `${TOPIC_PREFIX}:${openerId}:${typeId}`;
}
function parseTopic(topic) {
  const m = /^gh-ticket:(\d{5,25}):([a-z]+)$/.exec(String(topic || '').trim());
  if (!m || !typeById(m[2])) return null;
  return { openerId: m[1], type: m[2] };
}

// "billing-keraunos". Discord lowercases channel names and drops most
// punctuation; doing it here means the name we pick is the name that sticks.
function channelName(typeId, username) {
  const who = String(username || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, 30) || 'member';
  return `${typeId}-${who}`;
}

// A plain-text record of the channel, oldest first. `messages` is anything with
// the fields a discord.js Message has, so a test can pass plain objects.
function buildTranscript(messages, { channelName: name, openerTag, type, closedBy } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const when = (d) => {
    const t = new Date(d);
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} UTC`;
  };
  const lines = [
    `Guild Hall support ticket #${name || '?'}`,
    `Type: ${type || '?'} · Opened by: ${openerTag || '?'} · Closed by: ${closedBy || '?'}`,
    '',
  ];
  const sorted = [...messages].sort((a, b) => new Date(a.createdTimestamp) - new Date(b.createdTimestamp));
  for (const m of sorted) {
    const author = (m.author && (m.author.globalName || m.author.username)) || 'unknown';
    const parts = [];
    if (m.content) parts.push(m.content);
    for (const e of m.embeds || []) {
      const text = [e.title, e.description].filter(Boolean).join(' — ');
      if (text) parts.push(`[embed] ${text}`);
      for (const f of e.fields || []) parts.push(`[embed] ${f.name}: ${f.value}`);
    }
    const files = m.attachments ? [...(m.attachments.values ? m.attachments.values() : m.attachments)] : [];
    for (const a of files) parts.push(`[file] ${a.url}`);
    // Empty for other people's messages when the bot lacks the Message Content
    // intent — say so rather than leave a line that looks like they said nothing.
    if (!parts.length) parts.push('(no text visible to the bot)');
    lines.push(`[${when(m.createdTimestamp)}] ${author}: ${parts.join('\n    ')}`);
  }
  return lines.join('\n') + '\n';
}

// ── The handler ─────────────────────────────────────────────────────────────

function createSupportTickets({ guildId, categoryId, supportRoleId, logChannelId } = {}) {
  if (!guildId || !categoryId) return null; // not configured: no command, no handling

  // A double-clicked submit must not open two channels.
  const opening = new Set();
  const client = (interaction) => interaction.client;

  const isStaff = (member) => Boolean(member && (
    (supportRoleId && member.roles && member.roles.cache && member.roles.cache.has(String(supportRoleId)))
    || (member.permissions && member.permissions.has && member.permissions.has(PermissionFlagsBits.ManageGuild))
  ));

  const panelCommand = new SlashCommandBuilder()
    .setName('ticketpanel')
    .setDescription('Staff: post the support ticket panel in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false);

  function owns(interaction) {
    if (!interaction || String(interaction.guildId || '') !== String(guildId)) return false;
    if (interaction.isChatInputCommand && interaction.isChatInputCommand()) return interaction.commandName === 'ticketpanel';
    if ((interaction.isButton && interaction.isButton()) || (interaction.isModalSubmit && interaction.isModalSubmit())) {
      return String(interaction.customId || '').startsWith('ticket:');
    }
    return false;
  }

  async function handle(interaction) {
    try {
      if (interaction.isChatInputCommand()) return await postPanel(interaction);
      const [, action, type] = interaction.customId.split(':');
      if (interaction.isButton() && action === 'open') return await showForm(interaction, type);
      if (interaction.isModalSubmit() && action === 'modal') return await openTicket(interaction, type);
      if (interaction.isButton() && action === 'close') return await askToClose(interaction);
      if (interaction.isButton() && action === 'confirm') return await closeTicket(interaction);
    } catch (err) {
      console.error('support ticket error:', err.message);
      const msg = { content: 'Something went wrong with that ticket action. Please try again, or ping staff.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg.content).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
  }

  async function postPanel(interaction) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: 'Only staff can post the ticket panel.', flags: MessageFlags.Ephemeral });
    }
    const embed = new EmbedBuilder()
      .setColor(BRAND)
      .setTitle('Guild Hall Support')
      .setDescription([
        'Need a hand? Open a ticket below and we\'ll get back to you in a private channel.',
        '',
        ...TYPES.map((t) => `${t.emoji} **${t.label}** — ${t.blurb}`),
        '',
        'Please don\'t post card details or passwords in a ticket. We\'ll never ask for them.',
      ].join('\n'));
    const row = new ActionRowBuilder().addComponents(TYPES.map((t) => new ButtonBuilder()
      .setCustomId(`ticket:open:${t.id}`).setLabel(t.label).setEmoji(t.emoji).setStyle(ButtonStyle.Secondary)));
    await interaction.channel.send({ embeds: [embed], components: [row] });
    return interaction.reply({ content: 'Ticket panel posted.', flags: MessageFlags.Ephemeral });
  }

  // The open ticket this member already has, if any — one at a time each.
  function existingTicket(guild, userId) {
    return guild.channels.cache.find((ch) => ch.parentId === String(categoryId)
      && (parseTopic(ch.topic) || {}).openerId === String(userId)) || null;
  }

  async function showForm(interaction, typeId) {
    const t = typeById(typeId);
    if (!t) return interaction.reply({ content: 'That ticket type no longer exists.', flags: MessageFlags.Ephemeral });
    const open = existingTicket(interaction.guild, interaction.user.id);
    if (open) {
      return interaction.reply({ content: `You already have an open ticket: <#${open.id}>`, flags: MessageFlags.Ephemeral });
    }
    const modal = new ModalBuilder().setCustomId(`ticket:modal:${t.id}`).setTitle(`${t.label}`.slice(0, 45));
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('guild').setLabel('Your guild (name or Discord server ID)')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('details').setLabel('How can we help?')
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(5).setMaxLength(1500)),
    );
    return interaction.showModal(modal);
  }

  async function openTicket(interaction, typeId) {
    const t = typeById(typeId);
    if (!t) return interaction.reply({ content: 'That ticket type no longer exists.', flags: MessageFlags.Ephemeral });
    const uid = interaction.user.id;
    if (opening.has(uid)) return interaction.reply({ content: 'Your ticket is already being opened…', flags: MessageFlags.Ephemeral });
    opening.add(uid);
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guild = interaction.guild;
      const open = existingTicket(guild, uid);
      if (open) return interaction.editReply(`You already have an open ticket: <#${open.id}>`);

      const allowMember = [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks,
      ];
      const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: uid, allow: allowMember },
        { id: client(interaction).user.id, allow: [...allowMember, PermissionFlagsBits.ManageChannels] },
      ];
      if (supportRoleId) {
        overwrites.push({ id: String(supportRoleId), allow: [...allowMember, PermissionFlagsBits.ManageMessages] });
      }
      const channel = await guild.channels.create({
        name: channelName(t.id, interaction.user.username),
        type: ChannelType.GuildText,
        parent: String(categoryId),
        topic: makeTopic(uid, t.id),
        permissionOverwrites: overwrites,
        reason: `Support ticket opened by ${interaction.user.username}`,
      });

      const guildField = interaction.fields.getTextInputValue('guild').trim();
      const details = interaction.fields.getTextInputValue('details').trim();
      const embed = new EmbedBuilder()
        .setColor(BRAND)
        .setTitle(`${t.emoji} ${t.label}`)
        .setDescription(t.intro)
        .addFields(
          ...(guildField ? [{ name: 'Guild', value: guildField.slice(0, 1024) }] : []),
          { name: 'Details', value: details.slice(0, 1024) },
        )
        .setFooter({ text: 'Staff will reply here. Press Close ticket when you\'re sorted.' });
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId('ticket:close').setLabel('Close ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger));
      await channel.send({
        content: `<@${uid}>${supportRoleId ? ` <@&${supportRoleId}>` : ''}`,
        embeds: [embed],
        components: [row],
        allowedMentions: { users: [uid], roles: supportRoleId ? [String(supportRoleId)] : [] },
      });
      return interaction.editReply(`Your ticket is open: <#${channel.id}>`);
    } finally {
      opening.delete(uid);
    }
  }

  // Only the person who opened it, or staff, may close a ticket.
  function closeCheck(interaction) {
    const ticket = parseTopic(interaction.channel && interaction.channel.topic);
    if (!ticket || interaction.channel.parentId !== String(categoryId)) {
      return { error: 'This isn\'t an open ticket channel.' };
    }
    if (interaction.user.id !== ticket.openerId && !isStaff(interaction.member)) {
      return { error: 'Only the person who opened this ticket, or staff, can close it.' };
    }
    return { ticket };
  }

  async function askToClose(interaction) {
    const { error } = closeCheck(interaction);
    if (error) return interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId('ticket:confirm').setLabel('Yes, close it').setStyle(ButtonStyle.Danger));
    return interaction.reply({
      content: 'Close this ticket? The channel is deleted and a transcript is saved.',
      components: [row], flags: MessageFlags.Ephemeral,
    });
  }

  async function fetchAll(channel, limit = 1000) {
    const out = [];
    let before;
    while (out.length < limit) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!batch.size) break;
      out.push(...batch.values());
      before = batch.last().id;
      if (batch.size < 100) break;
    }
    return out;
  }

  async function closeTicket(interaction) {
    const { error, ticket } = closeCheck(interaction);
    if (error) return interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = interaction.channel;
    const t = typeById(ticket.type);
    const opener = await client(interaction).users.fetch(ticket.openerId).catch(() => null);
    const openerTag = opener ? `${opener.username} (${opener.id})` : ticket.openerId;
    const closedBy = `${interaction.user.username} (${interaction.user.id})`;

    const text = buildTranscript(await fetchAll(channel), {
      channelName: channel.name, openerTag, type: t ? t.label : ticket.type, closedBy,
    });
    const file = () => new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `${channel.name}.txt` });

    if (logChannelId) {
      const log = await client(interaction).channels.fetch(String(logChannelId)).catch(() => null);
      if (log && log.isTextBased()) {
        await log.send({
          content: `🔒 Ticket **#${channel.name}** (${t ? t.label : ticket.type}) closed. Opened by ${openerTag}, closed by ${closedBy}.`,
          files: [file()],
          allowedMentions: { parse: [] },
        }).catch((err) => console.error('ticket transcript post failed:', err.message));
      } else {
        console.error(`support tickets: log channel ${logChannelId} is not a text channel the bot can see.`);
      }
    }
    // The opener's own copy. Best-effort: their DMs may be closed.
    if (opener) {
      await opener.send({ content: `Your Guild Hall support ticket **#${channel.name}** was closed. Here's a copy of the conversation.`, files: [file()] })
        .catch(() => {});
    }

    await interaction.editReply('Closing…').catch(() => {});
    await channel.delete(`Ticket closed by ${interaction.user.username}`);
  }

  return {
    guildId: String(guildId),
    commands: [panelCommand.toJSON()],
    owns,
    handle,
  };
}

module.exports = createSupportTickets;
module.exports.TYPES = TYPES;
module.exports.makeTopic = makeTopic;
module.exports.parseTopic = parseTopic;
module.exports.channelName = channelName;
module.exports.buildTranscript = buildTranscript;
