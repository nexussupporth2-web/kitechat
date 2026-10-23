KiteChat setup: GitHub, Cloudflare R2, Render

Do the steps in this order. Total time: about 20 minutes.


your computer ──push──▶ GitHub ──auto deploy──▶ Render (app + sockets)
                                                  │
                                 signed upload/download links
                                                  ▼
                                       Cloudflare R2 (database file, stories, reels, shared files)

Phones upload and download media directly from R2, so the free Render server never carries video.



1. GitHub


Create an empty repository on github.com (e.g. kitechat). Private is fine; Render can read private repos.


On your computer, in the project folder:

rm -f bun.lock               # Render switches to bun if it sees this file
npm install                  # creates package-lock.json, run it once
git init -b main
git add .
git commit -m "KiteChat"
git remote add origin https://github.com/YOUR-USER/kitechat.git
git push -u origin main

Check that .env is not in the commit (git status must not list it). .gitignore already excludes it.


The workflow in .github/workflows/ci.yml builds every push. A green check means the app builds.



If you already have an older KiteChat repo, delete its old files first (including bun.lock), copy these in, and push.



2. Cloudflare R2


Log in at dash.cloudflare.com → R2 Object Storage → Subscribe / Get started. A payment card is required to turn R2 on. The free tier is 10 GB of storage and free downloads; you are charged only if you go over.


Create bucket named kitechat (location: Automatic, or Asia-Pacific for India). Keep it private (do not enable the public r2.dev URL; the app uses signed links).


Account ID: shown on the R2 overview page (right side). Copy it.


Create an API token: R2 overview → Manage API Tokens → Create API token.

Permission: Object Read & Write
Scope: Apply to specific buckets only → kitechat
Create, then copy the Access Key ID and Secret Access Key. The secret is shown once.

CORS (needed so phones can upload straight to R2): bucket → Settings → CORS Policy → Add, and paste cloudflare/cors.json. Change https://kitechat.onrender.com to your real Render URL once you have it (step 3.5).


Lifecycle rules (a safety net that also cleans up abandoned uploads): bucket → Settings → Object lifecycle rules → Add rule:

Rule name	Prefix	Action
clean-shares	shares/	Delete objects 2 days after upload
clean-stories	stories/	Delete objects 2 days after upload
Do not add a rule for db/ (your accounts and messages) or reels/ (permanent posts).


Test the credentials on your computer:

cp .env.example .env         # then fill in the four R2_ values
npm run check:r2
You should see R2 is working. If it fails, the message names the step.




3. Render


render.yaml uses the free plan in Singapore. Log in at render.com → New + → Blueprint → connect GitHub → pick the repo.


Render reads render.yaml and asks for the secret values:

R2_ACCOUNT_ID — from step 2.3
R2_ACCESS_KEY_ID — from step 2.4
R2_SECRET_ACCESS_KEY — from step 2.4
AUTH_SECRET is generated for you. R2_BUCKET, NODE_ENV and NODE_VERSION are already set.


Click Apply. The first build takes a few minutes.


Manual alternative (instead of a Blueprint): New + → Web Service → pick the repo, then set

Runtime: Node · Region: Singapore · Plan: Free
Build command: npm install && npm run build
Start command: npm start
Health check path: /healthz
Environment variables: all rows from .env.example, plus NODE_ENV=production and NODE_VERSION=22.12.0

When it is live, copy your URL (e.g. https://kitechat-abcd.onrender.com). Go back to Cloudflare → CORS and replace the origin with this exact URL. Without that, uploads fail with a CORS error in the browser.




4. Check that it works


Open https://YOUR-URL/healthz → {"ok":true}.

In Render → Logs, look for Data loaded from Cloudflare R2. If you see R2 is not configured, the three secret values are missing or wrong.

Register two accounts in two browsers (one in a private window), add each other by User ID, chat, then call.

Post a story and a reel, and send a file in chat.

In Render → Manual Deploy → redeploy, then sign in again. Your account and messages should still be there (that proves R2 persistence works).



What lives where

Data	Stored in	Lifetime
Accounts, friends, messages, post records	db/kitechat.json in R2	Permanent
Files sent in chat	shares/…	Deleted when the receiver saves it, or after 24 h
Status / stories	stories/…	Deleted after 24 h
Reels	reels/…	Until the owner deletes them

Limits (change in server/media.ts, LIMITS)

Photos, videos and audio are compressed in the browser before upload. The caps below apply to the compressed file.



Photo: 1280 px max, about 250 KB (cap 1 MB)

Reel: 30 s, 720p, cap 15 MB

Status: 30 s video / audio (cap 15 MB / 5 MB) or a photo

Chat file: 50 MB after compression (media originals up to 300 MB are accepted and shrunk first)

Stories and reels per user: 200 MB total


Troubleshooting

Symptom	Cause and fix
Render build log: exited with status 127	A command was not found. Use the build/start commands above, delete bun.lock, and keep vite and tsx in dependencies (they are).
engine "node" is incompatible	Set NODE_VERSION=22.12.0 in Render.
Port scan timeout	The app must listen on PORT (it does). Check the Logs tab for a crash at start, usually a bad R2 value.
Failed to start + R2 error in logs	Wrong R2_ACCOUNT_ID / keys, or the token is not allowed on the bucket. Run npm run check:r2 locally.
Upload fails in the browser, console mentions CORS	The CORS origin does not exactly match your Render URL (scheme + host, no trailing slash).
Upload fails with 403 / SignatureDoesNotMatch	Wrong secret key, or the computer's clock is far off.
"Stories and reels need cloud storage"	R2 variables are not set on Render.
Calls connect on Wi-Fi but not on mobile data	Add a TURN server (TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL).
First visit after a while takes a minute	Free Render services sleep when idle.

Costs to watch


R2 has no spending cap. Staying under 10 GB is controlled by the limits above. Check R2 → Metrics now and then.

Render free web services sleep after 15 minutes without traffic. A paid instance stays awake.

