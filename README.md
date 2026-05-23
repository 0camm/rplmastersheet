# RPL Salary Cap Dashboard

## Deploy to Vercel — Step by Step

### 1. Push to GitHub
Create a new GitHub repo and push this folder:
```
git init
git add .
git commit -m "Initial RPL salary cap site"
git remote add origin https://github.com/YOUR_USERNAME/rpl-salary-cap.git
git push -u origin main
```

### 2. Import to Vercel
1. Go to https://vercel.com/new
2. Import your GitHub repo
3. Click **Deploy** (default settings are fine)
4. Note your project URL: `https://YOUR-APP.vercel.app`

### 3. Add Vercel KV (free database)
1. In your Vercel project → **Storage** tab
2. Click **Create Database** → choose **KV**
3. Name it `rpl-kv` → Create
4. Click **Connect to Project** → select your project
5. Vercel auto-adds the KV env vars

### 4. Add Environment Variables
In Vercel project → **Settings** → **Environment Variables**, add:

| Key | Value |
|-----|-------|
| `DISCORD_CLIENT_ID` | `1507116566536523858` |
| `DISCORD_CLIENT_SECRET` | `OamB7JimsQeFcI6saDTxh6Kie8wTLyef` |
| `DISCORD_REDIRECT_URI` | `https://YOUR-APP.vercel.app/api/auth/callback` |
| `DISCORD_GUILD_ID` | `1405981824588578926` |
| `DISCORD_BOT_TOKEN` | *(your bot token from Discord Dev Portal → Bot tab)* |
| `ADMIN_PASSWORD` | `RPLHRPASS$&` |

### 5. Add Discord Redirect URI
1. Go to https://discord.com/developers/applications → RPL Bot v2 → OAuth2
2. Add redirect: `https://YOUR-APP.vercel.app/api/auth/callback`
3. Save Changes

### 6. Get Your Bot Token
1. Discord Dev Portal → RPL Bot v2 → **Bot** tab
2. Click **Reset Token** → copy it
3. Add it as `DISCORD_BOT_TOKEN` in Vercel env vars

### 7. Redeploy
After adding env vars, go to **Deployments** → click the 3 dots on latest → **Redeploy**

### 8. Seed Existing Players
Edit `seed-players.js`:
- Set `SITE_URL` to your actual Vercel URL
- Paste your existing `allPlayers` array

Then run:
```
node seed-players.js
```

---

## Admin Panel
Click **⚙ Admin** on the site. Actions available:
- **Set Salary** — change a player's salary
- **Set Team** — move a player to any team or Free Agent
- **Add Player** — manually add a player (for players who haven't logged in yet)
- **Remove Player** — remove a player entirely
- **Rename Player** — update a username

## Discord Login Flow
Players visit the site → click **Login with Discord** → authorize → they're auto-assigned to their team based on their `[ATL]`, `[BKN]` etc. role → their name appears on the roster at $2M by default (admin can adjust salary after).
