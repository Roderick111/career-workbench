# Web application

Web app is additive. Existing CLI remains available through `personalize`,
`template`, `normalize-template`, and `pdf` scripts.

## Local development

Add missing values to `.env`:

```dotenv
BETTER_AUTH_URL=http://localhost:3000
APP_ORIGIN=http://localhost:5173,http://localhost:3000
BETTER_AUTH_SECRET=<at least 32 random characters>
```

Run API and UI in separate terminals:

```bash
~/.bun/bin/bun run dev
~/.bun/bin/bun run dev:web
```

Create first admin once:

```bash
ALLOW_BOOTSTRAP_SIGNUP=true \
ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD='temporary-strong-password' \
~/.bun/bin/bun run admin:create
```

Remove `ALLOW_BOOTSTRAP_SIGNUP` and `ADMIN_PASSWORD` after command.

## Workflow

1. Admin creates invite and sends URL manually.
2. User imports factual profile and confirms it.
3. User uploads a DOCX or uses the starter based on the existing CV visual master.
4. Mapping wizard marks protected and tailorable fields.
5. User submits job posting.
6. Company research is saved as reusable Markdown.
7. User approves fit analysis and CV edits.
8. Generated DOCX can be previewed and downloaded.

Company context is reused by normalized company name. User can edit or download
it from Personal space. No LinkedIn scraping or automatic application sending.

Profile is the reusable career knowledge base, not only a set of CV fields. CV
import sends the current canonical profile and raw source to one reconciliation
agent using a strict schema. Matching records keep stable IDs; genuinely new
records receive server-generated IDs. An empty profile is saved after successful
reconciliation. Existing content becomes an unsaved draft and is never
overwritten automatically.

Profile import accepts DOCX, Markdown, TXT, or pasted text. Structured-profile
mode uses the LLM. Context-notes mode appends the exact source text to the
background draft without an LLM rewrite; the user reviews and saves it.

Only one profile reconciliation can run per user. Recent operations are stored in
SQLite and visible to admins with request ID, model, timing, input size, counts,
and errors. CV text and credentials are not logged.

Research first tries OpenRouter's current server-tool API. MiniMax/DeepSeek
routing currently returns `404` for that combination, so adapter retries through
OpenRouter's compatibility web plugin. Remove compatibility path when server
tool works with configured models.

## Production

Complete `.env.example`, then:

```bash
./deploy.sh
```

Compose uses external `proxy` network and named `job_search_data` volume. Only
app joins proxy. SQLite, private templates, Markdown, and generated artifacts
remain under `/data`.

PDF generation is intentionally absent. DOCX preview is read-only in browser;
users download files for local editing.

Create consistent SQLite backup inside volume:

```bash
docker compose exec app bun run backup
```
