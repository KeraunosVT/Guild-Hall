// backend/discordGateway.js — Lightweight discord.js gateway client.
// Maintains a WebSocket connection so we can read voice-channel state (which the
// REST API does not expose), and handles the guild's slash commands.
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, MessageFlags, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const createEliteTimers = require('./eliteTimers');
const createLoa = require('./loa');
const createIdentities = require('./identities');
const createAttendance = require('./attendance');
const createEventSignups = require('./eventSignups');
const guildRegistry = require('./guildRegistry');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
// ── Per-guild config, from interaction.guildHall only ───────────────────────
// One bot serves many servers, so nothing here may be decided at import time.
// There is no env fallback: a channel or role list left empty on a guilds row
// used to resolve to the deployment's own values, which meant one guild's LOA
// posts landing in another guild's channel, and one guild's officers holding
// officer powers inside another guild. An unconfigured guild gets nothing and
// is told so (plan tasks 8 and 9).
const loaChannelOf = (g) => (g && g.loa_channel_id) || '';
const announceChannelOf = (g) => (g && g.announce_channel_id) || '';
// Signups fall back to the announce channel, so a guild that never configures
// one still gets working posts in the place it already talks about events.
// Deliberately a guilds column and not an env var: one deployment serves many
// guilds, and an env fallback would drop every tenant's signups into whichever
// channel the deployment happened to name (see test/leakAudit.js check 5).
const signupChannelOf = (g) => (g && g.signup_channel_id) || announceChannelOf(g);
const adminRolesOf = (g) => (Array.isArray(g && g.admin_role_ids)
  ? g.admin_role_ids.map(String).filter(Boolean) : []);
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// "21:00" -> "9:00 PM", for echoing a recurring LOA's start time back in chat.
function fmt12h(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// Resolves a freeform time like "9:30pm", "930pm", "2130" or "930et" to the UTC
// instant it occurs today in the guild's timezone, for the /announce command.
// Strips a trailing ET/EST/EDT (redundant — the guild only operates in one zone)
// and expands compact digit shorthand ("930" -> "9:30") before handing off to
// loa.js's am/pm resolution — bare digits with no am/pm are read as 24-hour,
// same convention used everywhere else in this file, so the confirmation
// message always echoes the resolved time back for the officer to sanity-check.
function parseAnnounceTime(input, timeZone) {
  let s = String(input || '').trim().replace(/\s*(et|est|edt)$/i, '').trim();
  const compact = /^(\d{1,2})(\d{2})\s*([ap]\.?m\.?)?$/i.exec(s);
  if (compact) s = `${compact[1]}:${compact[2]}${compact[3] ? ` ${compact[3]}` : ''}`;

  const hhmm = createLoa.parseTimeOfDay(s);
  if (!hhmm) return null;
  const [hour, minute] = hhmm.split(':').map(Number);
  return createEliteTimers.guildTimeToday(hour, minute, timeZone);
}

let client = null;
let ready = false;
let eliteTimers = null;
let loa = null;
let identities = null;
let attendance = null;
let signups = null;
// Kept so handleInteraction can resolve the tenant registry per interaction;
// the modules above are built once at boot and no longer carry a guild.
let db = null;

// Wire the data modules. Separated from connecting to Discord so the
// interaction path can be exercised without a gateway connection — see the test
// seam at the bottom of this file.
function wireModules(supabase) {
  db = supabase;
  eliteTimers = supabase ? createEliteTimers(supabase) : null;
  // identities BEFORE loa: loa takes it so LOA names resolve to the site alias
  // rather than the Discord username. Built the other way round it would have
  // received `null` and silently fallen back — the LOA would still save, it
  // would just show the wrong name, which is the hardest kind of wrong to spot.
  identities = supabase ? createIdentities(supabase) : null;
  loa = supabase ? createLoa(supabase, identities) : null;
  attendance = supabase ? createAttendance(supabase) : null;
  signups = supabase ? createEventSignups(supabase, identities) : null;
}

function start(supabase) {
  db = supabase;
  // The token alone is enough now: which servers the bot serves comes from the
  // registry as interactions arrive, not from env.
  if (!BOT_TOKEN) {
    console.warn('⚠️  Discord gateway disabled — DISCORD_BOT_TOKEN missing.');
    return;
  }

  wireModules(supabase);

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.once('clientReady', async () => {
    ready = true;
    console.log('✅ Discord gateway connected');
    // /announce has no supabase dependency, so commands are always (re)registered
    // once the bot connects, regardless of which optional modules are configured.
    await registerCommands();
    startSignupSweep();
  });

  client.on('interactionCreate', handleInteraction);

  client.on('error', (err) => console.error('Discord gateway error:', err.message));

  client.login(BOT_TOKEN).catch((err) => {
    console.error('❌ Discord gateway login failed:', err.message);
  });
}

// The connected Discord server, by id. Takes the id rather than closing over
// one: the bot is in every tenant's server, and picking the wrong cache entry
// would post one guild's LOA or announcement into another's channel.
function getGuild(discordGuildId) {
  if (!ready || !client) return null;
  const id = String(discordGuildId || '');
  return (id && client.guilds.cache.get(id)) || null;
}

// ── /elitetimer, /elitetimers, /loa ──────────────────────────────────────────
async function registerCommands() {
  if (!CLIENT_ID) {
    console.warn('⚠️  DISCORD_CLIENT_ID missing — commands were not registered.');
    return;
  }
  const commands = [];

  if (eliteTimers) {
    const reportCommand = new SlashCommandBuilder()
      .setName('elitetimer')
      .setDescription('Report an elite boss kill and start its respawn timer.')
      .addStringOption((opt) =>
        opt.setName('location').setDescription('Where it was killed').setRequired(true)
          .addChoices(...eliteTimers.locations.map((name) => ({ name, value: name })))
      )
      .addStringOption((opt) =>
        opt.setName('time').setDescription('Kill time, e.g. 6:40pm').setRequired(true)
      );

    const listCommand = new SlashCommandBuilder()
      .setName('elitetimers')
      .setDescription('Show the current respawn status of all elite bosses.');

    commands.push(reportCommand.toJSON(), listCommand.toJSON());
  }

  if (loa) {
    const loaCommand = new SlashCommandBuilder()
      .setName('loa')
      .setDescription('Manage your leave of absence.')
      .addSubcommand((sub) =>
        sub.setName('event')
          .setDescription('Request LOA for a single date — one event, or everything from a time onward.')
          .addStringOption((opt) => opt.setName('date').setDescription('Event date, YYYY-MM-DD').setRequired(true))
          .addStringOption((opt) => opt.setName('reason').setDescription('Visible to officers only').setRequired(true))
          .addStringOption((opt) => opt.setName('event').setDescription('Which event (leave blank + set a start time for "everything after X")').setRequired(false).setAutocomplete(true))
          .addStringOption((opt) => opt.setName('start_time').setDescription('Absent from this time onward, e.g. 9:00 PM (blank = just the picked event)').setRequired(false))
          .addStringOption((opt) => opt.setName('end_time').setDescription('Back after this time, e.g. 10:00 PM (blank = out for the rest of the day)').setRequired(false))
          .addUserOption((opt) => opt.setName('member').setDescription('Officers only: submit on behalf of this member').setRequired(false))
      )
      .addSubcommand((sub) =>
        sub.setName('range')
          .setDescription('Request LOA for a date range.')
          .addStringOption((opt) => opt.setName('start_date').setDescription('Start date, YYYY-MM-DD').setRequired(true))
          .addStringOption((opt) => opt.setName('end_date').setDescription('End date, YYYY-MM-DD').setRequired(true))
          .addStringOption((opt) => opt.setName('reason').setDescription('Visible to officers only').setRequired(true))
          .addUserOption((opt) => opt.setName('member').setDescription('Officers only: submit on behalf of this member').setRequired(false))
      )
      .addSubcommand((sub) =>
        sub.setName('recurring')
          .setDescription('Always out on the same day every week, until cancelled.')
          .addStringOption((opt) => opt.setName('day').setDescription('Day of the week').setRequired(true)
            .addChoices(...DAY_NAMES.map((name, value) => ({ name, value: String(value) }))))
          .addStringOption((opt) => opt.setName('reason').setDescription('Visible to officers only').setRequired(true))
          .addStringOption((opt) => opt.setName('event').setDescription('Leave blank for the whole day').setRequired(false).setAutocomplete(true))
          .addStringOption((opt) => opt.setName('start_time').setDescription('Absent from this time onward, e.g. 9:00 PM (blank = all day)').setRequired(false))
          .addStringOption((opt) => opt.setName('end_time').setDescription('Back after this time, e.g. 10:00 PM (blank = out for the rest of the day)').setRequired(false))
          .addUserOption((opt) => opt.setName('member').setDescription('Officers only: submit on behalf of this member').setRequired(false))
      )
      .addSubcommand((sub) =>
        sub.setName('cancel')
          .setDescription('Cancel one of your upcoming LOAs (officers: anyone’s).')
          .addStringOption((opt) => opt.setName('entry').setDescription('Which LOA to cancel').setRequired(true).setAutocomplete(true))
      );

    commands.push(loaCommand.toJSON());
  }

  if (attendance) {
    const attendanceCommand = new SlashCommandBuilder()
      .setName('attendance')
      .setDescription('Officers: snap a voice channel and log attendance for a scheduled event.')
      .addStringOption((opt) =>
        opt.setName('event').setDescription('Which scheduled event').setRequired(true).setAutocomplete(true)
      )
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Voice channel to snap (defaults to your current voice channel)')
          .addChannelTypes(ChannelType.GuildVoice).setRequired(false)
      )
      .addStringOption((opt) =>
        opt.setName('date').setDescription('Event date, YYYY-MM-DD (defaults to today)').setRequired(false)
      );

    commands.push(attendanceCommand.toJSON());
  }

  // No supabase dependency — this just posts a message, so it's always available
  // once the bot itself is running (missing channel/role config is reported at
  // run time instead of skipping registration).
  const announceCommand = new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Officers: post a timed announcement (e.g. "get into CTA Comms") with a dynamic timestamp.')
    .addStringOption((opt) =>
      opt.setName('time').setDescription('e.g. 9:30pm, 930pm, 2130').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('message').setDescription('Use {time} to place the time inline, e.g. "roll call {time} in CTA comms"').setRequired(false)
    )
    .addRoleOption((opt) =>
      opt.setName('role').setDescription('Role to ping (optional)').setRequired(false)
    );
  commands.push(announceCommand.toJSON());

  try {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    // GLOBAL, not per-guild (plan task 12). Guild-scoped registration publishes
    // the commands to one server only, so every other tenant's members would
    // see nothing. Global commands appear everywhere the bot is, and
    // resolveTenant() is what decides whether a given server may use them.
    // Trade-off: global registration can take up to an hour to propagate,
    // where guild-scoped was instant.
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log(`✅ Registered ${commands.length} global slash command(s)`);
  } catch (err) {
    console.error('❌ Failed to register commands:', err.message);
  }
}

