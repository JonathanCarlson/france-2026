# France & Italy 2026 — private trip companion

A phone-friendly, **offline-capable** web app for the trip. The content is
**encrypted client-side** — the page ships only ciphertext, and a shared family
passphrase unlocks it in the browser. Safe to host on a public URL
(github.io) because nothing readable is exposed without the passphrase.

## How it works

- `build/itinerary.json` — the **plaintext** trip data (gitignored, never committed).
- `build/encrypt.mjs` — encrypts it with a passphrase (PBKDF2 + AES-GCM, Web Crypto)
  into `data/itinerary.enc.json` (the only data file that ships).
- `index.html` / `app.js` / `styles.css` — the app: passphrase gate → decrypts in
  the browser → renders Today / Days / Bookings / Contacts / Info.
- `sw.js` + `manifest.webmanifest` — installable PWA, caches everything for offline.

## Build & run locally

```powershell
# 1. Generate app icons (one-time)
node build/generate-icons.mjs

# 2. Encrypt the itinerary with your shared passphrase (NOT stored anywhere)
$env:TRIP_PASSPHRASE = "your shared family passphrase"
node build/encrypt.mjs

# 2b. Encrypt ticket PDFs/images (drop files in build/tickets/ first)
node build/encrypt-assets.mjs

# 3. Serve locally (Web Crypto needs http://localhost, not file://)
python -m http.server 8080      # or: npx serve .
# open http://localhost:8080
```

### Tickets in-app (no other apps needed)

Drop the real ticket files into `build/tickets/` (PDF, or PNG/JPG for the crispest
QR at the gate), then run `node build/encrypt-assets.mjs`. Each becomes an
encrypted `data/tickets/<name>.enc` that the app decrypts in the browser and shows
full-screen — offline once cached. Reference them from a ticket's `assets` array in
`build/itinerary.json` (`{ "label": "Ticket", "file": "colosseum" }`). Plaintext
`build/tickets/` is gitignored; only the encrypted `.enc` files ship.

## Deploy to GitHub Pages (personal account)

1. Create a **private** repo on your personal account, e.g. `france-2026`.
2. `git remote add origin git@github.com:<you>/france-2026.git && git push -u origin main`
3. Repo **Settings → Pages** → Source: `Deploy from a branch` → `main` / root.
4. Your URL: `https://<you>.github.io/france-2026/`.

> ⚠️ GitHub Pages on a personal account is **publicly reachable** — that's why the
> content is encrypted. Keep the passphrase off the page and out of the repo.
> Re-run `encrypt.mjs` with your real passphrase before the first deploy (the
> committed `data/itinerary.enc.json` should be encrypted with the passphrase you
> actually share).

## Use it on iPhone

1. Open the URL in Safari, enter the passphrase (tick "keep me unlocked").
2. Share button → **Add to Home Screen** → it installs as an app.
3. Open it once while online so the service worker caches everything.
   After that it works **fully offline** (great for roaming abroad).

Share the URL + passphrase with parents / emergency contacts — same one-tap access.

## Friends photo album (shareable link — photos only)

Want to share **just the photos** with friends without handing over the family
passphrase (which unlocks the whole itinerary, tickets, and contacts)? There's a
standalone, photos-only album page:

```
https://jonathancarlson.github.io/france-2026/album.html#k=<album-key>
```

- The token after `#k=` is an **independent** high-entropy key (≈192 bits) — it is
  **not** the family passphrase. It is both the access token and the decryption
  key for a separate, photos-only bundle (`data/album/`). Anyone with the full
  link sees the photos; without it, `data/album/*` is unreadable ciphertext.
- The key rides in the **URL fragment** (`#…`), which browsers never send to the
  server — so it stays client-side ("security by obscurity": the URL *is* the
  access control). Treat the link like a password: don't post it publicly.
- Sharing this link **cannot** expose the itinerary, bookings, confirmation
  numbers, or contacts — the album page can only decrypt the photo bundle.
- No `#k=`? The page shows a small "album code" box so you can hand the key out
  of band and let friends type it.

### Build / refresh the album

```powershell
node build/build-album.mjs            # reuse the saved key, (re)encrypt photos + manifest
node build/build-album.mjs --rotate   # mint a BRAND-NEW key (old links stop working)
```

It re-encrypts `build/photos/*` → `data/album/photos/*.enc` and writes the
encrypted manifest `data/album/index.enc`. The key is persisted to the gitignored
`build/album-key.txt` so the shared URL stays **stable** across republishes; the
script prints the full shareable link each run. `publish.ps1` runs it
automatically and ships the album bundle.

## Keeping it updated

### Quick publish (one command)

Use the `publish.ps1` helper — it re-encrypts the data + tickets and pushes:

```powershell
.\publish.ps1                              # prompts for the passphrase, publishes data
.\publish.ps1 -IncludeCode -Message "..."  # also ship modified app code (app.js, etc.)
```

It handles the credential override this machine needs (Git Credential Manager is
pinned to the work account, so the push uses the personal `JonathanCarlson`
account explicitly). The site redeploys in ~1 min at the live URL.

### Automatic (cos-daemon)

The trip source of truth is the Obsidian vault (`8 - Family/France 2026/`). The
`cos-daemon` keeps the site current via the **`trip-site` skill** +
**`trip-site-sync` workflow** (`admin-agents/src/daemon/src/workflows/trip-site-sync.ts`):

1. Reconciles the vault notes into `build/itinerary.json` (incremental — preserves
   enrichment), validates the JSON.
2. Runs `encrypt.mjs` + `encrypt-assets.mjs` with the passphrase from the
   `TRIP_PASSPHRASE` env var.
3. Commits + pushes the encrypted blobs → GitHub Pages redeploys.
4. Notifies you on Teams with a summary of what changed.

**Triggers:** say *"update the trip site"* to `cos` (interactive or self-chat), or
the daemon runs it nightly (5:15 AM) during the trip window.

**To activate the daemon path (one-time):**
1. `cp admin-agents/.github/config/trip-site-local.md.example` → `trip-site-local.md`, edit paths.
2. Set the passphrase as a persistent user env var, then restart the daemon:
   ```powershell
   [Environment]::SetEnvironmentVariable('TRIP_PASSPHRASE','<family passphrase>','User')
   ```
Until both are done, the workflow stays **dormant** (safe no-op).

Because updates only change the encrypted blob, the app just picks up new content
on next open (network-first for the data file, cache fallback offline).

