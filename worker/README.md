# sal-api — SLAM login / comments / messages backend

Cloudflare Worker + D1. Passwordless magic-link login; anyone may log in and
send Phil private **messages** (including "report this link" takedowns);
`expert`-role users may post **comments** keyed to ml.json row `UID`s;
`admin` (Phil) moderates via `/admin/*`.

This folder is deliberately independent of the GitHub Pages site — nothing
here is served by Pages, and no secrets live in these files.

## One-time setup (run inside `worker/`)

```powershell
npm install -g wrangler          # or use npx wrangler everywhere
wrangler login                   # opens browser → authorize your CF account
wrangler d1 create sal-db        # prints a database_id
# → paste that id into wrangler.toml (database_id = "…")
wrangler d1 execute sal-db --file=schema.sql --remote
wrangler deploy                  # prints your URL, e.g. https://sal-api.<acct>.workers.dev
```

## Smoke test (dev mode returns the magic link instead of emailing)

```powershell
$api = "https://sal-api.<acct>.workers.dev"   # from deploy output
# 1. request a login link
curl.exe -s -X POST "$api/auth/request-link" -H "Content-Type: application/json" `
  -d '{"email":"pwassm@yahoo.com"}'
# → {"ok":true,"sent":false,"devLink":"https://…/auth/verify?token=…"}
# 2. open the devLink in a browser → redirects to sealifeandmore.com/#session=XXXX
#    copy the XXXX part from the address bar
# 3. who am I?
curl.exe -s "$api/auth/me" -H "Authorization: Bearer XXXX"
# 4. make yourself admin (one-time bootstrap, after first login):
wrangler d1 execute sal-db --remote --command "UPDATE users SET role='admin' WHERE email='pwassm@yahoo.com'"
# 5. post a test comment + read it back
curl.exe -s -X POST "$api/comments" -H "Authorization: Bearer XXXX" `
  -H "Content-Type: application/json" -d '{"uid":"1","body":"hello from the api"}'
curl.exe -s "$api/comments?uid=1"
# 6. post a message + list as admin
curl.exe -s -X POST "$api/messages" -H "Authorization: Bearer XXXX" `
  -H "Content-Type: application/json" -d '{"body":"test note","kind":"report","uid":"1"}'
curl.exe -s "$api/admin/messages" -H "Authorization: Bearer XXXX"
```

Promote an expert later (they must have logged in once):

```powershell
curl.exe -s -X POST "$api/admin/set-role" -H "Authorization: Bearer XXXX" `
  -H "Content-Type: application/json" -d '{"email":"expert@example.com","role":"expert"}'
```

## Going live (later, in any order)

- **Real email**: create a free resend.com account, verify the
  sealifeandmore.com domain (adds a few DNS records), then
  `wrangler secret put RESEND_API_KEY` and set `ENVIRONMENT = "prod"` in
  wrangler.toml + redeploy. Optionally `wrangler secret put EMAIL_FROM`.
- **Bot check**: create a Turnstile site in the CF dashboard, put the widget
  on the login form, `wrangler secret put TURNSTILE_SECRET`, redeploy.
- **Clean URL**: move sealifeandmore.com DNS to Cloudflare (the zone likely
  already exists — video.sealifeandmore.com R2 needs it), then uncomment the
  `routes` line in wrangler.toml for api.sealifeandmore.com.
- **Frontend**: site JS reads `location.hash` for `#session=…`, stores it in
  localStorage, sends it as `Authorization: Bearer …` — not built yet.

## Data model / rules

- `users.role`: `user` (messages only) → `expert` (+comments) → `admin` (+moderation).
- Comments post as `approved` (experts are hand-picked); `hidden` is the kill
  switch via `/admin/comment-status`.
- Messages: `kind` `general` | `report` (takedown/objection), `status`
  `new`/`read`/`done`.
- Public comment listings show `users.name` or a masked email — full emails
  are never exposed.
- Rate limits: 5 login links/email/hr, 10/IP/hr, 20 posts/user/hr; bodies
  capped at 4000 chars, plain text (render as text on the site, never HTML).
