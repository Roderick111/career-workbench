# Profile reconciliation

Profile is the durable factual context used by fit analysis and CV tailoring.
It combines structured CV facts with projects, broader career context, and
candidate-authored positioning rules.

Structured import sends the complete current profile and raw imported source to
one reconciliation agent. The agent returns one complete updated profile and
warnings. It updates matching records, reuses their stable IDs, canonicalizes
company names, and adds only genuinely new records. MiniMax remains primary;
DeepSeek remains the provider fallback.

DOCX, Markdown, TXT, and pasted text are accepted. Career-context notes use a
separate exact-text path: the source is appended to the background draft
without an LLM rewrite or automatic overwrite of an existing profile.

The server rejects changed identity fields, lost existing records, and duplicate
IDs. Changes to titles, employers, dates, bullets, and list entries are shown as
warnings. The UI displays elapsed time, saved state, and warnings. Controls are
disabled while active. Empty profiles autosave; existing profiles receive an
unsaved draft.

SQLite enforces one active reconciliation per user. Structured operation records
and JSON stdout logs include request ID, stage, model, duration, input metadata,
output counts, and errors. Logs exclude CV content and credentials.
