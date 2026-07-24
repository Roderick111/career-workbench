# Career Workbench

Evidence-first career document workbench that keeps the existing DOCX design.

Two separate interfaces share CV principles:

- Existing CLI remains personal, local, and formatting-preserving.
- Invite-only web app supports collaborators with isolated profiles, private
  DOCX templates, reusable Markdown notes, and downloadable generated files.

See [WEB.md](WEB.md) for web setup and deployment.

## Architecture

- private profile sources: local evidence and editable document template.
- target brief: requirements and context for one application.
- proposal JSON: temporary, reviewable document edit.
- output YAML, review, and DOCX: approved application package.

YAML does not replace DOCX formatting. It controls only mutable text, ordering,
and selection. Company names, dates, locations, education, certifications,
contact details, and existing metrics remain protected. Startup role titles are
flexible positioning labels and may be reframed from evidenced responsibilities;
every change remains reviewable. Output is capped at two readable pages.

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