// FIRST THING, ALWAYS: resolve which tenant this interaction belongs to.
//
// This is plan task 12. Every handler below reads interaction.guildHall.id to
// scope its queries, so resolution has to happen before any of them run and has
// to fail closed — an unregistered or suspended server gets a refusal, never a
// fallback guild. Attaching the row to the interaction keeps the ~15 handlers
// from each having to look it up (and from each being a place to forget).
async function resolveTenant(interaction) {
  if (!interaction.guildId) return null;         // DMs have no guild
  const row = await guildRegistry.resolveByDiscordId(db, interaction.guildId);
  if (row) interaction.guildHall = row;
  return row;
}

async function handleInteraction(interaction) {
  const tenant = await resolveTenant(interaction);
  if (!tenant) {
    // Autocomplete cannot show an error, so return an empty list; a command or
    // a button press gets a plain explanation. Either way nothing downstream
    // runs unscoped. Buttons are included because a signup post outlives any
    // one process — the message is still sitting there, and someone clicking it
    // after a server is deregistered deserves an answer rather than silence.
    if (interaction.isAutocomplete()) return interaction.respond([]).catch(() => {});
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
    return interaction.reply({
      content: 'This server is not registered with Guild Hall (or its access is suspended).',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  if (interaction.isAutocomplete()) return handleAutocomplete(interaction);
  if (interaction.isButton()) return handleButton(interaction);
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'elitetimer') return handleReport(interaction);
  if (interaction.commandName === 'elitetimers') return handleList(interaction);
  if (interaction.commandName === 'loa') return handleLoa(interaction);
  if (interaction.commandName === 'attendance') return handleAttendance(interaction);
  if (interaction.commandName === 'announce') return handleAnnounce(interaction);
}

async function handleReport(interaction) {
  // Ack immediately — Discord requires a response within 3s, and the Supabase
  // round-trip below can occasionally be slower than that. Deferring buys 15 minutes.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!eliteTimers) {
    return interaction.editReply('Elite timers are not configured right now.');
  }

  const location = interaction.options.getString('location');
  const timeInput = interaction.options.getString('time');
  const killedAt = eliteTimers.parseGuildTimeToday(timeInput, interaction.guildHall.timezone);
  if (!killedAt) {
    return interaction.editReply(`Couldn't understand "${timeInput}" as a time. Try something like \`6:40pm\`.`);
  }

  try {
    const row = await eliteTimers.report(interaction.guildHall.id, location, killedAt, interaction.user.username);
    const killedUnix = Math.floor(new Date(row.killed_at).getTime() / 1000);
    const spawnUnix = Math.floor(new Date(row.next_spawn_at).getTime() / 1000);
    // Edit the ephemeral placeholder to a quiet confirmation, then post the actual
    // timer info as a normal public follow-up — deleting the placeholder first caused
    // a "message could not be loaded" flash in Discord's client.
    await interaction.editReply('Recorded ✅');
    await interaction.followUp(
      `**${location}** killed at <t:${killedUnix}:t> — next spawn <t:${spawnUnix}:F> (<t:${spawnUnix}:R>).`
    );
  } catch (err) {
    console.error('elitetimer command error:', err.message);
    await interaction.editReply('Something went wrong saving that timer.');
  }
}

async function handleList(interaction) {
  await interaction.deferReply();

  if (!eliteTimers) {
    return interaction.editReply('Elite timers are not configured right now.');
  }

  try {
    const rows = await eliteTimers.all(interaction.guildHall.id);
    const byLocation = Object.fromEntries(rows.map((r) => [r.location, r]));
    const now = Date.now();
    const lines = eliteTimers.locations.map((loc) => {
      const row = byLocation[loc];
      if (!row) return `**${loc}** — no report yet`;
      const spawnUnix = Math.floor(new Date(row.next_spawn_at).getTime() / 1000);
      if (new Date(row.next_spawn_at).getTime() > now) {
        return `**${loc}** — spawns <t:${spawnUnix}:R> (<t:${spawnUnix}:t>)`;
      }
      return `**${loc}** — spawn window open (last reported <t:${spawnUnix}:R>)`;
    });
    await interaction.editReply(lines.join('\n'));
  } catch (err) {
    console.error('elitetimers command error:', err.message);
    await interaction.editReply('Something went wrong reading the timers.');
  }
}

// ── /loa ──────────────────────────────────────────────────────────────────
// Matches the display name website logins use (see auth.js) rather than the
// guild nickname, so the same member shows up the same way in both places.
function displayNameFor(user) {
  return user.globalName || user.username || 'Member';
}

// Officer check, against THIS guild's admin roles. A role id only means
// anything inside the server it came from, so reading one guild's list while
// handling another's interaction would be both wrong and exploitable.
function isAdminMember(interaction) {
  const adminRoles = adminRolesOf(interaction.guildHall);
  if (!adminRoles.length) return false;
  const roles = interaction.member?.roles?.cache;
  if (!roles) return false;
  return adminRoles.some((r) => roles.has(r));
}

// Who an LOA submission is for. Defaults to the invoker; if they passed the
// `member` option, this submits on that member's behalf instead — but only
// if the invoker actually holds an admin role, checked here rather than
// trusted from the option existing.
function resolveTarget(interaction) {
  const targetUser = interaction.options.getUser('member');
  if (!targetUser) {
    return { discordId: interaction.user.id, displayName: displayNameFor(interaction.user), onBehalf: false };
  }
  if (!isAdminMember(interaction)) {
    return { error: "Only officers can submit an LOA on someone else's behalf." };
  }
  return { discordId: targetUser.id, displayName: displayNameFor(targetUser), onBehalf: true };
}

// Renders a YYYY-MM-DD calendar date as a Discord timestamp tag (noon UTC —
// these are date-only values, so the exact hour doesn't matter, just the day).
function discordDate(dateStr) {
  const unix = Math.floor(new Date(`${dateStr}T12:00:00Z`).getTime() / 1000);
  return `<t:${unix}:D>`;
}

// The announcement text for one LOA, built in ONE place.
//
// This used to be assembled inline in each /loa handler, and the website didn't
// announce at all — so the two paths had already drifted and a third would have
// drifted again. Everything it needs comes from what submit* returns, which is
// the CLEANED record: "9pm" is accepted on the way in but isn't displayable, so
// text built from the raw input shows something the stored row doesn't contain.
function loaAnnouncement({ type, displayName, eventName, eventDate, startDate, endDate, dayOfWeek, startTime, endTime }) {
  const who = `📋 **${displayName || 'Member'}**`;
  const scope = eventName ? ` for **${eventName}**` : '';
  const window = startTime
    ? (endTime ? ` from **${fmt12h(startTime)}** to **${fmt12h(endTime)}**` : ` from **${fmt12h(startTime)}**`)
    : '';

  if (type === 'range') {
    return `${who} is on LOA — ${discordDate(startDate)} to ${discordDate(endDate)}`;
  }
  if (type === 'recurring') {
    return `${who} is always on LOA every **${DAY_NAMES[dayOfWeek]}**${window}${scope}`;
  }
  return `${who} is on LOA${scope} — ${discordDate(eventDate)}${window}`;
}

// Build and post one LOA announcement, returning the message id so the caller
// can record it (cancelling an LOA deletes its announcement). Exported so the
// website's POST /api/loa announces identically to the slash command.
async function announceLoaEntry(guildHall, entry) {
  return announceLoa(guildHall, loaAnnouncement(entry));
}

// Posts an LOA submission to the configured channel. Best-effort — a failure
// here (missing channel, missing permissions) shouldn't undo the LOA itself,
// which is already recorded by the time this runs. Returns the sent message's
// id (so the caller can remember it for later cleanup) or null if nothing sent.
async function announceLoa(guildHall, text) {
  const channelId = loaChannelOf(guildHall);
  if (!channelId) return null;
  const guild = getGuild(guildHall && guildHall.discord_guild_id);
  const channel = guild?.channels.cache.get(channelId);
  if (!channel?.isTextBased()) {
    console.error(`LOA announce error: channel ${channelId} not found or not text-based (check this guild's loa_channel_id and bot permissions).`);
    return null;
  }
  try {
    const message = await channel.send(text);
    return message.id;
  } catch (err) {
    console.error('LOA announce error:', err.message);
    return null;
  }
}

// Deletes a previously-announced LOA message when its entry is cancelled.
// Best-effort: an already-deleted message (e.g. an officer removed it by hand)
// or a missing channel/permission just gets logged, not surfaced to the caller
// — the LOA record is already gone by the time this runs either way.
async function deleteLoaMessage(guildHall, messageId) {
  const channelId = loaChannelOf(guildHall);
  if (!messageId || !channelId) return;
  const guild = getGuild(guildHall && guildHall.discord_guild_id);
  const channel = guild?.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return;
  try {
    await channel.messages.delete(messageId);
  } catch (err) {
    console.error('LOA message delete error:', err.message);
  }
}

async function handleLoa(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'event') return handleLoaEvent(interaction);
  if (sub === 'range') return handleLoaRange(interaction);
  if (sub === 'recurring') return handleLoaRecurring(interaction);
  if (sub === 'cancel') return handleLoaCancel(interaction);
}

