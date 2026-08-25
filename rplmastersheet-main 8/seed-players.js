// seed-players.js
// Run this once to import your roster into Vercel KV.
// Usage: ADMIN_PASSWORD=your_password node seed-players.js
//
// Each player entry supports an optional discordId field.
// When provided, the player is stored under their Discord snowflake ID —
// exactly matching what /api/sync and /api/callback produce — so salaries
// survive future syncs without any name-matching heuristics.
//
// Players WITHOUT a discordId fall back to a manual_* key (same as addPlayer).
// You can backfill IDs later by running sync, which will migrate them.

const players = [
  // With Discord ID (preferred — salary survives syncs):
  // { discordId: '123456789012345678', name: 'PlayerName', team: 'Atlanta Hawks', salary: 10000000 },

  // Without Discord ID (manual key, name-matched on first sync):
  // { name: 'FreeAgent1', team: 'Free Agent', salary: 5000000 },
];

const SITE_URL = 'https://rplmastersheet.vercel.app'; // ← no trailing slash

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('Error: Set the ADMIN_PASSWORD environment variable before running.');
  console.error('  Usage: ADMIN_PASSWORD=yourpassword node seed-players.js');
  process.exit(1);
}

async function seed() {
  const res = await fetch(`${SITE_URL}/api/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD, players })
  });
  const data = await res.json();
  console.log(data);
}

seed();
