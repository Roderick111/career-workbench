# Career Workbench

Evidence-first career document workbench that keeps the existing DOCX design.

Two separate interfaces share CV principles:

- Existing CLI remains personal, local, and formatting-preserving.
- Invite-only web app supports collaborators with isolated profiles, private
  DOCX templates, reusable Markdown notes, and downloadable generated files.

See [WEB.md](WEB.md) for web setup and deployment.

## Architecture

One doctrine, two interfaces. CLI and web share the same product rules (evidence
gates, protected facts, reviewable edits, two-page cap) but use different
runtimes and data models.

### Shared contract

Pipeline shape for every application:

1. **Profile sources** — career evidence (YAML base or web profile) plus a DOCX
   visual master.
2. **Target brief** — one job description and company context.
3. **Proposal** — temporary, reviewable document edits (not a final CV).
4. **Approved package** — tailored content, review/diff, and generated DOCX.

DOCX stays the visual master. Structured data only controls mutable text,
ordering, and selection. Company names, dates, locations, education,
certifications, contact details, and existing metrics stay protected. Startup
role titles are flexible positioning labels and may be reframed from evidenced
responsibilities; every change remains reviewable. Output is capped at two
readable pages.

Human approval is mandatory before CV edits and before document generation.
Stage 1 research/fit approval is required before Stage 2 tailoring. See
[WORKFLOW.md](WORKFLOW.md).

### Stack

- **Runtime:** Bun
- **API:** Hono (web)
- **UI:** Vite + React (web SPA served by Hono in production)
- **Auth:** Better Auth, invite-only registration
- **Store:** SQLite (WAL) under `DATA_DIR` for web; local files for CLI
- **LLM:** OpenRouter-compatible chat (JSON proposals, research, profile
  reconciliation)
- **Documents:** PizZip OOXML read/write; CLI PDF via ONLYOFFICE

### CLI path (personal, local)

File-based, synchronous, single-owner. Intended for the local workspace only.

```
jobs/<role>.md
  + data/resume.base.yaml
  + my_background.md / GUIDELINES.md
        │
        ▼
  LLM proposal JSON  (or fixtures/*.proposal.json)
        │
        ▼
  validate → apply → review.md + resume.yaml
        │  human confirm
        ▼
  templates/resume-template.docx → output/<slug>/resume.docx
        │  optional
        ▼
  scripts/export-pdf.ts (ONLYOFFICE)
```

| Module | Role |
|--------|------|
| `src/cli.ts` | Entry: load base, request/load proposal, review, render |
| `src/types.ts` | `Resume` / `Proposal` shapes |
| `src/data.ts` | YAML load/validate, proposal apply with hard field protection |
| `src/llm.ts` | One-shot proposal request |
| `src/review.ts` | Human-readable before/after review |
| `src/ooxml.ts` | Fixed-layout template placeholders and DOCX render |

CLI template slots are hardcoded for the personal CV layout. Run
`bun run personalize` with `--job` and optional `--proposal` / `--approve`.

### Web path (invite-only multi-user)

Additive product. CLI remains independent. Each user owns an isolated profile,
templates, Markdown documents, applications, and artifacts under SQLite +
`DATA_DIR/users/`.

```
Browser (Vite dev :5173 / static SPA in prod)
        │  /api/*
        ▼
Hono API (Bun :3000)
  ├── better-auth, invites, session middleware
  ├── profile / templates / documents / applications / artifacts
  ├── admin (invites, quotas, operation logs)
  └── in-process worker (research → tailor → generate)
        │
        ▼
SQLite + user DOCX files          OpenRouter (LLM + web research)
```

| Module | Role |
|--------|------|
| `src/server/index.ts` | HTTP API, auth gates, static SPA |
| `src/server/workflow.ts` | Application status machine, LLM jobs, validators |
| `src/server/template.ts` | Upload/analyze DOCX, mapping, mapped render |
| `src/server/openrouter.ts` | Provider adapter (JSON + research fallbacks) |
| `src/server/db.ts` | Schema, paths, SQLite access |
| `src/server/auth.ts` | Better Auth setup |
| `src/web/App.tsx` | Full client UI |
| `src/web-types.ts` | `WebProfile`, fit report, edits, statuses |