async function handleLoaEvent(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!loa) return interaction.editReply('LOA tracking is not configured right now.');

  const target = resolveTarget(interaction);
  if (target.error) return interaction.editReply(target.error);

  const date = interaction.options.getString('date');
  const eventScheduleId = interaction.options.getString('event');
  const startTimeRaw = interaction.options.getString('start_time');
  const endTimeRaw = interaction.options.getString('end_time');
  const reason = interaction.options.getString('reason') || '';
  if (!eventScheduleId && !startTimeRaw) return interaction.editReply('Pick an event, a start time, or both.');

  const startTime = startTimeRaw ? loa.parseTimeOfDay(startTimeRaw) : null;
  if (startTimeRaw && !startTime) {
    return interaction.editReply(`Couldn't read "${startTimeRaw}" as a time — try something like 9:00 PM or 21:00.`);
  }
  const endTime = endTimeRaw ? loa.parseTimeOfDay(endTimeRaw) : null;
  if (endTimeRaw && !endTime) {
    return interaction.editReply(`Couldn't read "${endTimeRaw}" as a time — try something like 9:00 PM or 21:00.`);
  }

  try {
    const { id, eventName, displayName, startTime: outStart, endTime: outEnd } = await loa.submitEvent(interaction.guildHall, {
      discordId: target.discordId,
      displayName: target.displayName,
      eventDate: date,
      eventScheduleId,
      startTime,
      endTime,
      reason,
    });
    const scope = eventName ? ` for **${eventName}**` : '';
    const timeRange = outStart ? (outEnd ? ` from **${fmt12h(outStart)}** to **${fmt12h(outEnd)}**` : ` from **${fmt12h(outStart)}**`) : '';
    // `displayName` here is the site alias resolved at submit time, not the
    // Discord username — so the confirmation matches what everyone else sees.
    await interaction.editReply(target.onBehalf
      ? `Recorded ✅ — LOA submitted for **${displayName}** on ${date}${timeRange}${scope}.`
      : `Recorded ✅ — LOA submitted for ${date}${timeRange}${scope}.`);
    const messageId = await announceLoaEntry(interaction.guildHall, {
      type: 'event', displayName, eventName, eventDate: date, startTime: outStart, endTime: outEnd,
    });
    if (messageId) await loa.setMessageId(interaction.guildHall, id, messageId);
  } catch (err) {
    await interaction.editReply(err.message || 'Something went wrong submitting that LOA.');
  }
}

