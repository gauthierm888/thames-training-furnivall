# Tideway Trainer – Furnivall

A 2D rowing game on the real Thames, from the Furnivall Sculling Club pontoon (Hammersmith) up to the UL Boat House and back.
Live tide (Environment Agency), the PLA Tideway Code, other crews, a shouting coach, a Leaderboard and a CrazyBoard.

*Not for navigation.* Data: river geometry © OpenStreetMap contributors (ODbL); tide data from the Environment Agency
real-time flood-monitoring API (Open Government Licence).

## Everything on Cloudflare

| Need | Cloudflare service (free plan) |
| --- | --- |
| Hosting the game + API for shared scores + security headers | one Worker with static assets (`wrangler.jsonc`, `worker/index.js`, `site/`) |
| Storing the scores | D1 database |

## Folder

| Path | What it is |
| --- | --- |
| `site/` | **The game**, published as static files: `index.html`, `game.js`, `river-data.js`, `config.js`. |
| `worker/index.js` | The Worker: scores API and security headers. Kept outside `site/` so it is never published as a file. |
| `wrangler.jsonc` | Cloudflare project settings (name, assets folder, D1 database). **You must paste your D1 database id in it** (step 3). |
| `database/schema.sql` | One-off setup of the scores table. |
| `data-build/` | Only for rebuilding `river-data.js` from OpenStreetMap (`build-river.ps1` + raw JSON). Not published. |

Play locally: open `site/index.html` in a browser. Opened from disk, the boards are kept in that browser only.

## Set it up (about 20 minutes, no command line except git)

Use **personal** accounts, not the edfenergy GitHub organisation. Players enter a nickname that everyone can see.

### 1. Put the repo on GitHub
1. Create a free personal GitHub account and a new **empty** repository (private is fine), for example `thames-training-furnivall`.
2. Fix the author of the first commit, then push (replace the address with yours):
   ```
   git config user.name "Your Name"
   git config user.email "you@example.com"
   git commit --amend --reset-author --no-edit
   git remote add origin https://github.com/YOUR-NAME/thames-training-furnivall.git
   git push -u origin main
   ```
   (Do this before the first push: the repo was prepared with a placeholder author. Use your GitHub no-reply address if you prefer privacy.)
   Or upload through the GitHub website (drag and drop the **contents** of the folder, not the folder itself).

### 2. Create the database (D1)
1. Cloudflare dashboard > **Storage & databases > D1 > Create database**, name it `tideway`.
2. Open it > **Console**, paste the whole of `database/schema.sql`, **Execute**.
3. On the database's overview page, copy its **Database ID** (a long code like `1a2b3c4d-....`).

### 3. Tell the project about the database
Open `wrangler.jsonc` and replace `PASTE-YOUR-D1-DATABASE-ID-HERE` with the Database ID (keep the quotes).
On GitHub: open the file > pencil icon (Edit) > change it > **Commit changes**.

### 4. Create the site (Workers)
1. **Workers & Pages > Create > Import a repository** (Connect to Git), pick the repository.
2. Leave the build command **empty** and the deploy command as `npx wrangler deploy`. **Save and Deploy**.
3. Your game is at `https://thames-training-furnivall.<your-subdomain>.workers.dev` (shown on the project page). Send it to your friends.

### 5. Check it works
Open the address on a phone and a laptop, enter a nickname, row out and back to the pontoon, press **Get off the boat**.
The note under the boards should say "Online boards – shared with everyone". Both devices should show the same boards.

## Updating the game
Edit the files on your computer, then:
```
git add -A
git commit -m "Describe the change"
git push
```
(or upload the changed files on the GitHub website, keeping the same folder structure). Cloudflare builds and publishes the new version
within a minute or so; the address stays the same and **scores are kept** (they live in D1, not in the site). Players may need to refresh once.

## Good to know
- **Cheating:** the server rebuilds each score from the submitted counts and rejects impossible ones (speed, penalty time, ranges),
  but the counts come from the player's browser, so a determined player can still fake a result. Fine among friends.
- **Moderating:** D1 > `tideway` > Console, for example `DELETE FROM scores WHERE id = 12;` or `SELECT * FROM scores ORDER BY id DESC LIMIT 20;`.
- **Abuse protection:** only the game's own address can post scores (cross-site posting is refused). For more, add a Cloudflare
  *Rate limiting rule* on `/api/scores` (dashboard > Security > WAF > Rate limiting rules).
- **Privacy:** only the nickname and the result are stored. No IP address or account is recorded by the game.
- **Free-plan limits:** see Cloudflare's pricing pages; a game among friends is far inside them. If the API is unavailable the game
  keeps working and sends the result later.
- **Controls:** steer left `←`/`A` and right `→`/`D` (hold; there is no auto-steer), rate `↑`/`↓`, easy oar `Space`, turn round `U`, get off `G`, pause `P`, restart `R`, zoom `+`/`-`.
- **Rebuilding the river data** (rarely needed): run `data-build/build-river.ps1` from inside `data-build` (PowerShell) and copy the
  resulting `river-data.js` into `site/`. Pier positions on bridges are estimates; the Tideway Code zones are approximated from the Code text.
