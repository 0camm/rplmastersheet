import { Redis } from '@upstash/redis';
import { ROLE_TO_TEAM, TEAM_TO_TAG } from './_lib/discord-teams.js';
import { salaryToRoleName, ALL_SALARY_ROLE_NAMES } from './_lib/salary-roles.js';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Shared Discord fetch helper with 429 (rate limit) retry handling, same
// pattern as sync.js. Supports non-GET methods since role add/remove need
// PUT/DELETE, unlike sync.js which only ever reads.
async function discordFetch(path, options = {}, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(`https://discord.com/api/v10${path}`, {
      method: options.method || 'GET',
      headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
    });
    if (r.status === 429 && attempt < retries) {
      const body = await r.json().catch(() => ({}));
      const waitMs = Math.ceil((body.retry_after ?? 1) * 1000) + 50;
      await new Promise(resolve => setTimeout(resolve, waitMs));
      continue;
    }
    if (r.status === 204) return null; // Discord returns 204 No Content on role add/remove
    if (!r.ok) throw new Error(`Discord ${r.status} on ${path}: ${await r.text()}`);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`Discord rate limit exceeded retries on ${path}`);
}

// REVERSE SYNC: push a team change made on the website back onto the
// member's actual Discord roles. Removes whatever team-tag role (or Free
// Agents) they currently hold and adds the role for their new team, so a
// member never ends up double-tagged. Team roles must be named like
// "[ATL] Atlanta Hawks" (same convention sync.js reads) for this to find them.
async function syncDiscordRole(discordUserId, newTeam) {
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) {
    return { skipped: true, reason: 'Discord bot not configured' };
  }
  const guildId = process.env.DISCORD_GUILD_ID;

  const allRoles = await discordFetch(`/guilds/${guildId}/roles`);
  const member = await discordFetch(`/guilds/${guildId}/members/${discordUserId}`).catch(() => null);
  if (!member) return { skipped: true, reason: 'member not found in Discord server (may have left)' };

  const roleMap = {};
  allRoles.forEach(r => { roleMap[r.id] = r.name; });

  // Every role this member holds that represents a team tag or Free Agents.
  const currentTeamRoleIds = (member.roles || []).filter(id => {
    const rName = roleMap[id] || '';
    const tagMatch = rName.match(/^\[([A-Z]+)\]/);
    return (tagMatch && ROLE_TO_TEAM[tagMatch[1]]) || rName === 'Free Agents';
  });

  // Which role (if any) corresponds to the new team.
  let targetRoleId = null;
  if (newTeam === 'Free Agent') {
    const faRole = allRoles.find(r => r.name === 'Free Agents');
    targetRoleId = faRole ? faRole.id : null;
  } else {
    const tag = TEAM_TO_TAG[newTeam];
    if (tag) {
      const teamRole = allRoles.find(r => r.name.startsWith(`[${tag}]`));
      targetRoleId = teamRole ? teamRole.id : null;
    }
  }

  const toRemove = currentTeamRoleIds.filter(id => id !== targetRoleId);
  const toAdd = targetRoleId && !currentTeamRoleIds.includes(targetRoleId) ? [targetRoleId] : [];

  for (const roleId of toRemove) {
    await discordFetch(`/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`, { method: 'DELETE' });
  }
  for (const roleId of toAdd) {
    await discordFetch(`/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`, { method: 'PUT' });
  }

  return { ok: true, removed: toRemove.length, added: toAdd.length, targetRoleFound: !!targetRoleId };
}

// REVERSE SYNC: push a salary change made on the website onto the member's
// Discord roles, tagging them with whichever bracket role matches their new
// salary (see _lib/salary-roles.js) and removing whatever bracket role they
// held before, so a member is never tagged with two brackets at once.
async function syncDiscordSalaryRole(discordUserId, salary) {
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) {
    return { skipped: true, reason: 'Discord bot not configured' };
  }
  const guildId = process.env.DISCORD_GUILD_ID;

  const allRoles = await discordFetch(`/guilds/${guildId}/roles`);
  const member = await discordFetch(`/guilds/${guildId}/members/${discordUserId}`).catch(() => null);
  if (!member) return { skipped: true, reason: 'member not found in Discord server (may have left)' };

  const roleMap = {};
  allRoles.forEach(r => { roleMap[r.id] = r.name; });

  const targetRoleName = salaryToRoleName(salary);
  const targetRole = allRoles.find(r => r.name === targetRoleName);

  // Every role this member holds that is one of our known salary-bracket roles.
  const currentBracketRoleIds = (member.roles || []).filter(id =>
    ALL_SALARY_ROLE_NAMES.includes(roleMap[id])
  );

  const toRemove = currentBracketRoleIds.filter(id => id !== targetRole?.id);
  const toAdd = targetRole && !currentBracketRoleIds.includes(targetRole.id) ? [targetRole.id] : [];

  for (const roleId of toRemove) {
    await discordFetch(`/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`, { method: 'DELETE' });
  }
  for (const roleId of toAdd) {
    await discordFetch(`/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`, { method: 'PUT' });
  }

  return { ok: true, removed: toRemove.length, added: toAdd.length, targetRoleFound: !!targetRole };
}

