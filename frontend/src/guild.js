import identity from '../../shared/guild.json';

// The guild's own voice — the half of the branding that is prose rather than
// data. The machine-readable half (name, tag, aliases, timezone, rollover)
// lives in shared/guild.json, because the backend needs it too; nothing here
// is read by the server, so it stays frontend-only.
//
// Note the two names never mix: "Guild Hall" is the application, and is
// hardcoded wherever the app refers to itself (page title, footer). Everything
// below is whatever *your* guild is called and believes. Re-theming a fork
// means editing this file and guild.json — not renaming the app.

// Shown large in the UI, from the shared config so it can't drift from the
// name the backend matches scoreboards against.
export const house = identity.house;

// One line, displayed under the house name. Keep it short — it sits in a
// header, not a paragraph.
export const motto = 'TODO: your guild motto';

// The longer statement of what the guild expects of its members. Rendered as
// a list, one string per line; add or remove lines freely.
export const creed = [
  'TODO: first line of your creed',
  'TODO: second line of your creed',
  'TODO: third line of your creed',
];

// Path to the emblem in frontend/public/. Replace the file rather than this
// string, so the favicon in index.html keeps pointing at the same asset.
export const sigil = '/sigil.svg';

export default { house, motto, creed, sigil };
