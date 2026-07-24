import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  FitReport,
  TailoringEdit,
  TailoringProposal,
  TemplateSlot,
  WebProfile,
} from "../web-types";
import { db, id, json, now, artifactsDir } from "./db";
import { requestJson, requestText } from "./openrouter";
import { extractDocxText, renderMappedTemplate, safeFilename, sha256 } from "./template";

interface ApplicationRow {
  id: string;
  user_id: string;
  template_id: string | null;
  company: string;
  company_key: string;
  role: string;
  job_text: string;
  language: string;
  reuse_company_context: number;
  status: string;
  fit_json: string | null;
  proposal_json: string | null;
}

interface TemplateRow {
  id: string;
  user_id: string;
  name: string;
  source_path: string;
  mapping_json: string;
  status: string;
}

const fitSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "score",
    "companySummary",
    "currentChallenges",
    "highlights",
    "weakPoints",
    "omit",
    "keywords",
    "questions",
  ],
  properties: {
    score: { type: "number", minimum: 0, maximum: 10 },
    companySummary: { type: "string" },
    currentChallenges: { type: "array", items: { type: "string" } },
    highlights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "evidence"],
        properties: {
          text: { type: "string" },
          evidence: {
            type: "string",
            enum: ["direct", "transferable", "inferred", "unverified", "unsupported"],
          },
        },
      },
    },
    weakPoints: { type: "array", items: { type: "string" } },
    omit: { type: "array", items: { type: "string" } },
    keywords: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
  },
} as const;

const proposalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["edits", "warnings"],
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "oldText", "newText", "reason", "evidence"],
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
          reason: { type: "string" },
          evidence: {
            type: "string",
            enum: ["direct", "transferable", "inferred", "unverified", "unsupported"],
          },
        },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
} as const;

let workerTimer: ReturnType<typeof setInterval> | undefined;
let workerBusy = false;

export function startWorker(): void {
  if (workerTimer) return;
  db.query(
    `UPDATE applications SET status = CASE
       WHEN status = 'researching' THEN 'research_queued'
       WHEN status = 'tailoring' THEN 'tailor_queued'
       WHEN status = 'generating' THEN 'generate_queued'
       ELSE status END
     WHERE status IN ('researching', 'tailoring', 'generating')`,
  ).run();
  workerTimer = setInterval(() => void processNext(), 1000);
  void processNext();
}

export function stopWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = undefined;
}

export function consumeWorkflowCredit(userId: string, applicationId: string): void {
  const month = new Date().toISOString().slice(0, 7);
  const quota =
    (
      db.query("SELECT monthly_quota FROM user_settings WHERE user_id = ?").get(userId) as
        | { monthly_quota: number }
        | null
    )?.monthly_quota ?? 25;
  const used = (
    db
      .query(
        `SELECT COUNT(*) AS count FROM usage_events
         WHERE user_id = ? AND operation = 'workflow_credit' AND substr(created_at, 1, 7) = ?`,
      )
      .get(userId, month) as { count: number }
  ).count;
  if (used >= quota) throw new Error(`Monthly quota reached (${quota}).`);

  const globalBudget = Number(process.env.MONTHLY_OPENROUTER_BUDGET_USD ?? "0");
  if (globalBudget > 0) {
    const spent = (
      db
        .query(
          `SELECT COALESCE(SUM(cost), 0) AS cost FROM usage_events
           WHERE substr(created_at, 1, 7) = ?`,
        )
        .get(month) as { cost: number }
    ).cost;
    if (spent >= globalBudget) throw new Error("Global monthly OpenRouter budget reached.");
  }

  db.query(
    `INSERT INTO usage_events
      (id, user_id, application_id, operation, model, created_at)
     VALUES (?, ?, ?, 'workflow_credit', 'local', ?)`,
  ).run(id(), userId, applicationId, now());
}

export async function extractProfileFromText(userId: string, text: string): Promise<WebProfile> {
  const schema = profileSchema();
  const result = await requestJson<WebProfile>({
    operation: "profile_extract",
    userId,
    system:
      "Extract only facts present in the CV text. Never infer dates, employers, metrics, credentials, authority, or language levels. Preserve original wording where uncertain. Return strict JSON.",
    prompt: `Extract a reusable CV profile from this text.\n\n${text.slice(0, 60_000)}`,
    schema,
  });
  return validateProfile(result.value);
}

