import identity from '../../shared/guild.json';

// Guild identity — edit here to rebrand the whole hub.
//
// The name and alias list live in shared/guild.json because the backend needs
// the same values: server.js collapses past guild names onto the current one so
// a rename doesn't split the war record, and admin.js stamps the house name on
// the Discord roster embed. Keeping them in one file means a rename can't leave
// the two halves disagreeing — which is a silent failure, since an unrecognised
// name is treated as an enemy guild rather than raising anything.
//
// `house` is the ceremonial name shown large; `tag` is the active in-game tag.
// Voice and lore stay here — nothing outside the frontend needs them.
export const GUILD = {
  ...identity,
  motto:  'Clump. Collide. Conquer.',
  creed:  'We do not wait for the fight to come to us — we bring the fight, and we bring all of it at once. No lone blades, no scattered lines: we stack as one mass and move as one weight, so that when we land, nothing standing there is still standing after. Momentum is our weapon before the first hit ever lands. We are not the guild that reacts. We are the one that arrives.',
};
