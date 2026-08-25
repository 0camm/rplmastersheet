import { Redis } from '@upstash/redis';
import { ROLE_TO_TEAM } from '../_lib/discord-teams.js';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return res.status(400).send('Token exchange failed');

  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const user = await userRes.json();

  const memberRes = await fetch(
    `https://discord.com/api/users/@me/guilds/${process.env.DISCORD_GUILD_ID}/member`,
    { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
  );
  const member = await memberRes.json();

  if (!member.roles) return res.status(400).send('Could not read roles.');

  const rolesRes = await fetch(
    `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/roles`,
    { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } }
  );
  const allRoles = await rolesRes.json();

  const memberRoleNames = member.roles.map(id => {
    const found = allRoles.find(r => r.id === id);
    return found ? found.name : null;
  }).filter(Boolean);

  const username = user.username;

  if (memberRoleNames.includes('Team Coaches')) {
    // FIX: await the delete so the coach entry is actually gone before redirect.
    // Without await, the redirect fires first and the entry leaks into the roster.
    const existing = await redis.hget('players', user.id);
    if (existing) await redis.hdel('players', user.id);
    return res.redirect('/?registered=1');
  }

  let assignedTeam = 'Free Agent';
  for (const roleName of memberRoleNames) {
    const match = roleName.match(/^\[([A-Z]+)\]/);
    if (match && ROLE_TO_TEAM[match[1]]) {
      assignedTeam = ROLE_TO_TEAM[match[1]];
      break;
    }
  }

  const existingRaw = await redis.hget('players', user.id);
  // BUGFIX: hget/hgetall can return either a parsed object or a raw JSON
  // string depending on how an entry was originally written (seed.js vs
  // addPlayer vs sync). This wasn't normalized here, so `existing?.salary`
  // could silently be undefined even when a real snowflake entry existed —
  // pushing every login onto the legacy name-matching fallback below and,
  // if the username had since changed, straight into the $2M default.
  const existing = typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw;
  let salary = existing?.salary;

  // BUGFIX: this only matched a legacy manual_* entry by the user's CURRENT
  // username, but manual entries are seeded under whatever name the admin
  // typed at the time. If the user had renamed on Discord even once before
  // their first login, the match always failed (defaulting to $2M) — and
  // worse, the stale manual_* entry was never deleted, so it kept showing
  // up on the roster forever under the old name while a second, separate
  // $2M entry appeared under the new name. We now also match on the
  // Discord-verified previous username where available, and — whichever
  // way the legacy entry is found — delete it once its salary has been
  // migrated so it stops showing up as a ghost duplicate.
  let legacyKeyToRemove = null;
  if (salary == null) {
    const allPlayersRaw = await redis.hgetall('players') || {};
    const allPlayers = {};
    for (const [k, v] of Object.entries(allPlayersRaw)) {
      allPlayers[k] = typeof v === 'string' ? JSON.parse(v) : v;
    }
    const candidateNames = new Set([username.toLowerCase()]);
    if (user.global_name) candidateNames.add(user.global_name.toLowerCase());

    for (const [key, p] of Object.entries(allPlayers)) {
      if (!/^\d{15,20}$/.test(key) && p?.name && candidateNames.has(p.name.toLowerCase()) && p.salary != null) {
        salary = p.salary;
        legacyKeyToRemove = key;
        break;
      }
    }
    salary = salary ?? 2000000;
  }

  await redis.hset('players', {
    [user.id]: { id: user.id, name: username, team: assignedTeam, salary }
  });
  // Clean up the migrated legacy entry so the old username stops appearing
  // as a stale duplicate row on the roster.
  if (legacyKeyToRemove) {
    await redis.hdel('players', legacyKeyToRemove);
  }

  const sessionToken = crypto.randomUUID();
  await redis.set(`session:${sessionToken}`, JSON.stringify({ name: username, team: assignedTeam }), { ex: 3600 });

  res.setHeader('Set-Cookie', `rpl_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`);
  res.redirect('/?registered=1');
}
