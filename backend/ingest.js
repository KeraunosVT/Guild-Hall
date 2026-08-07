// backend/ingest.js — turn a screenshot or CSV into draft player rows.
// Screenshots go through Gemini vision (with an optional weapon legend as a
// reference image); CSVs are parsed directly. Both produce the same row shape,
// which the admin reviews and edits before committing.
const { GoogleGenAI, Type } = require('@google/genai');
const Papa = require('papaparse');
const fs = require('fs');
const path = require('path');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Model names churn — keep this swappable without a code change.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// Optional reference legend image sent as image 1 on every screenshot read.
const LEGEND_PATH = process.env.WEAPON_LEGEND_PATH || path.join(__dirname, 'assets', 'weapon_legend.png');

// The exact weapon tokens our class map understands ("Unknown" is allowed when
// the icon can't be identified, and gets flagged for review).
const WEAPONS = ['SnS', 'Greatsword', 'Dagger', 'Crossbow', 'Longbow', 'Staff', 'Wand', 'Spear', 'Orb', 'Gauntlet'];

// ── Legend image (cached) ────────────────────────────────────────────────────
let _legendPart; // undefined = not checked, null = absent
function getLegendPart() {
  if (_legendPart !== undefined) return _legendPart;
  try {
    const data = fs.readFileSync(LEGEND_PATH);
    const ext = path.extname(LEGEND_PATH).toLowerCase();
    const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    _legendPart = { inlineData: { mimeType, data: data.toString('base64') } };
  } catch {
    _legendPart = null;
  }
  return _legendPart;
}

function buildPrompt(hasLegend) {
  return `You will receive ${
    hasLegend
      ? 'two images. Image 1 is a REFERENCE LEGEND showing weapon icons and their exact names. Image 2 is a Throne and Liberty wargame scoreboard screenshot.'
      : 'one image: a Throne and Liberty wargame scoreboard screenshot.'
  }

COLUMN MAPPING (left to right on the scoreboard):
- "Ranking" -> rank
- the two weapon icons -> weapon1 (LEFT icon) and weapon2 (RIGHT icon)
- "Guild" -> guildname (the text only; ignore the emblem)
- "Name" -> playername (keep non-Latin characters exactly)
- "Team" -> teamcolor ("Yellow" or "Red")
- "Defeat" -> kills
- "Assist" -> assists
- "Damage Dealt" -> damagedealt
- "Damage Taken" -> damagetaken
- "Amount Healed" -> healing

WEAPON POSITION RULES:
- Weapons appear as TWO small icons side by side HORIZONTALLY in the second column.
- LEFT icon = weapon1, RIGHT icon = weapon2. Do NOT read them as stacked or vertical.

CRITICAL WEAPON IDENTIFICATION RULES:
- Greatsword: a tall single straight blade with a wide crossguard and NO shield. This is the most common weapon — when you see a single sword shape, it is almost always Greatsword.
- SnS: ALWAYS has a visible shield (round or rectangular) with a sword behind or beside it. If there is NO shield present, it is NOT SnS.
- Dagger: two short blades crossed in an X shape.
- Longbow: two diagonal lines forming a narrow arc shape (the bow + string side by side).
- Spear: a single long pole with a pointed trident tip at the top.
- Crossbow: a horizontal bow mounted on a vertical stock, forming a cross/T shape.
- Staff: a single tall straight rod with a small ornament at the top.
- Wand: a DARK SQUARE icon showing a tall rectangular tome/book standing upright, with a thin wand rod leaning against or attached to it. The tome is the dominant shape — it looks like a book standing on its side. NOT a shield.
- Gauntlet: a fist or glove icon, sometimes showing knuckle spikes or a clenched armored hand.
- DO NOT default to SnS when uncertain — Greatsword is far more likely for any single sword icon.
- DO NOT confuse Wand and Longbow — Longbow has two lines, Wand has a rod attached to a tome.
- DO NOT confuse Spear and Dagger — Spear is a single long pole, Dagger are two crossed short blades.
${hasLegend ? '- Compare each scoreboard icon against the legend in Image 1 before deciding.\n' : ''}- If still uncertain about a weapon, use "Unknown" rather than guessing.
- The ONLY valid weapon names are: Wand, Longbow, Orb, Greatsword, Spear, Dagger, Crossbow, SnS, Staff, Gauntlet, Unknown.

OTHER RULES:
- EXCLUDE the pinned "My Rank" summary row at the very top of the board — it duplicates that player's own ranked line and must NOT appear in the output.
- All stat values are integers with no thousands separators: "3,254,684" becomes 3254684.
- If a value is blank or unreadable, use 0.
- Return rows in ranking order.

Extract every remaining row into a JSON array of objects with these exact keys:
rank, weapon1, weapon2, guildname, playername, teamcolor, kills, assists, damagedealt, damagetaken, healing.
Return ONLY the JSON array, no markdown, no explanation.`;
}