async function handleLoaRange(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!loa) return interaction.editReply('LOA tracking is not configured right now.');

  const target = resolveTarget(interaction);
  if (target.error) return interaction.editReply(target.error);

  const startDate = interaction.options.getString('start_date');
  const endDate = interaction.options.getString('end_date');
  const reason = interaction.options.getString('reason') || '';

  try {
    const { id, displayName } = await loa.submitRange(interaction.guildHall, {
      discordId: target.discordId,
      displayName: target.displayName,
      startDate, endDate, reason,
    });
    await interaction.editReply(target.onBehalf
      ? `Recorded ✅ — LOA submitted for **${displayName}**, ${startDate} to ${endDate}.`
      : `Recorded ✅ — LOA submitted for ${startDate} to ${endDate}.`);
    const messageId = await announceLoaEntry(interaction.guildHall, {
      type: 'range', displayName, startDate, endDate,
    });
    if (messageId) await loa.setMessageId(interaction.guildHall, id, messageId);
  } catch (err) {
    await interaction.editReply(err.message || 'Something went wrong submitting that LOA.');
  }
}

async function handleLoaRecurring(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!loa) return interaction.editReply('LOA tracking is not configured right now.');

  const target = resolveTarget(interaction);
  if (target.error) return interaction.editReply(target.error);

  const dow = parseInt(interaction.options.getString('day'), 10);
  const eventScheduleId = interaction.options.getString('event') || null;
  const startTimeRaw = interaction.options.getString('start_time') || null;
  const endTimeRaw = interaction.options.getString('end_time') || null;
  const reason = interaction.options.getString('reason') || '';

  const startTime = startTimeRaw ? loa.parseTimeOfDay(startTimeRaw) : null;
  if (startTimeRaw && !startTime) {
    return interaction.editReply(`Couldn't read "${startTimeRaw}" as a time — try something like 9:00 PM or 21:00.`);
  }
  const endTime = endTimeRaw ? loa.parseTimeOfDay(endTimeRaw) : null;
  if (endTimeRaw && !endTime) {
    return interaction.editReply(`Couldn't read "${endTimeRaw}" as a time — try something like 9:00 PM or 21:00.`);
  }

  try {
    const { id, eventName, displayName, startTime: outStart, endTime: outEnd } = await loa.submitRecurring(interaction.guildHall, {
      discordId: target.discordId,
      displayName: target.displayName,
      dayOfWeek: dow,
      eventScheduleId,
      startTime,
      endTime,
      reason,
    });
    const scope = eventName ? ` for **${eventName}**` : '';
    const timeRange = outStart ? (outEnd ? ` from **${fmt12h(outStart)}** to **${fmt12h(outEnd)}**` : ` from **${fmt12h(outStart)}**`) : '';
    await interaction.editReply(target.onBehalf
      ? `Recorded ✅ — **${displayName}** is now always out on **${DAY_NAMES[dow]}**${timeRange}${scope}.`
      : `Recorded ✅ — you're now always out on **${DAY_NAMES[dow]}**${timeRange}${scope}.`);
    const messageId = await announceLoaEntry(interaction.guildHall, {
      type: 'recurring', displayName, eventName, dayOfWeek: dow, startTime: outStart, endTime: outEnd,
    });
    if (messageId) await loa.setMessageId(interaction.guildHall, id, messageId);
  } catch (err) {
    await interaction.editReply(err.message || 'Something went wrong submitting that LOA.');
  }
}

