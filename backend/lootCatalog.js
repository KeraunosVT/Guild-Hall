const PRIORITIES = ['PvP', 'Second Build', 'PvE'];

module.exports = function createLootCatalog(supabase) {
  function slugify(category, name) {
    const prefix = category.replace(/\s+/g, '_').toLowerCase();
    const suffix = name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_').toLowerCase();
    return `${prefix}__${suffix}`;
  }

  async function getCatalog() {
    const { data: cats } = await supabase
      .from('loot_categories').select('key, label, sort_order')
      .order('sort_order').order('label');
    const { data: items } = await supabase
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

  async function getKeys() {
    const { data } = await supabase.from('loot_items').select('key');
    return new Set((data || []).map((r) => r.key));
  }

  return {
    priorities: new Set(PRIORITIES),

    getCatalog,
    getKeys,

    async addCategory(label) {
      const key = label.replace(/\s+/g, '_').toLowerCase();
      const { data: existing } = await supabase.from('loot_categories').select('key').eq('key', key).single();
      if (existing) return null;
      const { data: maxRow } = await supabase.from('loot_categories').select('sort_order').order('sort_order', { ascending: false }).limit(1).single();
      const sort_order = (maxRow?.sort_order ?? -1) + 1;
      const { error } = await supabase.from('loot_categories').insert({ key, label, sort_order });
      if (error) return null;
      return { key, label, items: [] };
    },

    async renameCategory(catKey, newLabel) {
      const { error } = await supabase.from('loot_categories').update({ label: newLabel }).eq('key', catKey);
      return !error;
    },

    async deleteCategory(catKey) {
      await supabase.from('loot_items').delete().eq('category_key', catKey);
      const { error } = await supabase.from('loot_categories').delete().eq('key', catKey);
      return !error;
    },

    async addItem(catKey, name) {
      const { data: cat } = await supabase.from('loot_categories').select('key').eq('key', catKey).single();
      if (!cat) return null;
      const itemKey = slugify(catKey, name);
      const { data: existing } = await supabase.from('loot_items').select('key').eq('key', itemKey).single();
      if (existing) return null;
      const { data: maxRow } = await supabase.from('loot_items').select('sort_order').eq('category_key', catKey).order('sort_order', { ascending: false }).limit(1).single();
      const sort_order = (maxRow?.sort_order ?? -1) + 1;
      const { error } = await supabase.from('loot_items').insert({ key: itemKey, category_key: catKey, name, sort_order });
      if (error) return null;
      return { key: itemKey, name };
    },

    async editItem(itemKey, updates) {
      const patch = {};
      if (updates.name !== undefined) patch.name = updates.name;
      if (updates.image_url !== undefined) patch.image_url = updates.image_url || null;
      if (updates.description !== undefined) patch.description = updates.description || null;
      if (updates.questlog_id !== undefined) patch.questlog_id = updates.questlog_id || null;
      if (updates.grade !== undefined) patch.grade = updates.grade || null;
      if (updates.questlog_data !== undefined) patch.questlog_data = updates.questlog_data || null;
      if (Object.keys(patch).length === 0) return false;
      const { error } = await supabase.from('loot_items').update(patch).eq('key', itemKey);
      if (error) console.error('lootCatalog editItem error:', error.message);
      return !error;
    },

    async deleteItem(itemKey) {
      const { error } = await supabase.from('loot_items').delete().eq('key', itemKey);
      return !error;
    },
  };
};