// BULK REVERSE SYNC: push every current player's salary bracket onto
// Discord in one pass. Fetches the role list and full member list ONCE
// (same pagination pattern as sync.js) instead of re-fetching per player,
// and only makes add/remove calls for players whose bracket actually
// needs to change — keeps this well under the function's time limit even
// on larger rosters. Skips manual/legacy (non-snowflake) entries.
async function bulkSyncSalaryRoles(playerEntries) {
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) {
    return { skipped: true, reason: 'Discord bot not configured' };
  }
  const guildId = process.env.DISCORD_GUILD_ID;

  const allRoles = await discordFetch(`/guilds/${guildId}/roles`);
  const roleNameById = {};
  const roleIdByName = {};
  allRoles.forEach(r => { roleNameById[r.id] = r.name; roleIdByName[r.name] = r.id; });

  let members = [], after = '0';
  while (true) {
    const batch = await discordFetch(`/guilds/${guildId}/members?limit=1000&after=${after}`);
    members = members.concat(batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }
  const memberById = {};
  members.forEach(m => { memberById[m.user.id] = m; });

  let updated = 0, skipped = 0, failed = 0;

  for (const [id, player] of playerEntries) {
    if (!/^\d{15,20}$/.test(id)) { skipped++; continue; }
    const member = memberById[id];
    if (!member) { skipped++; continue; } // left the server

    const targetRoleName = salaryToRoleName(player.salary);
    const targetRoleId = roleIdByName[targetRoleName];
    if (!targetRoleId) { skipped++; continue; } // that bracket role doesn't exist in Discord

    const currentBracketRoleIds = (member.roles || []).filter(rid =>
      ALL_SALARY_ROLE_NAMES.includes(roleNameById[rid])
    );
    const toRemove = currentBracketRoleIds.filter(rid => rid !== targetRoleId);
    const alreadyHasTarget = currentBracketRoleIds.includes(targetRoleId);

    if (toRemove.length === 0 && alreadyHasTarget) continue; // already correct, nothing to send

    try {
      for (const roleId of toRemove) {
        await discordFetch(`/guilds/${guildId}/members/${id}/roles/${roleId}`, { method: 'DELETE' });
      }
      if (!alreadyHasTarget) {
        await discordFetch(`/guilds/${guildId}/members/${id}/roles/${targetRoleId}`, { method: 'PUT' });
      }
      updated++;
    } catch (err) {
      failed++;
    }
  }

  return { ok: true, updated, skipped, failed };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const { password, action, name, salary, team, newName } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const raw = await redis.hgetall('players');
  // BUGFIX: normalize possible string-shaped values (see sync.js/callback.js) —
  // otherwise name/salary lookups below silently miss for those entries.
  const players = raw
    ? Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? JSON.parse(v) : v])
    : [];

  // Prefer stable Discord ID lookup; fall back to name for manually-added / legacy entries
  const { id: targetId } = req.body;
  const entry = (targetId && players.find(([key]) => key === targetId))
    || players.find(([, p]) => p.name.toLowerCase() === name?.toLowerCase());

  // purgeStaff: cross-reference Discord roles, delete anyone who is Coach or Owner
  if (action === 'purgeStaff') {
    const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
    const DISCORD_GUILD_ID  = process.env.DISCORD_GUILD_ID;
    async function dFetch(path) {
      const r = await fetch(`https://discord.com/api/v10${path}`, {
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
      });
      if (!r.ok) throw new Error(`Discord ${r.status} on ${path}`);
      return r.json();
    }
    const allRoles = await dFetch(`/guilds/${DISCORD_GUILD_ID}/roles`);
    const roleMap = {};
    allRoles.forEach(r => roleMap[r.id] = r.name);
    let members = [], after = '0';
    while (true) {
      const batch = await dFetch(`/guilds/${DISCORD_GUILD_ID}/members?limit=1000&after=${after}`);
      members = members.concat(batch);
      if (batch.length < 1000) break;
      after = batch[batch.length - 1].user.id;
    }
    const coachIds = new Set();
    const coachNames = new Set();
    for (const m of members) {
      if (m.user?.bot) continue;
      const roleNames = (m.roles || []).map(id => roleMap[id]).filter(Boolean);
      // Only purge coaches — owners keep their salary cap entries
      if (roleNames.includes('Team Coaches')) {
        coachIds.add(m.user.id);
        coachNames.add(m.user.username.toLowerCase());
      }
    }
    // Delete any KV entry whose key OR name matches a coach
    const toDelete = players
      .filter(([id, p]) => coachIds.has(id) || coachNames.has(p.name?.toLowerCase()))
      .map(([id]) => id);
    if (toDelete.length > 0) await redis.hdel('players', ...toDelete);
    return res.json({ ok: true, message: `Purged ${toDelete.length} coach entr${toDelete.length===1?'y':'ies'} from players` });
  }

  if (action === 'setSalary') {
    if (!entry) return res.status(404).json({ error: `Player "${name}" not found` });
    const [id, player] = entry;
    const newSalary = Number(salary);
    await redis.hset('players', { [id]: { ...player, salary: newSalary } });

    // REVERSE SYNC: only meaningful for real Discord accounts — manually
    // added / legacy entries are keyed by a "manual_..." string, not a
    // Discord snowflake, so there's no Discord member to update.
    let discordNote = '';
    if (/^\d{15,20}$/.test(id)) {
      try {
        const result = await syncDiscordSalaryRole(id, newSalary);
        if (result.skipped) {
          discordNote = ` (Discord not updated: ${result.reason})`;
        } else if (!result.targetRoleFound) {
          discordNote = ` (Discord role "${salaryToRoleName(newSalary)}" not found — create a role with that exact name)`;
        }
      } catch (err) {
        discordNote = ` (Discord role update failed: ${err.message})`;
      }
    }

    return res.json({ ok: true, message: `${player.name} salary set to $${newSalary.toLocaleString()}${discordNote}` });
  }

  // BULK REVERSE SYNC: push every current player's salary bracket onto
  // Discord in one pass. Meant to be run once when the salary-role feature
  // is first turned on (so existing players get tagged for the first time),
  // and afterwards as a manual "fix drift" button if roles are ever hand-
  // edited in Discord. Skips manual/legacy (non-snowflake) entries.
  if (action === 'syncSalaryRoles') {
    try {
      const result = await bulkSyncSalaryRoles(players);
      if (result.skipped) {
        return res.json({ ok: true, message: `Salary role sync skipped: ${result.reason}` });
      }
      return res.json({
        ok: true,
        message: `Salary role sync complete — ${result.updated} updated, ${result.skipped} skipped, ${result.failed} failed`
      });
    } catch (err) {
      console.error('Bulk salary role sync error:', err);
      return res.status(500).json({ error: `Salary role sync failed: ${err.message}` });
    }
  }

  if (action === 'setTeam') {
    if (!entry) return res.status(404).json({ error: `Player "${name}" not found` });
    const [id, player] = entry;
    await redis.hset('players', { [id]: { ...player, team } });

    // REVERSE SYNC: only meaningful for real Discord accounts — manually
    // added / legacy entries are keyed by a "manual_..." string, not a
    // Discord snowflake, so there's no Discord member to update.
    let discordNote = '';
    if (/^\d{15,20}$/.test(id)) {
      try {
        const result = await syncDiscordRole(id, team);
        if (result.skipped) {
          discordNote = ` (Discord not updated: ${result.reason})`;
        } else if (!result.targetRoleFound) {
          discordNote = ` (Discord role for "${team}" not found — team roles must be named like "[TAG] Team Name")`;
        }
      } catch (err) {
        discordNote = ` (Discord role update failed: ${err.message})`;
      }
    }

    return res.json({ ok: true, message: `${player.name} moved to ${team}${discordNote}` });
  }

  if (action === 'removePlayer') {
    // If a stable ID was provided, delete exactly that entry; otherwise fall back to name (catches duplicates)
    const allMatches = targetId
      ? players.filter(([key]) => key === targetId)
      : players.filter(([, p]) => p.name.toLowerCase() === name?.toLowerCase());
    if (!allMatches.length) return res.status(404).json({ error: `Player "${name}" not found` });
    await redis.hdel('players', ...allMatches.map(([id]) => id));
    return res.json({ ok: true, message: `${name} removed (${allMatches.length} entr${allMatches.length===1?'y':'ies'})` });
  }

  if (action === 'addPlayer') {
    const id = `manual_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await redis.hset('players', {
      [id]: { id, name, team: team || 'Free Agent', salary: Number(salary) || 2000000 }
    });
    return res.json({ ok: true, message: `${name} added to ${team || 'Free Agent'} at $${(Number(salary)||2000000).toLocaleString()}` });
  }

  if (action === 'renamePlayer') {
    if (!entry) return res.status(404).json({ error: `Player "${name}" not found` });
    const [id, player] = entry;
    await redis.hset('players', { [id]: { ...player, name: newName } });
    return res.json({ ok: true, message: `${name} renamed to ${newName}` });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