async function handleLoaCancel(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!loa) return interaction.editReply('LOA tracking is not configured right now.');

  const id = interaction.options.getString('entry');
  if (!id) return interaction.editReply('No LOA selected — pick one from the list.');

  try {
    // Officers can cancel anyone's LOA from Discord (matches the website,
    // where the LOA Board's cancel button shows for admins on any entry);
    // everyone else can only cancel their own, enforced in loa.cancel().
    const { messageId } = await loa.cancel(interaction.guildHall, id, interaction.user.id, isAdminMember(interaction));
    await interaction.editReply('Cancelled ✅');
    await deleteLoaMessage(interaction.guildHall, messageId);
  } catch (err) {
    await interaction.editReply(err.message || 'Something went wrong cancelling that LOA.');
  }
}

async function handleAutocomplete(interaction) {
  if (interaction.commandName === 'attendance') return autocompleteAttendanceEvent(interaction);
  if (interaction.commandName !== 'loa') return interaction.respond([]).catch(() => {});
  const sub = interaction.options.getSubcommand();
  if (sub === 'event') return autocompleteLoaEvent(interaction);
  if (sub === 'recurring') return autocompleteLoaRecurring(interaction);
  if (sub === 'cancel') return autocompleteLoaCancel(interaction);
  return interaction.respond([]).catch(() => {});
}

async function autocompleteAttendanceEvent(interaction) {
  if (!attendance) return interaction.respond([]).catch(() => {});
  const focused = interaction.options.getFocused().toLowerCase();
  const events = await attendance.listSchedule(interaction.guildHall);
  const choices = events
    .filter((e) => e.name.toLowerCase().includes(focused))
    .slice(0, 25)
    // Labelled by the night it belongs to, matching how the guild talks about
    // it — an after-midnight event is stored on the next calendar day, so
    // DAY_NAMES[e.day_of_week] alone would name the wrong night.
    .map((e) => {
      const night = DAY_NAMES[createLoa.guildDayOfWeek(e.day_of_week, e.event_time, interaction.guildHall)];
      const late = createLoa.isAfterMidnight(e.event_time, interaction.guildHall) ? ' night' : '';
      return {
        name: e.event_time ? `${e.name} (${night}${late}, ${fmt12h(e.event_time)})` : `${e.name} (${night})`,
        value: e.id,
      };
    });
  await interaction.respond(choices).catch(() => {});
}

async function autocompleteLoaEvent(interaction) {
  if (!loa) return interaction.respond([]).catch(() => {});
  const date = interaction.options.getString('date');
  if (!loa.isValidDate(date)) return interaction.respond([]).catch(() => {});

  const focused = interaction.options.getFocused().toLowerCase();
  const events = await loa.eventsForDate(interaction.guildHall, date);
  if (events.length === 0) {
    return interaction.respond([{ name: '— no events scheduled that day —', value: '' }]).catch(() => {});
  }
  const choices = events
    .filter((e) => e.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((e) => ({ name: e.event_time ? `${e.name} (${e.event_time})` : e.name, value: e.id }));
  await interaction.respond(choices).catch(() => {});
}

// `event` is optional here (blank = whole day), so unlike autocompleteLoaEvent
// there's no placeholder needed for the zero-results case — the field just
// shows no suggestions and the member leaves it blank.
async function autocompleteLoaRecurring(interaction) {
  if (!loa) return interaction.respond([]).catch(() => {});
  const day = interaction.options.getString('day');
  const dow = day === null ? NaN : parseInt(day, 10);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) return interaction.respond([]).catch(() => {});

  const focused = interaction.options.getFocused().toLowerCase();
  const events = await loa.eventsForDay(interaction.guildHall, dow);
  const choices = events
    .filter((e) => e.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((e) => ({ name: e.event_time ? `${e.name} (${e.event_time})` : e.name, value: e.id }));
  await interaction.respond(choices).catch(() => {});
}

async function autocompleteLoaCancel(interaction) {
  if (!loa) return interaction.respond([]).catch(() => {});
  const admin = isAdminMember(interaction);
  const entries = admin ? await loa.all(interaction.guildHall, true) : await loa.mine(interaction.guildHall, interaction.user.id);
  const today = createLoa.todayInGuildTz(interaction.guildHall);
  const upcoming = entries.filter((e) => {
    if (e.type === 'event') return e.event_date >= today;
    if (e.type === 'range') return e.end_date >= today;
    return true; // recurring — always current until explicitly cancelled
  });
  if (upcoming.length === 0) {
    return interaction.respond([{ name: '— no upcoming LOAs —', value: '' }]).catch(() => {});
  }
  const label = (e) => {
    const who = admin ? `${e.display_name} — ` : '';
    if (e.type === 'event') return `${who}Event — ${e.event_date}`;
    if (e.type === 'range') return `${who}Range — ${e.start_date} to ${e.end_date}`;
    return `${who}Recurring — ${DAY_NAMES[e.day_of_week]}`;
  };
  const focused = interaction.options.getFocused().toLowerCase();
  const choices = upcoming
    .map((e) => ({ name: label(e), value: e.id }))
    .filter((c) => c.name.toLowerCase().includes(focused))
    .slice(0, 25);
  await interaction.respond(choices).catch(() => {});
}

// ── /attendance ───────────────────────────────────────────────────────────
async function handleAttendance(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!attendance) return interaction.editReply('Attendance tracking is not configured right now.');
  if (!isAdminMember(interaction)) return interaction.editReply('Officers only.');

  const eventScheduleId = interaction.options.getString('event');
  const ev = await attendance.getScheduleEvent(interaction.guildHall, eventScheduleId);
  if (!ev) return interaction.editReply('Unknown event — pick one from the list.');

  const channelOpt = interaction.options.getChannel('channel');
  const channel = channelOpt || interaction.member?.voice?.channel;
  if (!channel) return interaction.editReply("You're not in a voice channel — specify one with the channel option.");

  const dateInput = interaction.options.getString('date');
  const eventDate = dateInput || createLoa.todayInGuildTz(interaction.guildHall);
  if (!loa.isValidDate(eventDate)) return interaction.editReply('Date must be in YYYY-MM-DD format.');

  const members = getVoiceMembers(interaction.guildHall, channel.id);
  if (members.length === 0) return interaction.editReply('No one is in that voice channel right now.');

  const ids = await identities.load(interaction.guildHall.id);
  members.forEach((m) => { m.name = ids.displayNameFor(m.id, m.name); });

  try {
    await attendance.createEvent(interaction.guildHall, { title: ev.name, eventDate, eventScheduleId, attendees: members });
  } catch (err) {
    return interaction.editReply(err.message || 'Something went wrong saving that attendance.');
  }

  let names = members.map((m) => m.name).join(', ');
  const header = `✅ Logged attendance for **${ev.name}** — ${eventDate} — ${members.length} member(s): `;
  if (header.length + names.length > 1900) {
    names = `${names.slice(0, 1900 - header.length)}…`;
  }
  await interaction.editReply(`${header}${names}`);

  notifyAttendance(members, ev.name, eventDate).catch(() => {});
}

