// Boot the real server as a child process for the integration tests.
//
// Multi-tenant mode (SINGLE_GUILD_ID cleared) so the active guild comes from
// the x-guild-id header — that is the code path a hosted deployment runs, and
// the one where a scoping mistake actually costs something. The bot token is
// cleared too, so nothing reaches Discord.
const { spawn } = require('child_process');
const path = require('path');

const PORT = parseInt(process.env.TEST_PORT, 10) || 4097;
const BASE = `http://127.0.0.1:${PORT}`;

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT), SINGLE_GUILD_ID: '', DISCORD_BOT_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = [];
  child.stdout.on('data', (d) => log.push(d.toString()));
  child.stderr.on('data', (d) => log.push(d.toString()));

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const poll = async () => {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) return resolve({ child, BASE, stop: () => child.kill() });
      } catch { /* not up yet */ }
      if (Date.now() > deadline) {
        child.kill();
        return reject(new Error('server did not start within 30s:\n' + log.join('')));
      }
      setTimeout(poll, 200);
    };
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`server exited ${code}:\n` + log.join('')));
    });
    poll();
  });
}

module.exports = { startServer, BASE, PORT };
