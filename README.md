# KiteChat

Messenger, peer-to-peer audio/video calls (WebRTC over Socket.IO), temporary file sharing, 24-hour statuses and permanent reels. Photos, videos and audio are compressed in the browser before upload.

**Deploying? Follow [`docs/SETUP.md`](docs/SETUP.md)** (GitHub → Cloudflare R2 → Render, with troubleshooting).

## Run locally

```bash
npm install
cp .env.example .env     # optional: add R2 values to enable files, stories and reels
npm run dev              # http://localhost:3000
npm run check:r2         # tests your Cloudflare R2 settings
```

Without R2 settings, chat and calls work and data is kept in `./data/kitechat.json`; files, stories and reels are switched off.

## Project layout

| Path | What it is |
| --- | --- |
| `server.ts` | Express + Socket.IO server: accounts, chat, call signalling |
| `server/media.ts` | Signed upload/download links, stories, reels, shared files, limits (`LIMITS`), expiry sweep |
| `server/r2.ts`, `server/store.ts` | R2 client; data file saved to R2 (or `./data` locally) |
| `src/useCall.ts` | WebRTC call logic |
| `src/compress.ts` | Browser-side image, video and audio compression |
| `render.yaml` | Render Blueprint |
| `cloudflare/cors.json` | CORS rule to paste into the R2 bucket |
| `.github/workflows/ci.yml` | GitHub build check |

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | Set by Render automatically |
| `AUTH_SECRET` | Signs login tokens (Render generates one) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2 storage |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Optional TURN relay for strict networks / mobile data |
| `DATA_DIR` | Local data folder when R2 is not configured (default `./data`) |
| `CORS_ORIGIN` | Only if the client is served from a different origin |

## Notes

- Run a single server instance: the accounts/messages file is rewritten as a whole. Move to Postgres when the app outgrows this.
- Messages and files pass through servers and are not end-to-end encrypted. Call media is peer-to-peer (DTLS-SRTP).
- Video compression uses WebCodecs (Chrome, Edge, Android Chrome, recent Safari). If a browser can't compress, the original is uploaded when it fits the size cap.