// ── /announce ─────────────────────────────────────────────────────────────
async function handleAnnounce(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!isAdminMember(interaction)) return interaction.editReply('Officers only.');
  const announceChannelId = announceChannelOf(interaction.guildHall);
  if (!announceChannelId) return interaction.editReply('Announcements are not configured for this server yet.');

  const timeInput = interaction.options.getString('time');
  const message = interaction.options.getString('message') || 'Get into CTA Comms — {time}';

  const when = parseAnnounceTime(timeInput, interaction.guildHall.timezone);
  if (!when) return interaction.editReply(`Couldn't understand "${timeInput}" as a time. Try something like \`9:30pm\` or \`2130\`.`);

  const guild = getGuild(interaction.guildHall.discord_guild_id);
  const channel = guild?.channels.cache.get(announceChannelId);
  if (!channel?.isTextBased()) {
    return interaction.editReply('Announcement channel not found — check this server\'s announce channel and the bot\'s permissions.');
  }

  const unix = Math.floor(when.getTime() / 1000);
  const timeTag = `<t:${unix}:t>`;
  // {time} lets the officer place the timestamp anywhere in the sentence
  // ("roll call {time} in CTA comms"); with no placeholder it's appended at the end.
  const body = /\{time\}/i.test(message) ? message.replace(/\{time\}/i, timeTag) : `${message} — ${timeTag}`;
  const role = interaction.options.getRole('role');
  const ping = role ? `${role.toString()} ` : '';
  try {
    await channel.send(`${ping}${body}`);
    await interaction.editReply(`Posted ✅ — resolved to <t:${unix}:F>. If that's not what you meant, re-run with an explicit am/pm (e.g. \`9:30pm\`).`);
  } catch (err) {
    console.error('Announce post error:', err.message);
    await interaction.editReply('Something went wrong posting that announcement.');
  }
}

// ── EVENT SIGNUPS ─────────────────────────────────────────────────────────
// One announcement per occurrence, with three buttons, edited in place as
// people come and go.
//
// TWO PROPERTIES THIS SECTION EXISTS TO GUARANTEE:
//
// 1. The buttons survive a process restart. Everything needed to act on a
//    click is in the customId — literally just the occurrence's uuid — so
//    there is no in-memory collector, no message cache, and no "this
//    interaction failed" on a post from last week. discord.js's per-message
//    collectors would have been fewer lines and would have quietly stopped
//    working at the next deploy, which is the failure nobody notices until an
//    officer asks why half the guild couldn't sign up.
//
// 2. A burst of clicks produces one or two edits, not thirty. See
//    refreshSignupMessage.
const ROLE_ORDER = ['Tank', 'DPS', 'Healer'];
const SIGNUP_ROLE_EMOJI = { Tank: '🛡️', DPS: '⚔️', Healer: '💚' };

// Discord caps an embed field value at 1024 characters. A guild large enough to
// blow past that on one role column is exactly the guild where losing the tail
// silently would be worst, so the overflow is counted rather than dropped.
function nameColumn(list) {
  if (!list.length) return '—';
  const lines = list.map((e) => e.display_name || 'Member');
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const next = out ? `${out}\n${lines[i]}` : lines[i];
    if (next.length > 980) return `${out}\n…+${lines.length - i} more`;
    out = next;
  }
  return out;
}

function signupEmbed(guildHall, view) {
  const unix = Math.floor(new Date(view.starts_at).getTime() / 1000);
  const cap = view.capacity ? `${view.counts.going}/${view.capacity}` : `${view.counts.going}`;
  const byRole = Object.fromEntries(ROLE_ORDER.map((r) => [r, view.going.filter((e) => e.role === r)]));
  const noRole = view.going.filter((e) => !e.role);

  const fields = ROLE_ORDER.map((role) => ({
    name: `${SIGNUP_ROLE_EMOJI[role]} ${role} (${byRole[role].length})`,
    value: nameColumn(byRole[role]),
    inline: true,
  }));

  // Kept as its own group rather than folded into DPS. These are the people a
  // party seed would silently drop, and the count is the prompt to go and set
  // their role — hiding it inside another column hides the problem.
  if (noRole.length) {
    fields.push({ name: `• No role on file (${noRole.length})`, value: nameColumn(noRole), inline: false });
  }
  if (view.waitlist.length) {
    fields.push({
      name: `⏳ Waitlist (${view.waitlist.length})`,
      value: nameColumn(view.waitlist.map((e, i) => ({ display_name: `${i + 1}. ${e.display_name || 'Member'}` }))),
      inline: false,
    });
  }

  return {
    title: String(view.title || 'Event').slice(0, 256),
    // No "declined" count anywhere, on any surface — there is no such record,
    // and showing "0 declined" would imply there could be.
    description: `<t:${unix}:F> · <t:${unix}:R>\n**${cap}** signed up`
      + (view.status === 'closed' ? '\n\n*Signups are closed.*' : ''),
    color: view.status === 'closed' ? 0x5a5a5e : 0xc9973a,
    fields,
    footer: { text: (guildHall && guildHall.house) || 'Guild Hall' },
  };
}

// Buttons are STRIPPED once an occurrence closes, not disabled: a greyed-out
// "I'm in" still reads as a thing you might be able to press, and people do
// keep pressing it.
//
// "Withdraw" is deliberately not "Can't make it". Withdrawing returns you to
// undecided; it does not file an absence, and a label that says otherwise
// would have members believing officers had been told something they haven't.
function signupComponents(view) {
  if (view.status !== 'open') return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`signup:join:${view.id}`).setLabel("I'm in").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`signup:leave:${view.id}`).setLabel('Withdraw').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`signup:who:${view.id}`).setLabel("Who's coming?").setStyle(ButtonStyle.Secondary),
  )];
}