Core entities:

| Entity | Purpose |
|--------|---------|
| **profiles** | Canonical career knowledge (`WebProfile` JSON) |
| **templates** | User DOCX + slot mapping (protected vs tailorable) |
| **documents** | Reusable Markdown (e.g. company research by company key) |
| **applications** | One job attempt: status, fit, proposal, errors |
| **artifacts** | Generated DOCX on disk + download metadata |

Application status machine (mirrors the three workflow stages):

```
draft
  → research_queued → researching → research_ready
  → research_approved          (user gate)
  → tailor_queued → tailoring → proposal_ready
  → proposal_approved          (user gate)
  → generate_queued → generating → complete
  ↘ failed
```

Web template model is generic: upload or starter DOCX, map paragraphs to profile
paths, then render only mapped tailorable slots. Profile import can reconcile
structured content via LLM or append raw context notes; nothing overwrites the
saved profile without explicit user save.

Production: single container, external `proxy` network, named volume for
`/data`. Web path does not generate PDF; users preview DOCX in-browser and
download. Details: [WEB.md](WEB.md).

### CLI vs web

| | CLI | Web |
|--|-----|-----|
| Audience | Single local owner | Invite-only collaborators |
| Content model | `Resume` YAML | `WebProfile` JSON |
| Template | Fixed personal OOXML slots | Per-user mapped DOCX |
| Persistence | Files under repo workspace | SQLite + `DATA_DIR` |
| Async work | None (sync CLI) | In-process status worker |
| PDF | ONLYOFFICE script | Not in product path |

Do not treat the two paths as one codebase. Share doctrine and prompts
carefully; keep personal career files out of git (see Private inputs).

## Private inputs

Profile sources, document templates, and generated application files stay local
and are intentionally excluded from the public repository. Provide them through
the local workspace or private deployment volume.

`WORKFLOW.md` describes the public workflow contract. Private source documents
may conflict; conflicts must be surfaced and resolved rather than silently
optimized.

## Product stance

Requirements are signals, not gates. The workbench should respond confidently
to unrealistic job posts by proving equivalent competence. It may select an
evidence-backed functional title for broad startup work, but never invent
credentials, responsibilities, ownership, dates, or outcomes.

## Operating workflow

Every new job follows three gates:

1. company research and a short fit brief for user approval;
2. exact tailoring strategy, reviewable changes, and document generation;
3. factual, editorial, DOCX, PDF, and visual verification.

Stage 1 approval is required before CV editing begins.

## Development

Install and verify:

```bash
~/.bun/bin/bun install
~/.bun/bin/bun run typecheck
~/.bun/bin/bun test
```

`templates/resume-template.docx` is the visual master. Edit it directly for
formatting changes. Personalization reads it but never overwrites it.

Normalize chronology and shared experience alignment after manual template
edits:

```bash
~/.bun/bin/bun run normalize-template
```

Only reconstruct it from the original DOCX intentionally:

```bash
~/.bun/bin/bun run template
```

Generate Weplace test application from reviewed fixture:

```bash
~/.bun/bin/bun run personalize -- --job jobs/weplace-product-owner.md --proposal fixtures/weplace.proposal.json --approve
```

The CLI writes a review before generating a document and requires confirmation
before applying proposed changes.

## PDF export

DOCX remains visual master. Export through ONLYOFFICE's native renderer:

```bash
~/.bun/bin/bun run pdf -- output/weplace-product-owner/resume.docx
```

The exporter supplies ONLYOFFICE's generated font catalog explicitly. Do not
print the macOS Quick Look HTML preview: it replaces fonts and destroys DOCX
tab alignment.

## Current test

`jobs/weplace-product-owner.md` and `fixtures/weplace.proposal.json` exercise
the same validation and rendering path as live personalization. Generated files live in
`output/weplace-product-owner/`.

## Later scope

Research, messaging, and discovery stay separate from document generation.
Use permitted APIs or exports; never scrape or send externally without review.