// Schema guarantees the model returns a well-formed array of rows.
const RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      rank: { type: Type.NUMBER },
      weapon1: { type: Type.STRING },
      weapon2: { type: Type.STRING },
      guildname: { type: Type.STRING },
      playername: { type: Type.STRING },
      teamcolor: { type: Type.STRING },
      kills: { type: Type.NUMBER },
      assists: { type: Type.NUMBER },
      damagedealt: { type: Type.NUMBER },
      damagetaken: { type: Type.NUMBER },
      healing: { type: Type.NUMBER },
    },
    required: ['rank', 'weapon1', 'weapon2', 'guildname', 'playername', 'teamcolor', 'kills', 'assists', 'damagedealt', 'damagetaken', 'healing'],
  },
};

async function parseScreenshot(buffer, mimeType) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set — screenshot reading is unavailable.');
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const legend = getLegendPart();

  const parts = [{ text: buildPrompt(!!legend) }];
  if (legend) parts.push(legend);
  parts.push({ inlineData: { mimeType, data: buffer.toString('base64') } });

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts }],
    config: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0 },
  });

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error('Gemini did not return valid JSON. Try a clearer screenshot.');
  }

  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed.players) ? parsed.players : [];
  const players = arr.map(normalizeRow);
  return { players, warnings: buildWarnings(players, 'screenshot'), usedLegend: !!legend };
}

// ── CSV ──────────────────────────────────────────────────────────────────────
const HEADER_MAP = {
  ranking: 'rank', rank: 'rank',
  weapon_1: 'weapon_1', weapon1: 'weapon_1', 'weapon 1': 'weapon_1',
  weapon_2: 'weapon_2', weapon2: 'weapon_2', 'weapon 2': 'weapon_2',
  guild: 'guild_name', guild_name: 'guild_name', guildname: 'guild_name',
  name: 'player_name', player: 'player_name', player_name: 'player_name', playername: 'player_name',
  team: 'team_color', team_color: 'team_color', teamcolor: 'team_color',
  defeat: 'kills', kills: 'kills', kill: 'kills',
  assist: 'assists', assists: 'assists',
  'damage dealt': 'damage_dealt', damage_dealt: 'damage_dealt', damagedealt: 'damage_dealt', dealt: 'damage_dealt',
  'damage taken': 'damage_taken', damage_taken: 'damage_taken', damagetaken: 'damage_taken', taken: 'damage_taken',
  'amount healed': 'healing', healing: 'healing', healed: 'healing', heal: 'healing',
};

function parseCsv(text) {
  const out = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => HEADER_MAP[h.trim().toLowerCase()] || h.trim().toLowerCase(),
  });

  const fields = ['rank', 'weapon_1', 'weapon_2', 'guild_name', 'player_name', 'team_color', 'kills', 'assists', 'damage_dealt', 'damage_taken', 'healing'];
  const players = (out.data || [])
    .map((raw) => {
      const row = {};
      for (const key of Object.keys(raw)) if (fields.includes(key)) row[key] = raw[key];
      return normalizeRow(row);
    })
    .filter((p) => p.player_name && !/^my\s*rank$/i.test(p.player_name));

  return { players, warnings: buildWarnings(players, 'csv') };
}

// ── shared normalization (tolerant of both key styles) ───────────────────────
function toInt(v) {
  if (v === null || v === undefined) return 0;
  const n = parseInt(String(v).replace(/[, ]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function normalizeTeam(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s.startsWith('r')) return 'Red';
  if (s.startsWith('y')) return 'Yellow';
  return '';
}

function cleanWeapon(v) {
  const s = String(v || '').trim();
  const match = WEAPONS.find((w) => w.toLowerCase() === s.toLowerCase());
  return match || s; // keep raw (e.g. "Unknown") so the admin can fix it
}

function pick(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function normalizeRow(r = {}) {
  return {
    rank: toInt(pick(r.rank)),
    weapon_1: cleanWeapon(pick(r.weapon1, r.weapon_1)),
    weapon_2: cleanWeapon(pick(r.weapon2, r.weapon_2)),
    guild_name: String(pick(r.guildname, r.guild_name) || '').trim(),
    player_name: String(pick(r.playername, r.player_name) || '').trim(),
    team_color: normalizeTeam(pick(r.teamcolor, r.team_color)),
    kills: toInt(pick(r.kills)),
    assists: toInt(pick(r.assists)),
    damage_dealt: toInt(pick(r.damagedealt, r.damage_dealt)),
    damage_taken: toInt(pick(r.damagetaken, r.damage_taken)),
    healing: toInt(pick(r.healing)),
  };
}

function buildWarnings(players, source) {
  const warnings = [];
  if (players.length === 0) {
    warnings.push('No player rows were detected — check the file and try again.');
    return warnings;
  }
  const missingTeam = players.filter((p) => !p.team_color).length;
  if (missingTeam) warnings.push(`${missingTeam} row(s) have no team color set.`);
  const badWeapon = players.filter((p) => !WEAPONS.includes(p.weapon_1) || !WEAPONS.includes(p.weapon_2)).length;
  if (badWeapon && source === 'screenshot') {
    warnings.push(`${badWeapon} row(s) have a weapon to confirm — icons are the least reliable field.`);
  }
  return warnings;
}

module.exports = { parseScreenshot, parseCsv, WEAPONS };
