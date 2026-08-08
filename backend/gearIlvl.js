// backend/gearIlvl.js — extracts weapon/armor/accessory item levels from a
// Throne & Liberty "Equipment Level" info window screenshot (Gemini vision),
// and persists one entry per member (a new submission replaces their previous one).
const { GoogleGenAI, Type } = require('@google/genai');
const { tenantDb } = require('./tenantDb');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const PROMPT = `This is a screenshot of the "Equipment Level" info window from
Throne and Liberty. It's a small popup/tooltip with the title "Equipment Level",
a short description below it, and then four labeled lines, each ending in a
number, e.g.:

Equipment Lv. 74
Max Weapon Lv. 74
Max Armor Lv. 74
Max Accessory Lv. 75

Read the number at the end of each of those four lines:
- "Equipment Lv." — the overall equipment level
- "Max Weapon Lv." — highest weapon item level
- "Max Armor Lv." — highest armor item level
- "Max Accessory Lv." — highest accessory item level

Return ONLY a JSON object with this shape:
{ "equipmentLevel": <number>, "weapon": <number>, "armor": <number>, "accessory": <number> }`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    equipmentLevel: { type: Type.NUMBER },
    weapon: { type: Type.NUMBER },
    armor: { type: Type.NUMBER },
    accessory: { type: Type.NUMBER },
  },
  required: ['equipmentLevel', 'weapon', 'armor', 'accessory'],
};

// Read a screenshot and return { weapon, armor, accessory, average }. weapon/
// armor/accessory are each read directly off the window's "Max ___ Lv." line;
// average is its "Equipment Lv." line — the game itself defines that as the
// mean of the other three, so there's no need to recompute it here.
async function parseGearScreenshot(buffer, mimeType) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set — gear reading is unavailable.');
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType, data: buffer.toString('base64') } },
      ],
    }],
    config: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0 },
  });

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error('Gemini did not return valid JSON. Try a clearer screenshot.');
  }

  const weapon = Number(parsed.weapon) || 0;
  const armor = Number(parsed.armor) || 0;
  const accessory = Number(parsed.accessory) || 0;
  const average = Number(parsed.equipmentLevel) || 0;

  return { weapon, armor, accessory, average };
}

const MAX_LEVEL = 80;

// Multi-tenant note: this factory is built ONCE at boot, so it cannot close
// over a guild — the guild belongs to the request. Every method that touches
// the database therefore takes `guildId` as its first argument and builds a
// scoped client from it. Callers pass req.guildId.
//
// gear_levels is one of the tables whose primary key Phase 1 widened from
// `discord_id` to `(guild_id, discord_id)`, so the same member can hold a
// separate gear entry in each guild they belong to. That makes guild scoping a
// correctness requirement here, not just an isolation one: an unscoped lookup
// on discord_id alone can now match another guild's row.
module.exports = function createGearIlvl(supabase) {
  return {
    parseGearScreenshot,

    // A new submission replaces whatever this member had on file before —
    // except maxed_at, which is set once (the first time weapon/armor/
    // accessory all hit MAX_LEVEL) and then left alone on every later
    // resubmission, so members at the cap keep the order they actually
    // achieved it in rather than being reshuffled by later screenshots.
    async submit(guildId, discordId, displayName, extracted) {
      const db = tenantDb(supabase, guildId);
      const isMaxed = extracted.weapon === MAX_LEVEL && extracted.armor === MAX_LEVEL && extracted.accessory === MAX_LEVEL;
      const row = {
        discord_id: discordId,
        display_name: displayName || null,
        weapon: extracted.weapon,
        armor: extracted.armor,
        accessory: extracted.accessory,
        average: extracted.average,
        submitted_at: new Date().toISOString(),
      };
      if (isMaxed) {
        const { data: existing } = await db.from('gear_levels').select('maxed_at').eq('discord_id', discordId).single();
        row.maxed_at = existing?.maxed_at || new Date().toISOString();
      }
      // onConflict must name the full composite key. With just 'discord_id' the
      // upsert matches on a constraint that no longer exists, so it would fail
      // outright rather than updating this guild's row.
      const { error } = await db.from('gear_levels').upsert(row, { onConflict: 'guild_id,discord_id' });
      if (error) throw new Error(error.message);

      // Append-only log, separate from the upserted "current" row above — this
      // is what lets a member's gear progression be viewed over time instead
      // of only ever showing their latest submission.
      const { maxed_at, ...historyRow } = row;
      await db.from('gear_level_history').insert(historyRow).then(({ error: histErr }) => {
        if (histErr) console.error('gear_level_history insert failed:', histErr.message);
      });

      return row;
    },

    async historyForMember(guildId, discordId) {
      const { data, error } = await tenantDb(supabase, guildId).from('gear_level_history')
        .select('*').eq('discord_id', discordId).order('submitted_at', { ascending: false });
      if (error) { console.error('gearIlvl.historyForMember error:', error.message); return []; }
      return data || [];
    },

    async forMember(guildId, discordId) {
      const { data, error } = await tenantDb(supabase, guildId)
        .from('gear_levels').select('*').eq('discord_id', discordId).single();
      if (error) return null;
      return data;
    },

    async all(guildId) {
      const { data, error } = await tenantDb(supabase, guildId).from('gear_levels').select('*');
      if (error) { console.error('gearIlvl.all error:', error.message); return []; }
      return data || [];
    },
  };
};

// Exposed directly too, for the standalone CLI test script (no supabase needed).
module.exports.parseGearScreenshot = parseGearScreenshot;
