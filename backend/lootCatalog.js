const { tenantDb } = require('./tenantDb');

const PRIORITIES = ['PvP', 'Second Build', 'PvE'];

// Built once at boot, so it carries no guild — every method takes `guildId`
// first (the bare id; this module needs no per-guild config, unlike loa and
// attendance which take the whole row).
//
// Scoping here is a CORRECTNESS requirement, not just isolation. Phase 1 made
// loot_categories.key and loot_items.key composite with guild_id, precisely so
// two guilds can both have a "weapons" category and their own "weapons__sword".
// An unscoped .eq('key', …) now matches whichever guild's row the database
// happens to return first — every lookup below has to be guild-qualified.
module.exports = function createLootCatalog(supabase) {
  function slugify(category, name) {
    const prefix = category.replace(/\s+/g, '_').toLowerCase();
    const suffix = name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_').toLowerCase();
    return `${prefix}__${suffix}`;
  }

  async function getCatalog(guildId) {
    const db = tenantDb(supabase, guildId);
    const { data: cats } = await db
      .from('loot_categories').select('key, label, sort_order')
      .order('sort_order').order('label');
    const { data: items } = await db
      .from('loot_items').select('key, category_key, name, sort_order, image_url, description, grade, questlog_data')
      .order('sort_order').order('name');
    const categories = (cats || []).map((c) => ({
      key: c.key,
      label: c.label,
      items: (items || []).filter((i) => i.category_key === c.key).map((i) => ({
        key: i.key, name: i.name, image_url: i.image_url || null, description: i.description || null,
        grade: i.grade || null, questlog_data: i.questlog_data || null,
      })),
    }));
    return { priorities: PRIORITIES, categories };
  }

  async function getKeys(guildId) {
    const { data } = await tenantDb(supabase, guildId).from('loot_items').select('key');
    return new Set((data || []).map((r) => r.key));
  }

  return {
    priorities: new Set(PRIORITIES),

    getCatalog,
    getKeys,

    async addCategory(guildId, label) {
      const db = tenantDb(supabase, guildId);
      const key = label.replace(/\s+/g, '_').toLowerCase();
      // Scoped duplicate check: another guild already owning this key must not
      // block this guild from creating its own.
      const { data: existing } = await db.from('loot_categories').select('key').eq('key', key).single();
      if (existing) return null;
      // Scoped max: sort_order is per-guild, so a busy tenant's ordering must
      // not push a new guild's first category to position 900.
      const { data: maxRow } = await db.from('loot_categories').select('sort_order').order('sort_order', { ascending: false }).limit(1).single();
      const sort_order = (maxRow?.sort_order ?? -1) + 1;
      const { error } = await db.from('loot_categories').insert({ key, label, sort_order });
      if (error) return null;
      return { key, label, items: [] };
    },

    async renameCategory(guildId, catKey, newLabel) {
      const { error } = await tenantDb(supabase, guildId)
        .from('loot_categories').update({ label: newLabel }).eq('key', catKey);
      return !error;
    },

    async deleteCategory(guildId, catKey) {
      const db = tenantDb(supabase, guildId);
      // Both deletes scoped: unscoped, deleting a category would take every
      // other guild's identically-keyed items with it.
      await db.from('loot_items').delete().eq('category_key', catKey);
      const { error } = await db.from('loot_categories').delete().eq('key', catKey);
      return !error;
    },

    async addItem(guildId, catKey, name) {
      const db = tenantDb(supabase, guildId);
      const { data: cat } = await db.from('loot_categories').select('key').eq('key', catKey).single();
      if (!cat) return null;
      const itemKey = slugify(catKey, name);
      const { data: existing } = await db.from('loot_items').select('key').eq('key', itemKey).single();
      if (existing) return null;
      const { data: maxRow } = await db.from('loot_items').select('sort_order').eq('category_key', catKey).order('sort_order', { ascending: false }).limit(1).single();
      const sort_order = (maxRow?.sort_order ?? -1) + 1;
      const { error } = await db.from('loot_items').insert({ key: itemKey, category_key: catKey, name, sort_order });
      if (error) return null;
      return { key: itemKey, name };
    },

    async editItem(guildId, itemKey, updates) {
      const patch = {};
      if (updates.name !== undefined) patch.name = updates.name;
      if (updates.image_url !== undefined) patch.image_url = updates.image_url || null;
      if (updates.description !== undefined) patch.description = updates.description || null;
      if (updates.questlog_id !== undefined) patch.questlog_id = updates.questlog_id || null;
      if (updates.grade !== undefined) patch.grade = updates.grade || null;
      if (updates.questlog_data !== undefined) patch.questlog_data = updates.questlog_data || null;
      if (Object.keys(patch).length === 0) return false;
      const { error } = await tenantDb(supabase, guildId)
        .from('loot_items').update(patch).eq('key', itemKey);
      if (error) console.error('lootCatalog editItem error:', error.message);
      return !error;
    },

    async deleteItem(guildId, itemKey) {
      const { error } = await tenantDb(supabase, guildId)
        .from('loot_items').delete().eq('key', itemKey);
      return !error;
    },
  };
};
