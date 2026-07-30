# HHN 401(k) Benefits Assistant

A simple chat assistant that answers Honor Health Network employees' questions about
the 401(k) plan, in plain language. One small Node server serves the chat page and
talks to the Anthropic API. Your API key stays on the server, never in the browser.

## What's in here

```
package.json        Node project + start script
server.js           Express server: serves the page + the /api/chat endpoint
prompt.js           The assistant's persona and rules
knowledge-base.md   The editable source of truth (plan details). EDIT THIS to update answers.
.env.example        Environment variables you need to set
public/
  index.html        The chat page
  styles.css        The look
  app.js            The chat behavior (also makes links/phones/emails clickable)
  forms/            The plan PDFs employees can download (booklet, hardship, rollover, account guide)
```

## How answers work

The assistant answers from `knowledge-base.md`, which is now populated with the real
New York Home Health Holdings 401(k) Profit Sharing Plan details (eligibility, match,
vesting, contributions, loans, withdrawals, rollovers, fees, and contacts). When a
question isn't covered, it points people to HR rather than guessing. The four plan PDFs
in `public/forms/` are downloadable, and the assistant links to the right one when it
helps (for example, the hardship form for a withdrawal question). To update anything,
edit `knowledge-base.md` and redeploy.

Office employee handbooks are stored separately in Postgres and mapped to one
or more agency slugs. Benny attaches only the handbook for the exact office
identified in the conversation. When an approved original file is available,
the exact handbook name on a grounded answer's `Source:` line becomes a signed
download link that expires after 10 minutes. The same link is returned when an
employee explicitly asks for the handbook. Set `PUBLIC_BASE_URL` and a strong
`HANDBOOK_DOWNLOAD_SECRET` in Railway before enabling handbook downloads.

## Run it locally (optional)

1. Install Node 18 or newer.
2. In this folder, run `npm install`.
3. Copy `.env.example` to `.env` and paste in your Anthropic API key.
4. Run `npm start`.
5. Open http://localhost:3000

## Deploy on Railway

1. Push this folder to your GitHub repo.
2. In Railway, create a new project and choose "Deploy from GitHub repo," then pick your repo.
3. Railway auto-detects Node and runs `npm start`. No build settings needed.
4. In the service's **Variables** tab, add:
   - `ANTHROPIC_API_KEY` = your key (starts with `sk-ant-...`)
   - (optional) `CLAUDE_MODEL` = `claude-sonnet-4-6`
5. Railway gives you a public URL under **Settings > Networking > Generate Domain**.
6. To update content later: edit `knowledge-base.md`, commit, and push. Railway redeploys automatically.

## Important notes

- **Keep your API key secret.** It bills your Anthropic account. It's only ever set as a
  Railway variable, and `.env` is gitignored so it never reaches GitHub.
- **Access control is not built yet.** Right now anyone with the URL can use it. There's a
  basic rate limit to protect your bill, but before sharing widely we should add a real
  way to gate access (company login, a shared password page, or putting it behind your
  existing systems). A short-lived handbook link prevents permanent public URLs and
  agency-link tampering, but it does not verify the employee's identity or authorization.
- **Costs.** You pay Anthropic per use. Sonnet 4.6 is a good default. For high volume,
  switch `CLAUDE_MODEL` to `claude-haiku-4-5-20251001` to cut cost.
