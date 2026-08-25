import { randomUUID } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { ROLE_TO_TEAM, TEAM_TO_TAG } from './_lib/discord-teams.js';
import { salaryToRoleName, ALL_SALARY_ROLE_NAMES } from './_lib/salary-roles.js';
import { logAudit } from './_lib/audit-log.js';

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

// SYNC SESSION STORAGE: bulk salary-role sync no longer runs to completion
// in one request (see notes below on why). Instead the in-progress state —
// remaining work items, cursor position, running counters — lives in Redis
// under a short-lived session key, keyed by a syncId the client hands back
// on each follow-up call. TTL just needs to outlast a full sync's worth of
// chunked requests; it's not meant to survive between separate sync runs.
const SYNC_SESSION_TTL_SECONDS = 600; // 10 minutes

async function getSyncSession(syncId) {
  const raw = await redis.get(`salsync:${syncId}`);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
async function saveSyncSession(syncId, session) {
  await redis.set(`salsync:${syncId}`, JSON.stringify(session), { ex: SYNC_SESSION_TTL_SECONDS });
}
async function deleteSyncSession(syncId) {
  await redis.del(`salsync:${syncId}`);
}

// BULK REVERSE SYNC, PART 1 (read-only, always fast): fetch the role list
// and full member list ONCE (same pagination pattern as sync.js), then
// diff every player against Discord to build the list of add/remove work
// items. No role-modification calls happen here, so this step isn't
// subject to Discord's role-mutation rate limit and comfortably finishes
// in a single request even for a large guild.
async function prepareSalarySync(playerEntries) {
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

  let skipped = 0;
  const skipReasons = { notDiscordAccount: 0, leftServer: 0, roleNotFound: 0 };

  const workItems = [];
  for (const [id, player] of playerEntries) {
    if (!/^\d{15,20}$/.test(id)) { skipped++; skipReasons.notDiscordAccount++; continue; }
    const member = memberById[id];
    if (!member) { skipped++; skipReasons.leftServer++; continue; } // left the server

    const targetRoleName = salaryToRoleName(player.salary);
    const targetRoleId = roleIdByName[targetRoleName];
    if (!targetRoleId) { skipped++; skipReasons.roleNotFound++; continue; } // that bracket role doesn't exist in Discord

    const currentBracketRoleIds = (member.roles || []).filter(rid =>
      ALL_SALARY_ROLE_NAMES.includes(roleNameById[rid])
    );
    const toRemove = currentBracketRoleIds.filter(rid => rid !== targetRoleId);
    const alreadyHasTarget = currentBracketRoleIds.includes(targetRoleId);

    if (toRemove.length === 0 && alreadyHasTarget) continue; // already correct, nothing to send

    workItems.push({ id, toRemove, toAdd: alreadyHasTarget ? [] : [targetRoleId] });
  }

  return { workItems, skipped, skipReasons, knownRoleNames: Object.keys(roleIdByName) };
}

// BULK REVERSE SYNC, PART 2 (the actual rate-limited work): process work
// items sequentially — NOT concurrently — starting from session.cursor,
// until either everything is done or a time budget is used up.
//
// Why sequential: a previous fix bumped this loop to 8-way concurrency to
// cut wall-clock time, on the assumption the bottleneck was our own code
// running requests one at a time. It wasn't — Discord enforces a
// guild-wide rate limit on role-modification calls specifically, so firing
// requests in parallel just means more of them arrive back-to-back and get
// 429'd; discordFetch's retry/backoff then eats the time "saved" by
// concurrency anyway. Total throughput is capped by Discord regardless of
// how many requests we have in flight, so there's no wall-clock win to be
// had — running sequentially is just as fast in practice and far simpler
// to reason about and resume.
//
// Why chunked: for a roster with many role changes (e.g. the first time
// salary-bracket roles are being applied), the total work can legitimately
// take longer than Vercel's 60s function limit no matter how it's
// scheduled. So instead of trying to finish in one request, each
// invocation works for a bounded time budget, persists exactly where it
// left off, and reports back "not done yet" so the caller can invoke again
// to continue. This finishes correctly regardless of roster size or how
// strict Discord's rate limit turns out to be — it just takes as many
// follow-up requests as needed.
const SYNC_TIME_BUDGET_MS = 45000; // leaves headroom under the 60s function limit for setup/response overhead

async function processSalarySyncChunk(session) {
  const deadline = Date.now() + SYNC_TIME_BUDGET_MS;
  const { workItems, guildId } = session;
  while (session.cursor < workItems.length && Date.now() < deadline) {
    const item = workItems[session.cursor];
    try {
      for (const roleId of item.toRemove) {
        await discordFetch(`/guilds/${guildId}/members/${item.id}/roles/${roleId}`, { method: 'DELETE' });
      }
      for (const roleId of item.toAdd) {
        await discordFetch(`/guilds/${guildId}/members/${item.id}/roles/${roleId}`, { method: 'PUT' });
      }
      session.updated++;
    } catch (err) {
      session.failed++;
    }
    session.cursor++;
  }
  return session.cursor >= workItems.length; // true = done
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const { password, action, name, salary, team, newName, actor } = req.body;

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
    const coachTeamById = {};
    for (const m of members) {
      if (m.user?.bot) continue;
      const roleNames = (m.roles || []).map(id => roleMap[id]).filter(Boolean);
      // Only purge coaches — owners keep their salary cap entries
      if (roleNames.includes('Team Coaches')) {
        coachIds.add(m.user.id);
        coachNames.add(m.user.username.toLowerCase());
        let team = null;
        for (const rn of roleNames) {
          const tagMatch = rn.match(/^\[([A-Z]+)\]/);
          if (tagMatch && ROLE_TO_TEAM[tagMatch[1]]) { team = ROLE_TO_TEAM[tagMatch[1]]; break; }
        }
        coachTeamById[m.user.id] = team;
      }
    }

    // Any KV entry whose key OR name matches a coach gets removed from the
    // player salary cap system — but their cap is NOT discarded. It's
    // carried over into the separate 'coaches' hash (unless already tracked
    // there, in which case that preserved value is left untouched) so it
    // keeps contributing to the team's $30M Coach Salary Cap instead of
    // resetting to zero. This never touches the player cap system otherwise.
    const toDelete = players
      .filter(([id, p]) => coachIds.has(id) || coachNames.has(p.name?.toLowerCase()))
      .map(([id, p]) => [id, p]);

    const existingCoachesRaw = await redis.hgetall('coaches') || {};
    const existingCoaches = {};
    for (const [k, v] of Object.entries(existingCoachesRaw)) {
      existingCoaches[k] = typeof v === 'string' ? JSON.parse(v) : v;
    }

    const coachEntries = {};
    let preserved = 0;
    for (const [id, p] of toDelete) {
      if (existingCoaches[id]) continue; // already tracked — cap already preserved, don't touch it
      coachEntries[id] = {
        id,
        name: p.name,
        team: coachTeamById[id] ?? p.team ?? null,
        cap: typeof p.salary === 'number' ? p.salary : 2000000,
      };
      preserved++;
    }
    if (Object.keys(coachEntries).length > 0) await redis.hset('coaches', coachEntries);
    if (toDelete.length > 0) await redis.hdel('players', ...toDelete.map(([id]) => id));

    const purgeMsg = `Purged ${toDelete.length} coach entr${toDelete.length===1?'y':'ies'} from players (${preserved} coach cap${preserved===1?'':'s'} preserved into Coach Salary Cap)`;
    await logAudit({
      actor, action: 'Purge Staff', target: `${toDelete.length} entr${toDelete.length===1?'y':'ies'}`,
      details: toDelete.length ? purgeMsg : 'No coach entries found to remove'
    });
    return res.json({ ok: true, message: purgeMsg });
  }

  if (action === 'setSalary') {
    const newSalary = Number(salary);
    if (!Number.isFinite(newSalary) || newSalary < 0) {
      return res.status(400).json({ error: 'Invalid salary' });
    }

    if (entry) {
      const [id, player] = entry;
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

      await logAudit({
        actor, action: 'Set Salary', target: player.name,
        details: `$${(player.salary ?? 0).toLocaleString()} → $${newSalary.toLocaleString()}${discordNote}`
      });
      return res.json({ ok: true, message: `${player.name} salary set to $${newSalary.toLocaleString()}${discordNote}` });
    }

    // COACH CAP: not found in 'players' — a coach's cap lives separately in
    // the 'coaches' hash (moved there, preserved, when they became a coach;
    // see sync.js/purgeStaff above). Coaches must still be editable by
    // admins, so fall back to looking them up there. This branch never
    // touches the 'players' hash or the player salary cap system — it only
    // ever writes to 'coaches' and counts toward the separate $30M Coach
    // Salary Cap.
    const coachesRaw = await redis.hgetall('coaches') || {};
    const coachesList = Object.entries(coachesRaw).map(([k, v]) => [k, typeof v === 'string' ? JSON.parse(v) : v]);
    const coachEntry = (targetId && coachesList.find(([key]) => key === targetId))
      || coachesList.find(([, c]) => c.name?.toLowerCase() === name?.toLowerCase());

    if (!coachEntry) return res.status(404).json({ error: `Player "${name}" not found` });

    const [coachId, coach] = coachEntry;
    const oldCap = typeof coach.cap === 'number' ? coach.cap : 0;
    await redis.hset('coaches', { [coachId]: { ...coach, cap: newSalary } });

    await logAudit({
      actor, action: 'Set Coach Cap', target: coach.name,
      details: `$${oldCap.toLocaleString()} → $${newSalary.toLocaleString()} (Coach Salary Cap)`
    });
    return res.json({ ok: true, message: `${coach.name} coach cap set to $${newSalary.toLocaleString()}` });
  }

  // BULK REVERSE SYNC: push every current player's salary bracket onto
  // Discord. Meant to be run once when the salary-role feature is first
  // turned on (so existing players get tagged for the first time), and
  // afterwards as a manual "fix drift" button if roles are ever hand-edited
  // in Discord. Skips manual/legacy (non-snowflake) entries.
  //
  // Runs in timed chunks (see processSalarySyncChunk above) rather than to
  // completion in one request. First call omits syncId and gets one back
  // along with done:false; the client keeps calling with that same syncId
  // until it gets done:true. Progress lives in Redis between calls.
  if (action === 'syncSalaryRoles') {
    if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) {
      return res.json({ ok: true, done: true, message: 'Salary role sync skipped: Discord bot not configured' });
    }
    try {
      let syncId = req.body.syncId;
      let session;
      if (syncId) {
        session = await getSyncSession(syncId);
        if (!session) {
          return res.status(410).json({ error: 'Sync session expired or not found — please restart the sync.' });
        }
      } else {
        syncId = randomUUID();
        const prep = await prepareSalarySync(players);
        session = {
          guildId: process.env.DISCORD_GUILD_ID,
          workItems: prep.workItems,
          cursor: 0,
          updated: 0,
          failed: 0,
          skipped: prep.skipped,
          skipReasons: prep.skipReasons,
          knownRoleNames: prep.knownRoleNames,
        };
      }

      const done = await processSalarySyncChunk(session);

      if (done) {
        await deleteSyncSession(syncId);
        const doneMsg = `Salary role sync complete — ${session.updated} updated, ${session.skipped} skipped (${session.skipReasons.notDiscordAccount} manual, ${session.skipReasons.leftServer} left server, ${session.skipReasons.roleNotFound} missing role), ${session.failed} failed`;
        await logAudit({
          actor, action: 'Sync Salary Roles', target: 'All players',
          details: doneMsg
        });
        return res.json({
          ok: true,
          done: true,
          message: doneMsg,
          knownSalaryRoleNamesInDiscord: session.knownRoleNames
        });
      }

      await saveSyncSession(syncId, session);
      return res.json({
        ok: true,
        done: false,
        syncId,
        progress: { processed: session.cursor, total: session.workItems.length, updated: session.updated, failed: session.failed }
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

    await logAudit({
      actor, action: 'Set Team', target: player.name,
      details: `${player.team || 'Free Agent'} → ${team}${discordNote}`
    });
    return res.json({ ok: true, message: `${player.name} moved to ${team}${discordNote}` });
  }

  if (action === 'removePlayer') {
    // If a stable ID was provided, delete exactly that entry; otherwise fall back to name (catches duplicates)
    const allMatches = targetId
      ? players.filter(([key]) => key === targetId)
      : players.filter(([, p]) => p.name.toLowerCase() === name?.toLowerCase());
    if (!allMatches.length) return res.status(404).json({ error: `Player "${name}" not found` });
    await redis.hdel('players', ...allMatches.map(([id]) => id));
    await logAudit({
      actor, action: 'Remove Player', target: name,
      details: `Removed ${allMatches.length} entr${allMatches.length===1?'y':'ies'}`
    });
    return res.json({ ok: true, message: `${name} removed (${allMatches.length} entr${allMatches.length===1?'y':'ies'})` });
  }

  if (action === 'addPlayer') {
    const id = `manual_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const finalSalary = Number(salary) || 2000000;
    await redis.hset('players', {
      [id]: { id, name, team: team || 'Free Agent', salary: finalSalary }
    });
    await logAudit({
      actor, action: 'Add Player', target: name,
      details: `Added to ${team || 'Free Agent'} at $${finalSalary.toLocaleString()}`
    });
    return res.json({ ok: true, message: `${name} added to ${team || 'Free Agent'} at $${finalSalary.toLocaleString()}` });
  }

  if (action === 'renamePlayer') {
    if (!entry) return res.status(404).json({ error: `Player "${name}" not found` });
    const [id, player] = entry;
    await redis.hset('players', { [id]: { ...player, name: newName } });
    await logAudit({
      actor, action: 'Rename Player', target: name,
      details: `${name} → ${newName}`
    });
    return res.json({ ok: true, message: `${name} renamed to ${newName}` });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