function signupChannel(guildHall) {
  const channelId = signupChannelOf(guildHall);
  if (!channelId) return null;
  const guild = getGuild(guildHall && guildHall.discord_guild_id);
  const channel = guild?.channels.cache.get(channelId);
  if (!channel?.isTextBased()) {
    console.error(`Signup post error: channel ${channelId} not found or not text-based (check this guild's signup/announce channel and the bot's permissions).`);
    return null;
  }
  return channel;
}

// Post the announcement, returning where it landed so the caller can store it.
// The channel is resolved at post time and then remembered ON THE ROW, so an
// officer changing the configured channel later moves new signups without
// orphaning the buttons on posts already out there.
async function postSignupMessage(guildHall, view) {
  const channel = signupChannel(guildHall);
  if (!channel) return null;
  try {
    const message = await channel.send({ embeds: [signupEmbed(guildHall, view)], components: signupComponents(view) });
    return { channelId: channel.id, messageId: message.id };
  } catch (err) {
    console.error('Signup post error:', err.message);
    return null;
  }
}

async function deleteSignupMessage(guildHall, channelId, messageId) {
  if (!messageId || !channelId) return;
  const guild = getGuild(guildHall && guildHall.discord_guild_id);
  const channel = guild?.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return;
  try {
    await channel.messages.delete(messageId);
  } catch (err) {
    // Already deleted by hand, or the bot lost access. Best-effort by design —
    // the signup record is already gone by the time this runs.
    console.error('Signup message delete error:', err.message);
  }
}

// ── Coalesced edits ─────────────────────────────────────────────────────────
// Six people clicking "I'm in" during a roll call is six state changes in about
// two seconds. Editing on each one sends six requests that Discord may deliver
// out of order, so the message can settle showing an EARLIER state than the
// truth — the one failure mode that makes the whole feature untrustworthy.
//
// So: the first change schedules an edit 1.5 s out, and every change inside
// that window rides along with it. The state is then re-read from Postgres
// immediately before the edit, not captured when the timer was set, which is
// what makes the coalescing safe rather than merely cheap — the edit always
// paints whatever is true at the moment it fires.
//
// Keyed by guild AND occurrence. The uuid alone would do (they're globally
// unique), but a key without a guild in it is the shape that has gone wrong
// everywhere else in this codebase, so it doesn't get to be the exception.
const SIGNUP_EDIT_DEBOUNCE_MS = 1500;
const signupEditTimers = new Map(); // `${guildId}:${signupId}` -> timeout handle

function refreshSignupMessage(guildHall, signupId) {
  if (!signups || !guildHall || !signupId) return;
  const key = `${guildHall.id}:${signupId}`;
  if (signupEditTimers.has(key)) return; // an edit is already coming; it'll see this change too
  signupEditTimers.set(key, setTimeout(() => {
    signupEditTimers.delete(key);
    editSignupMessage(guildHall, signupId).catch((err) => console.error('Signup edit failed:', err.message));
  }, SIGNUP_EDIT_DEBOUNCE_MS));
}

async function editSignupMessage(guildHall, signupId) {
  // Re-read here, at the last possible moment.
  const view = await signups.detail(guildHall, signupId).catch(() => null);
  if (!view || !view.message_id || !view.channel_id) return;
  const guild = getGuild(guildHall.discord_guild_id);
  const channel = guild?.channels.cache.get(view.channel_id);
  if (!channel?.isTextBased()) return;
  try {
    const message = await channel.messages.fetch(view.message_id);
    await message.edit({ embeds: [signupEmbed(guildHall, view)], components: signupComponents(view) });
  } catch (err) {
    // A message deleted by hand is the common case. Logged, not repaired: the
    // officer page has an explicit "Repost" for that, and silently posting a
    // replacement would leave two live signup posts for one occurrence.
    console.error('Signup message edit error:', err.message);
  }
}

// ── Button handling ───────────────────────────────────────────────────────
async function handleButton(interaction) {
  const [ns, action, signupId] = String(interaction.customId || '').split(':');
  if (ns !== 'signup') return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!signups) return interaction.editReply('Signups are not configured right now.');
  if (!signupId) return interaction.editReply('That button is missing its event — the post may be from an older version.');

  try {
    if (action === 'who') return await replySignupRoster(interaction, signupId);
    if (action === 'join') return await handleSignupJoin(interaction, signupId);
    if (action === 'leave') return await handleSignupLeave(interaction, signupId);
    return await interaction.editReply('Unknown action.');
  } catch (err) {
    console.error('Signup button error:', err.message);
    await interaction.editReply(err.status ? err.message : 'Something went wrong with that.').catch(() => {});
  }
}

async function handleSignupJoin(interaction, signupId) {
  const { status, position, already } = await signups.join(interaction.guildHall, signupId, {
    discordId: interaction.user.id,
    displayName: displayNameFor(interaction.user),
  });
  const line = status === 'waitlist'
    ? `You're on the waitlist — **#${position}**. If a slot frees up you'll be moved in automatically.`
    : "You're in ✅";
  await interaction.editReply(already ? `${line} (you were already signed up)` : line);
  refreshSignupMessage(interaction.guildHall, signupId);
}

async function handleSignupLeave(interaction, signupId) {
  const { removed } = await signups.withdraw(interaction.guildHall, signupId, { discordId: interaction.user.id });
  // The wording matters as much as the data model does. Withdrawing puts a
  // member back to undecided; if they actually can't come, that's an LOA, and
  // this is the one moment they're guaranteed to be reading a message about it.
  await interaction.editReply(removed
    ? "Withdrawn — you're back to undecided. If you know you can't make it, file an LOA with `/loa` so officers can plan around it."
    : "You weren't signed up for this one.");
  if (removed) refreshSignupMessage(interaction.guildHall, signupId);
}

async function replySignupRoster(interaction, signupId) {
  const view = await signups.detail(interaction.guildHall, signupId);
  const c = view.composition;
  const group = (label, list) => (list.length ? `**${label} (${list.length})**\n${list.map((e) => e.display_name || 'Member').join(', ')}` : null);
  const lines = [
    `**${view.title}** — ${c.total} signed up${view.capacity ? ` of ${view.capacity}` : ''}`,
    `🛡️ ${c.Tank} · ⚔️ ${c.DPS} · 💚 ${c.Healer}${c.unknown ? ` · • ${c.unknown} with no role on file` : ''}`,
    '',
    ...ROLE_ORDER.map((r) => group(r, view.going.filter((e) => e.role === r))),
    group('No role on file', view.going.filter((e) => !e.role)),
    group('Waitlist', view.waitlist),
  ].filter((l) => l !== null);
  const text = lines.join('\n');
  await interaction.editReply(text.length > 1900 ? `${text.slice(0, 1900)}…` : text);
}

