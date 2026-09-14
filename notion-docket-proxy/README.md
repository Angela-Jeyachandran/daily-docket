# notion-docket-proxy

A small Cloudflare Worker that lets Daily Docket read and update the "Task
List" Notion database. Notion's API doesn't send CORS headers, so the browser
can't call it directly — this Worker proxies the two calls the app needs and
holds the Notion integration token as a secret, never in the browser.

## Routes

- `GET /tasks` — queries the Task List database, filters out `Done` and
  `Paused`, returns `[{ id, text, status, priority, project, assignedDate }]`.
- `PATCH /tasks/:pageId` — updates `Assigned Date` and/or `Status` on one
  page. Body: `{ "assignedDate": "2026-09-14", "status": "In progress" }`
  (either field optional).

CORS is locked to a single origin via the `ALLOWED_ORIGIN` var.

## One-time setup

### 1. Create a Notion integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations).
2. Create a new **internal** integration, scoped to the
   "StoryRoad - ajeyachandran's Team" workspace.
3. Copy the integration's secret (starts with `secret_` or `ntn_`) — you'll
   paste it into Wrangler in step 4.
4. Open the **Task List** database in Notion, click **···** → **Connections**
   (or **Add connections**), and share it with the integration you just
   created. Without this step the Worker gets empty results or a 401.

### 2. Create a Cloudflare account (personal, not work)

Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
using your personal email, not your Tillman Allen Greer address — the
existing Cloudflare account tied to work isn't the right place for a
personal side project. The free tier (100k requests/day) is plenty.

### 3. Install and authenticate Wrangler

```bash
npm install -g wrangler
wrangler login
```

If you're already logged into another Cloudflare account in the browser,
`wrangler login` opens an OAuth flow — make sure you approve it against the
personal account, not the work one. Check with:

```bash
wrangler whoami
```

### 4. Set the secret and deploy

From this directory (`notion-docket-proxy/`):

```bash
wrangler secret put NOTION_TOKEN
```

Paste the integration secret from step 1 when prompted (it won't echo to the
terminal, and isn't written to any file). Then:

```bash
wrangler deploy
```

Wrangler prints a `*.workers.dev` URL when it finishes — that's the Worker
URL the app needs in the next section.

## Configuring Daily Docket

1. Open the live docket: https://angela-jeyachandran.github.io/daily-docket/
2. Go to **Settings → Notion**.
3. Paste the `*.workers.dev` URL from `wrangler deploy` into **Worker URL**
   and click **Connect**.
4. Go back to **Today** — a **From Notion** section should appear below the
   add-task row, listing open tasks from the Task List database.

## Verifying it actually works

- Drag a task from **From Notion** up into today's list. In Notion, that
  page's **Assigned Date** should become today and **Status** should become
  **In progress**.
- In the docket, click the date under a backlog item — an inline date picker
  should appear; changing it should update **Assigned Date** in Notion.
- Check off a Notion-linked task in today's list — its Notion **Status**
  should become **Done**. Uncheck it — back to **In progress**.
- Drag a Notion-linked task out of today's list into the **From Notion**
  section — it should disappear from today and reappear in the backlog with
  its current Notion date (no Notion status/date reset happens on this
  action, only on promote/checkbox).

## Notes

- `ALLOWED_ORIGIN` in `wrangler.jsonc` is `https://angela-jeyachandran.github.io`
  — no path, since browsers only send the scheme+host in the `Origin`
  header, even though the site itself lives under `/daily-docket/`.
- `NOTION_DATABASE_ID` in `wrangler.jsonc` targets the Task List database
  (`398ae20b-aecf-80af-83f9-df7c6e81b5b6`). Change it there if you ever want
  to point this at a different database.
- To rotate the Notion token: `wrangler secret put NOTION_TOKEN` again, then
  redeploy isn't required — secrets take effect immediately.
- To change the allowed origin or database: edit `wrangler.jsonc`, then run
  `wrangler deploy` again.
