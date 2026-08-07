// backend/scripts/mirrorCurrencyIcons.js — copy currency icons into our own
// Supabase storage bucket instead of hotlinking questlog's CDN.
//
// Same reasoning as questlogImport.js, which downloads item icons and re-uploads
// them rather than pointing at the source: a hotlinked asset breaks silently
// whenever the other side reorganises, and every stored image_url in loot_items
// already lives in our bucket. Currency icons should match.
//
// Usage:
//   node scripts/mirrorCurrencyIcons.js               # mirror the known set
//   node scripts/mirrorCurrencyIcons.js <key> <url>    # mirror one more
//
// Re-runnable: uploads use upsert, so the same key overwrites in place and the
// public URL never changes.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'assets';
const ICON_PREFIX = 'currency-icons/';

// Shard icons can be added here as their source URLs turn up, or passed on the
// command line — the shard keys are in shared/shards.json.
//
// The archboss pieces are I_Arcboss_piece_001..003; only those three exist
// (004+ are 404), so the five shard types in shards.json can't each have their
// own. Which piece belongs to which shard is a game-knowledge call, not
// something the filenames give away.
const MISC = 'https://cdn.questlog.gg/throne-and-liberty/assets/Game/Image/Icon/Item_128/Misc';
const ARCBOSS_PIECE = (n) => `${MISC}/I_Arcboss_piece_${n}.webp`;

const KNOWN = {
  lucent: 'https://cdn.questlog.gg/throne-and-liberty/assets/Game/Image/Icon/BM_Large/ICO_BMCoin_Gold_BM.webp',
  tevent_ashen: ARCBOSS_PIECE('001'),
  queen_ashen_carapace: ARCBOSS_PIECE('002'), // Queen Bellandir
  thundercloud_scale: ARCBOSS_PIECE('003'),
  scorched_frostblooms: `${MISC}/BFB_Ice_Flower_001.webp`,
  scorched_branches: `${MISC}/BFB_IT_BroorkTree_001.webp`,
};

// If another currency is ever added: don't bother searching questlog's item API
// for its icon. These are currency assets and appear nowhere in
// database.getItems under any category, and the filenames aren't derivable
// either — the set above spans ICO_BMCoin_Gold_BM, I_Arcboss_piece_00N,
// BFB_Ice_Flower_001 and BFB_IT_BroorkTree_001. Take the path off a questlog
// page by hand and pass it on the command line.

async function mirror(supabase, key, url) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(res.data);
  const contentType = res.headers['content-type'] || 'image/webp';
  const ext = contentType.includes('png') ? 'png' : 'webp';
  const storagePath = `${ICON_PREFIX}${key}.${ext}`;

  const { error } = await supabase.storage.from(BUCKET)
    .upload(storagePath, buffer, { contentType, upsert: true });
  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return { publicUrl: data.publicUrl, bytes: buffer.length, contentType };
}

async function main() {
  const [argKey, argUrl] = process.argv.slice(2);
  if (argKey && !argUrl) {
    console.error('Usage: node scripts/mirrorCurrencyIcons.js [<key> <url>]');
    process.exit(1);
  }
  const jobs = argKey ? { [argKey]: argUrl } : KNOWN;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  for (const [key, url] of Object.entries(jobs)) {
    try {
      const { publicUrl, bytes, contentType } = await mirror(supabase, key, url);
      console.log(`\n${key}`);
      console.log(`  source: ${url}`);
      console.log(`  stored: ${publicUrl}`);
      console.log(`  ${bytes} bytes, ${contentType}`);

      // Prove the uploaded copy is actually reachable, not just accepted.
      const check = await axios.get(publicUrl, { responseType: 'arraybuffer', validateStatus: () => true });
      console.log(`  verify: HTTP ${check.status}${check.status === 200 ? ` (${check.data.byteLength} bytes back)` : ''}`);
    } catch (err) {
      console.error(`\n${key}: FAILED — ${err.message}`);
    }
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