// ── Reminders ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Discord opens a fresh DM channel per recipient, and a guild-wide fan-out in a
// tight loop trips a GLOBAL 429 — which doesn't just fail the remaining DMs, it
// throttles every other request this bot makes, including the slash commands
// people are using at the same moment. 250 ms between sends keeps a 60-member
// batch under a minute and well inside the limits.
const DM_PACING_MS = 250;

async function sendSignupReminders(guildHall, signup, recipients) {
  if (!ready || !client || !recipients?.length) return;
  const unix = Math.floor(new Date(signup.starts_at).getTime() / 1000);
  const text = `⏰ **${signup.title}** starts <t:${unix}:R> (<t:${unix}:t>) and we haven't heard from you.\n`
    + 'Hit **I\'m in** on the signup post if you\'re coming — or file an LOA with `/loa` if you\'re not.';
  let sent = 0;
  for (const m of recipients) {
    try {
      const user = await client.users.fetch(m.id);
      await user.send(text);
      sent += 1;
    } catch (err) {
      // DMs closed, or they've left the server. Skipped, never retried — a
      // member who has turned off DMs is not an error condition.
      console.error(`Signup reminder DM error for ${m.id}:`, err.message);
    }
    await sleep(DM_PACING_MS);
  }
  console.log(`Signup reminders for "${signup.title}": ${sent}/${recipients.length} delivered.`);
}

// ── The 60-second sweep ───────────────────────────────────────────────────
// Sends due reminders and closes finished occurrences. Both halves are driven
// by single UPDATE … RETURNING statements in Postgres, so this loop holds no
// state of its own and a second process running the same sweep is harmless:
// whichever one wins the conditional update does the work, and the other gets
// an empty list.
const SIGNUP_SWEEP_MS = 60 * 1000;
let signupSweepTimer = null;

function startSignupSweep() {
  if (signupSweepTimer || !db) return;
  signupSweepTimer = setInterval(() => {
    runSignupSweep().catch((err) => console.error('Signup sweep error:', err.message));
  }, SIGNUP_SWEEP_MS);
}

// Resolve a row's OWN guild. The sweep is cross-tenant by nature — one process
// serves every guild — so each row's guild_id is the only correct source, and
// falling back to anything would post one guild's reminders into another's.
const guildFor = (guildId) => guildRegistry.resolveById(db, guildId);

async function runSignupSweep() {
  if (!ready || !signups || !db) return;

  // Reminders first. The claim already happened inside the RPC — every row
  // handed back here has been won exclusively by this process, so a crash
  // between here and the DM loses that batch rather than duplicating it.
  // That's the right way round: a missed nudge is a nudge; a duplicate batch
  // is the bot DMing the whole guild twice.
  for (const row of await createEventSignups.claimDueReminders(db)) {
    const guildHall = await guildFor(row.guild_id);
    if (!guildHall) continue; // deregistered or suspended since the row was written
    try {
      const recipients = await signups.reminderRecipients(guildHall, row);
      await sendSignupReminders(guildHall, row, recipients);
    } catch (err) {
      console.error('Signup reminder batch failed:', err.message);
    }
  }

  // Then close anything that has started, and strip its buttons.
  for (const row of await createEventSignups.closeFinished(db)) {
    const guildHall = await guildFor(row.guild_id);
    if (!guildHall) continue;
    editSignupMessage(guildHall, row.id).catch((err) => console.error('Signup close edit failed:', err.message));
  }
}

// DMs each attendee a simple confirmation that their attendance was logged.
// Best-effort per member — a member with DMs from server members disabled (or
// who has left the guild) just gets logged and skipped, not surfaced as a
// failure of the save itself, which has already succeeded by the time this runs.
async function notifyAttendance(attendees, title, eventDate) {
  if (!ready || !client) return;
  const dateText = eventDate ? ` on ${discordDate(eventDate)}` : '';
  const text = `✅ Your attendance for **${title}**${dateText} has been recorded. Thanks for showing up!`;
  for (const a of attendees) {
    try {
      const user = await client.users.fetch(a.id);
      await user.send(text);
    } catch (err) {
      console.error(`Attendance DM error for ${a.id}:`, err.message);
    }
  }
}

// List voice channels the bot can see.
function listVoiceChannels(guildHall) {
  const guild = getGuild(guildHall && guildHall.discord_guild_id);
  if (!guild) return [];
  return guild.channels.cache
    .filter((ch) => ch.type === 2) // GuildVoice
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((ch) => ({ id: ch.id, name: ch.name, memberCount: ch.members.size }));
}

// Snap the current members in a voice channel.
function getVoiceMembers(guildHall, channelId) {
  const guild = getGuild(guildHall && guildHall.discord_guild_id);
  if (!guild) return [];
  // Looked up inside THIS guild's channel cache, so a channel id belonging to
  // another tenant is simply not found rather than being snapshotted.
  const channel = guild.channels.cache.get(channelId);
  if (!channel || channel.type !== 2) return [];
  return channel.members.map((m) => ({
    id: m.user.id,
    name: m.nickname || m.user.globalName || m.user.username,
    avatar: m.user.avatar
      ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png`
      : null,
  }));
}

module.exports = {
  start, listVoiceChannels, getVoiceMembers, deleteLoaMessage, notifyAttendance, announceLoaEntry,
  postSignupMessage, refreshSignupMessage, deleteSignupMessage, sendSignupReminders,
};

// ── Test seam ───────────────────────────────────────────────────────────────
// The interaction path is the highest-risk code in this project (plan task 12):
// a missed tenant resolution doesn't error, it writes one guild's data into
// another's. It therefore has to be testable, and it can't be reached through
// start() because that opens a real gateway connection and needs a bot token.
//
// This exposes the handler and lets a test inject a fake client, so the whole
// path — tenant resolution, per-guild config, officer checks, channel targeting
// — runs against the real database with no Discord traffic. Nothing in the
// application calls these.
module.exports.__test = {
  wire(supabase, fakeClient) {
    wireModules(supabase);
    client = fakeClient;
    ready = true;
  },
  handleInteraction,
  isAdminMember,
  getGuild,
  // Signup buttons are the same risk in a different shape: a click carries no
  // guild, only an occurrence id, so tenant resolution has to happen before the
  // id is trusted. Exposed so that path can be exercised too.
  handleButton,
  signupEmbed,
  signupComponents,
  runSignupSweep,
};
