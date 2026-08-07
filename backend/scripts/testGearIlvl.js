// backend/scripts/testGearIlvl.js — standalone CLI test for extracting gear item
// levels (ilvl) from a Throne & Liberty character-equipment screenshot.
//
// Calls the exact same extraction function the real website endpoint uses
// (backend/gearIlvl.js), so a good result here is a good result in production.
//
// Usage:
//   node scripts/testGearIlvl.js path/to/screenshot.png
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { parseGearScreenshot } = require('../gearIlvl');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/testGearIlvl.js path/to/screenshot.png');
    process.exit(1);
  }

  const buffer = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

  const result = await parseGearScreenshot(buffer, mimeType);

  console.log('\nParsed equipment level:');
  console.table([{
    weapon: result.weapon,
    armor: result.armor,
    accessory: result.accessory,
    average: result.average,
  }]);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
