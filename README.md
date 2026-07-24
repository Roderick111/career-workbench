# Job Search Assistant

Evidence-first CV personalization that keeps the existing DOCX design.

Two separate interfaces share CV principles:

- Existing CLI remains personal, local, and formatting-preserving.
- Invite-only web app supports friends with isolated profiles, private DOCX
  templates, reusable Markdown research, and downloadable generated files.

See [WEB.md](WEB.md) for web setup and deployment.

## Architecture

- `my_background.md`: evidence reservoir for truthful positioning.
- `data/resume.base.yaml`: editable text currently displayed in the CV.
- `templates/resume-template.docx`: original design with text placeholders.
- job post: target requirements.
- proposal JSON: temporary, reviewable LLM edit.
- output YAML, review, and DOCX: approved application package.

YAML does not replace DOCX formatting. It controls only mutable text, ordering,
and selection. Company names, dates, locations, education, certifications,
contact details, and existing metrics remain protected. Startup role titles are
flexible positioning labels and may be reframed from evidenced responsibilities;
every change remains reviewable. Output is capped at two readable pages.

## Sources

- [`my_background.md`](my_background.md) — broader professional context.
- [`Daniel MEDINA - product manager - Resume Bordeaux FR 2026.pdf`](Daniel%20MEDINA%20-%20product%20manager%20-%20Resume%20Bordeaux%20FR%202026.pdf) — current French CV.
- [`GUIDELINES.md`](GUIDELINES.md) — truth, positioning, personalization, and automation rules.
- [`WORKFLOW.md`](WORKFLOW.md) — mandatory research, tailoring, and verification gates.

These sources can conflict. Conflicts must be surfaced and resolved; they must not be silently optimized.

## Product stance

Requirements are signals, not gates. The assistant should respond confidently
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

Run with an OpenAI-compatible LLM:

```bash
LLM_API_KEY=... LLM_MODEL=... ~/.bun/bin/bun run personalize -- --job jobs/weplace-product-owner.md
```

`LLM_BASE_URL` defaults to OpenRouter. Without `--approve`, script writes and
prints review, then requires confirmation before generating DOCX.

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
same validation and rendering path as live LLM output. Generated files live in
`output/weplace-product-owner/`.

## Later scope

Deep decision-maker discovery, messaging, and job discovery stay separate from
CV generation. Stage 1 includes only quick company research. Use permitted APIs
or exports; never scrape or send externally without review.
