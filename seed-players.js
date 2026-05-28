// seed-players.js
// Run this once after deploying to import your existing roster into Vercel KV.
// Usage: ADMIN_PASSWORD=your_password node seed-players.js

// Paste your existing allPlayers array here (from your old HTML):
const players = [
  // EXAMPLE FORMAT — replace with your full list:
  // {name:"PlayerName", team:"Atlanta Hawks", salary:10000000},
  // {name:"FreeAgent1", team:"Free Agent", salary:5000000},
];

const SITE_URL = 'https://rplmastersheet.vercel.app/'; // ← change this

// Read password from environment — never hard-code credentials in source files
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
