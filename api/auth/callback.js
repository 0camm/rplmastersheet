import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const ROLE_TO_TEAM = {
  'ATL': 'Atlanta Hawks',
  'BKN': 'Brooklyn Nets',
  'BOS': 'Boston Celtics',
  'CHI': 'Chicago Bulls',
  'CLE': 'Cleveland Cavaliers',
  'CHA': 'Charlotte Hornets',
  'DAL': 'Dallas Mavericks',
  'DEN': 'Denver Nuggets',
  'DET': 'Detroit Pistons',
  'GSW': 'Golden State Warriors',
  'HOU': 'Houston Rockets',
  'IND': 'Indiana Pacers',
  'LAC': 'LA Clippers',
  'LAL': 'Los Angeles Lakers',
  'MIA': 'Miami Heat',
  'MIL': 'Milwaukee Bucks',
  'MEM': 'Memphis Grizzlies',
  'MIN': 'Minnesota Timberwolves',
  'NOP': 'New Orleans Pelicans',
  'NYK': 'New York Knicks',
  'OKC': 'Oklahoma City Thunder',
  'ORL': 'Orlando Magic',
  'PHI': 'Philadelphia 76ers',
  'PHX': 'Phoenix Suns',
  'POR': 'Portland Trail Blazers',
  'SAC': 'Sacramento Kings',
  'SAN': 'San Antonio Spurs',
  'TOR': 'Toronto Raptors',
  'UTA': 'Utah Jazz',
  'WAS': 'Washington Wizards',
};

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

  let assignedTeam = 'Free Agent';
  for (const roleName of memberRoleNames) {
    const match = roleName.match(/^\[([A-Z]+)\]/);
    if (match && ROLE_TO_TEAM[match[1]]) {
      assignedTeam = ROLE_TO_TEAM[match[1]];
      break;
    }
  }

  // Always use the actual Discord username (not display name / global_name)
  const username = user.username;
  const existing = await redis.hget('players', user.id);
  const salary = existing ? existing.salary : 2000000;

  await redis.hset('players', {
    [user.id]: { id: user.id, name: username, team: assignedTeam, salary }
  });

  res.redirect(`/?registered=1&name=${encodeURIComponent(username)}&team=${encodeURIComponent(assignedTeam)}`);
}