async function processNext(): Promise<void> {
  if (workerBusy) return;
  const application = db
    .query(
      `SELECT * FROM applications
       WHERE status IN ('research_queued', 'tailor_queued', 'generate_queued')
       ORDER BY updated_at ASC LIMIT 1`,
    )
    .get() as ApplicationRow | null;
  if (!application) return;
  workerBusy = true;
  try {
    if (application.status === "research_queued") await research(application);
    else if (application.status === "tailor_queued") await tailor(application);
    else await generate(application);
  } catch (error) {
    db.query("UPDATE applications SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
      error instanceof Error ? error.message : String(error),
      now(),
      application.id,
    );
  } finally {
    workerBusy = false;
  }
}

async function research(application: ApplicationRow): Promise<void> {
  transition(application.id, "research_queued", "researching");
  const profile = loadProfile(application.user_id);
  const saved = application.reuse_company_context
    ? (db
        .query(
          `SELECT content_md FROM documents
           WHERE user_id = ? AND company_key = ? AND kind = 'company_context'
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(application.user_id, application.company_key) as { content_md: string } | null)
    : null;

  let companyResearch = saved?.content_md ?? "";
  let sources: FitReport["sources"] = [];
  if (!companyResearch) {
    const result = await requestText({
      operation: "company_research",
      userId: application.user_id,
      applicationId: application.id,
      webSearch: true,
      system:
        "Research companies for job candidates. Search current official sources first, then credible recent reporting. Do not search LinkedIn or personal information. Cite factual claims and distinguish facts from inference.",
      prompt: `Research ${application.company} for this role: ${application.role}.

Explain:
- what the company does;
- current strategy, products, and market;
- recent challenges or priorities relevant to this role;
- likely reason this position exists.

JOB POST:
${application.job_text.slice(0, 30_000)}`,
    });
    companyResearch = result.value;
    sources = result.annotations
      .map((annotation) => annotation.url_citation)
      .filter((source): source is NonNullable<typeof source> => Boolean(source?.url))
      .map((source) => ({
        title: source.title ?? source.url ?? "Source",
        url: source.url ?? "",
        content: source.content,
      }));
    saveDocument(
      application.user_id,
      "company_context",
      `${application.company} — company context`,
      application.company_key,
      application.id,
      companyResearch,
    );
  }

  const fit = await requestJson<Omit<FitReport, "sources">>({
    operation: "fit_analysis",
    userId: application.user_id,
    applicationId: application.id,
    system:
      "Assess job fit assertively but truthfully. Requirements are signals, not automatic rejection gates. Distinguish direct, transferable, inferred, unverified, and unsupported evidence. Never invent experience, dates, titles, metrics, credentials, ownership, or authority.",
    prompt: `Return concise ${targetLanguage(application.language, application.job_text)} fit analysis.

COMPANY RESEARCH:
${companyResearch}

JOB:
${application.job_text}

CANDIDATE PROFILE:
${JSON.stringify(profile)}`,
    schema: fitSchema,
  });
  const report = validateFit({ ...fit.value, sources });
  db.query(
    `UPDATE applications SET research_json = ?, fit_json = ?, status = 'research_ready',
      error = NULL, updated_at = ? WHERE id = ?`,
  ).run(
    JSON.stringify({ markdown: companyResearch, sources }),
    JSON.stringify(report),
    now(),
    application.id,
  );
  saveDocument(
    application.user_id,
    "role_context",
    `${application.company} — ${application.role}`,
    application.company_key,
    application.id,
    fitMarkdown(report),
  );
}

async function tailor(application: ApplicationRow): Promise<void> {
  transition(application.id, "tailor_queued", "tailoring");
  const profile = loadProfile(application.user_id);
  const template = loadTemplate(application);
  const slots = json<TemplateSlot[]>(template.mapping_json, []);
  const allowed = slots
    .filter((slot) => slot.protection === "tailorable")
    .map((slot) => ({ path: slot.fieldPath, current: getPath(profile, slot.fieldPath) }));
  if (!allowed.length) throw new Error("Template has no tailorable mapped fields.");

  const fit = json<FitReport>(application.fit_json, {} as FitReport);
  const result = await requestJson<TailoringProposal>({
    operation: "tailoring_proposal",
    userId: application.user_id,
    applicationId: application.id,
    system:
      "Tailor a CV with confident, creative positioning but no fabrication. Startup role titles may change only when broad evidenced responsibilities support the new lens. Never change identity, employers, dates, locations, education, credentials, metrics, or unsupported authority. Return only useful edits.",
    prompt: `Write in ${targetLanguage(application.language, application.job_text)}.
Keep the CV concise and likely within two pages. Do not blindly copy the job post.

APPROVED FIT:
${JSON.stringify(fit)}

JOB:
${application.job_text}

BACKGROUND:
${profile.background}

ONLY THESE PATHS MAY CHANGE:
${JSON.stringify(allowed)}

Return oldText exactly as supplied and a defensible newText.`,
    schema: proposalSchema,
  });
  const proposal = validateTailoringProposal(result.value, profile, new Set(allowed.map((item) => item.path)));
  db.query(
    `UPDATE applications SET proposal_json = ?, status = 'proposal_ready',
      error = NULL, updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(proposal), now(), application.id);
}

async function generate(application: ApplicationRow): Promise<void> {
  transition(application.id, "generate_queued", "generating");
  const profile = loadProfile(application.user_id);
  const template = loadTemplate(application);
  const slots = json<TemplateSlot[]>(template.mapping_json, []);
  const proposal = validateTailoringProposal(
    json<TailoringProposal>(application.proposal_json, { edits: [], warnings: [] }),
    profile,
    new Set(
      slots.filter((slot) => slot.protection === "tailorable").map((slot) => slot.fieldPath),
    ),
  );
  const tailored = structuredClone(profile);
  for (const edit of proposal.edits) setPath(tailored, edit.path, edit.newText);

  const directory = join(artifactsDir, application.user_id, "applications", application.id);
  await mkdir(directory, { recursive: true });
  const filename = safeFilename(`${application.company} - ${application.role} - CV.docx`);
  const path = join(directory, filename);
  await renderMappedTemplate(template.source_path, path, slots, tailored);
  const preview = await extractDocxText(path);
  const digest = await sha256(path);
  db.query(
    `INSERT INTO artifacts
      (id, user_id, application_id, kind, filename, path, preview_text, sha256, created_at)
     VALUES (?, ?, ?, 'cv_docx', ?, ?, ?, ?, ?)`,
  ).run(id(), application.user_id, application.id, filename, path, preview, digest, now());

  const review = proposalMarkdown(application, proposal);
  const reviewFilename = safeFilename(`${application.company} - ${application.role} - review.md`);
  const reviewPath = join(directory, reviewFilename);
  await Bun.write(reviewPath, review);
  db.query(
    `INSERT INTO artifacts
      (id, user_id, application_id, kind, filename, path, preview_text, sha256, created_at)
     VALUES (?, ?, ?, 'review_md', ?, ?, ?, ?, ?)`,
  ).run(
    id(),
    application.user_id,
    application.id,
    reviewFilename,
    reviewPath,
    review,
    await sha256(reviewPath),
    now(),
  );

  db.query(
    `UPDATE applications SET tailored_profile_json = ?, status = 'complete',
      error = NULL, updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(tailored), now(), application.id);
}

function loadProfile(userId: string): WebProfile {
  const row = db.query("SELECT content_json FROM profiles WHERE user_id = ?").get(userId) as
    | { content_json: string }
    | null;
  if (!row) throw new Error("Complete profile before tailoring.");
  return validateProfile(json<WebProfile>(row.content_json, {} as WebProfile));
}

function loadTemplate(application: ApplicationRow): TemplateRow {
  if (!application.template_id) throw new Error("Select a template.");
  const template = db
    .query("SELECT * FROM templates WHERE id = ? AND user_id = ? AND status = 'active'")
    .get(application.template_id, application.user_id) as TemplateRow | null;
  if (!template) throw new Error("Active template not found.");
  return template;
}

function transition(idValue: string, expected: string, next: string): void {
  const result = db
    .query("UPDATE applications SET status = ?, error = NULL, updated_at = ? WHERE id = ? AND status = ?")
    .run(next, now(), idValue, expected);
  if (result.changes !== 1) throw new Error(`Application state changed before ${next}.`);
}

function saveDocument(
  userId: string,
  kind: string,
  title: string,
  companyKey: string | null,
  applicationId: string | null,
  content: string,
): void {
  const timestamp = now();
  db.query(
    `INSERT INTO documents
      (id, user_id, kind, title, company_key, application_id, content_md, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id(), userId, kind, title, companyKey, applicationId, content, timestamp, timestamp);
}

function validateProfile(value: WebProfile): WebProfile {
  if (!value?.personal || !Array.isArray(value.experiences)) throw new Error("Invalid profile.");
  value.personal.name = String(value.personal.name ?? "");
  value.personal.headline = String(value.personal.headline ?? "");
  value.personal.email = String(value.personal.email ?? "");
  value.personal.phone = String(value.personal.phone ?? "");
  value.personal.location = String(value.personal.location ?? "");
  value.personal.links = String(value.personal.links ?? "");
  value.summary = String(value.summary ?? "");
  value.background = String(value.background ?? "");
  value.education = stringArray(value.education);
  value.skills = stringArray(value.skills);
  value.languages = stringArray(value.languages);
  value.rules = stringArray(value.rules);
  value.experiences = value.experiences.map((experience, index) => ({
    id: experience.id || `experience-${index + 1}`,
    company: String(experience.company ?? ""),
    context: String(experience.context ?? ""),
    location: String(experience.location ?? ""),
    role: String(experience.role ?? ""),
    period: String(experience.period ?? ""),
    bullets: stringArray(experience.bullets),
  }));
  return value;
}

function validateFit(value: FitReport): FitReport {
  if (!Number.isFinite(value.score) || value.score < 0 || value.score > 10) {
    throw new Error("Invalid fit score.");
  }
  value.sources = Array.isArray(value.sources) ? value.sources : [];
  return value;
}

export function validateTailoringProposal(
  value: TailoringProposal,
  profile: WebProfile,
  allowed: Set<string>,
): TailoringProposal {
  if (!Array.isArray(value.edits) || !Array.isArray(value.warnings)) {
    throw new Error("Invalid tailoring proposal.");
  }
  const edits: TailoringEdit[] = [];
  for (const edit of value.edits) {
    if (!allowed.has(edit.path)) throw new Error(`Proposal changed protected field: ${edit.path}`);
    const current = getPath(profile, edit.path);
    if (typeof current !== "string" || current !== edit.oldText) {
      throw new Error(`Proposal oldText mismatch: ${edit.path}`);
    }
    if (!edit.newText.trim()) continue;
    if (edit.evidence === "unsupported") {
      value.warnings.push(`Rejected unsupported edit: ${edit.path}`);
      continue;
    }
    edits.push(edit);
  }
  return { edits, warnings: stringArray(value.warnings) };
}

function targetLanguage(setting: string, job: string): string {
  if (setting === "fr") return "French";
  if (setting === "en") return "English";
  return /\b(vous|poste|missions|profil|entreprise)\b/i.test(job) ? "French" : "English";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function setPath(value: unknown, path: string, next: string): void {
  const keys = path.split(".");
  const last = keys.pop();
  if (!last) throw new Error("Invalid edit path.");
  const parent = keys.reduce<unknown>((current, key) => {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
  if (!parent || typeof parent !== "object") throw new Error(`Invalid edit path: ${path}`);
  (parent as Record<string, unknown>)[last] = next;
}

function fitMarkdown(fit: FitReport): string {
  return `# Fit: ${fit.score}/10

## Company

${fit.companySummary}

## Current challenges

${fit.currentChallenges.map((item) => `- ${item}`).join("\n")}

## Highlight

${fit.highlights.map((item) => `- [${item.evidence}] ${item.text}`).join("\n")}

## Weak points

${fit.weakPoints.map((item) => `- ${item}`).join("\n")}

## Keywords

${fit.keywords.join(" · ")}
`;
}

function proposalMarkdown(application: ApplicationRow, proposal: TailoringProposal): string {
  return `# ${application.company} — ${application.role}

## Approved CV changes

${proposal.edits
  .map(
    (edit) => `### ${edit.path}

- Old: ${edit.oldText}
- New: ${edit.newText}
- Evidence: ${edit.evidence}
- Reason: ${edit.reason}`,
  )
  .join("\n\n")}

## Warnings

${proposal.warnings.map((warning) => `- ${warning}`).join("\n") || "- None"}
`;
}

function profileSchema(): Record<string, unknown> {
  const stringArraySchema = { type: "array", items: { type: "string" } };
  return {
    type: "object",
    additionalProperties: false,
    required: ["personal", "summary", "background", "experiences", "education", "skills", "languages", "rules"],
    properties: {
      personal: {
        type: "object",
        additionalProperties: false,
        required: ["name", "headline", "email", "phone", "location", "links"],
        properties: {
          name: { type: "string" },
          headline: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          location: { type: "string" },
          links: { type: "string" },
        },
      },
      summary: { type: "string" },
      background: { type: "string" },
      experiences: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "company", "context", "location", "role", "period", "bullets"],
          properties: {
            id: { type: "string" },
            company: { type: "string" },
            context: { type: "string" },
            location: { type: "string" },
            role: { type: "string" },
            period: { type: "string" },
            bullets: stringArraySchema,
          },
        },
      },
      education: stringArraySchema,
      skills: stringArraySchema,
      languages: stringArraySchema,
      rules: stringArraySchema,
    },
  };
}
