// Boot the real server as a child process for the integration tests.
//
// Multi-tenant mode (SINGLE_GUILD_ID cleared) so the active guild comes from
// the x-guild-id header — that is the code path a hosted deployment runs, and
// the one where a scoping mistake actually costs something. The bot token is
// cleared too, so nothing reaches Discord.
const { spawn } = require('child_process');
const path = require('path');

// EVERY START GETS ITS OWN PORT.
//
// Reusing one port across sequential starts made the suite flaky in two ways,
// and the second is the dangerous one:
//   - the previous server may not have released the port yet -> EADDRINUSE;
//   - worse, the health poll can be answered by that still-dying server, so
//     startServer resolves and the test then runs against the WRONG process,
//     with the previous fixture's env. That fails intermittently and lies about
//     why. Distinct ports make both impossible.
const BASE_PORT = parseInt(process.env.TEST_PORT, 10) || 4097;
let offset = 0;

// `extraEnv` lets a suite hand the server a fixture — notably STUB_DISCORD with
// --require test/lib/discordStub.js, which makes the real OAuth callback
// runnable without any Discord traffic.
function startServer(extraEnv = {}) {
  const port = BASE_PORT + (offset++);
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...process.env,
      PORT: String(port), SINGLE_GUILD_ID: '', DISCORD_BOT_TOKEN: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = [];
  child.stdout.on('data', (d) => log.push(d.toString()));
  child.stderr.on('data', (d) => log.push(d.toString()));

  // Resolves once the process has actually gone, so a caller can await teardown
  // instead of racing the next start.
  const exited = new Promise((resolve) => child.on('exit', resolve));

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const poll = async () => {
      try {
        const r = await fetch(`${base}/api/health`);
        if (r.ok) {
          return resolve({
            child, BASE: base, port,
            stop: () => { child.kill(); return exited; },
          });
        }
      } catch { /* not up yet */ }
      if (Date.now() > deadline) {
        child.kill();
        return reject(new Error(`server did not start within 30s on ${port}:\n` + log.join('')));
      }
      setTimeout(poll, 200);
    };
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`server exited ${code}:\n` + log.join('')));
    });
    poll();
  });
}

module.exports = { startServer };
