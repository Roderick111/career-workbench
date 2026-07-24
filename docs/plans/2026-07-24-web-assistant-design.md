# Web CV assistant design

## Shape

Invite-only Bun/Hono/React application beside existing CLI. Better Auth owns
sessions. SQLite and user files live on Docker volume. Every template and
artifact belongs to one user.

## Workflow

Company research receives job and company only. Fit analysis receives saved
research plus candidate profile. Tailoring receives approved fit and only
mapped tailorable fields. Users approve each stage before DOCX generation.

Company and role context are editable Markdown documents. Matching company
context is reused for later roles. Generated DOCX and review Markdown are
previewable and downloadable.

## DOCX boundary

Support paragraph text and simple table cells. Reject text boxes and ambiguous
mappings. Preserve OOXML styling by changing selected text nodes only. Browser
preview is read-only; editing stays in local Office software.

## Model routing

Primary `openrouter/minimax/minimax-m3`, provider order `Morph,Together`.
Fallback `openrouter/deepseek/deepseek-v4-flash`, provider order
`WandB,AtlasCloud,DigitalOcean`. Adapter removes leading `openrouter/` before
calling OpenRouter. Provider data collection is denied and ZDR required.

Web research prefers `openrouter:web_search`. Configured models currently return
`404` for that server tool, so implementation retries OpenRouter's legacy web
plugin as a compatibility path. Both paths use Exa and bounded results.
