// api/_lib/discord-teams.js
// Shared source of truth for how Discord role tags map to team names.
// Prefixed with an underscore folder so Vercel does NOT turn this into its
// own API route — it's a plain module imported by sync.js and admin.js.
//
// sync.js uses ROLE_TO_TEAM to read Discord roles -> team assignments.
// admin.js uses TEAM_TO_TAG (the reverse) to push a team change on the site
// back onto the member's Discord roles.
export const ROLE_TO_TEAM = {
  'ATL': 'Atlanta Hawks','BKN': 'Brooklyn Nets','BOS': 'Boston Celtics',
  'CHI': 'Chicago Bulls','CLE': 'Cleveland Cavaliers','CHA': 'Charlotte Hornets',
  'DAL': 'Dallas Mavericks','DEN': 'Denver Nuggets','DET': 'Detroit Pistons',
  'GSW': 'Golden State Warriors','HOU': 'Houston Rockets','IND': 'Indiana Pacers',
  'LAC': 'LA Clippers','LAL': 'Los Angeles Lakers','MIA': 'Miami Heat',
  'MIL': 'Milwaukee Bucks','MEM': 'Memphis Grizzlies','MIN': 'Minnesota Timberwolves',
  'NOP': 'New Orleans Pelicans','NYK': 'New York Knicks','OKC': 'Oklahoma City Thunder',
  'ORL': 'Orlando Magic','PHI': 'Philadelphia 76ers','PHX': 'Phoenix Suns',
  'POR': 'Portland Trail Blazers','SAC': 'Sacramento Kings','SAS': 'San Antonio Spurs',
  'TOR': 'Toronto Raptors','UTA': 'Utah Jazz','WAS': 'Washington Wizards',
};

export const TEAM_TO_TAG = Object.fromEntries(
  Object.entries(ROLE_TO_TEAM).map(([tag, team]) => [team, tag])
);
