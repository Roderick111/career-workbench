import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  FitReport,
  ResearchSource,
  TailoringEdit,
  TailoringProposal,
  TemplateSlot,
  WebProfile,
} from "../web-types";
import { db, id, json, now, artifactsDir } from "./db";
import { requestJson, requestText } from "./openrouter";
import { logEvent } from "./observability";
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
  user_comment: string;
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

export interface ProfileReconciliationResult {
  profile: WebProfile;
  model: string;
  warnings: string[];
  reviewPaths: string[];
}

interface ProfileReconciliationPayload {
  profile: WebProfile;
  warnings: string[];
}

export async function reconcileProfileFromText(
  userId: string,
  current: WebProfile,
  text: string,
  requestId?: string,
): Promise<ProfileReconciliationResult> {
  const result = await requestJson<ProfileReconciliationPayload>({
    operation: "profile_reconcile",
    userId,
    requestId,
    system: `Reconcile one imported career document into an existing canonical career profile.

Return one complete updated profile, not a patch and not a second profile.

Rules:
- Use only facts present in the current profile or imported source.
- Preserve existing facts when the imported source is silent.
- Update and enrich matching experiences and projects instead of duplicating them.
- Match employers despite descriptors, product names, punctuation, translated names, or alternative role labels.
- Keep only the canonical employer name in company; move descriptors into context.
- Reuse the current id for every matching experience and project.
- Use an empty id for genuinely new experiences and projects; the server assigns it.
- Preserve current identity details and all existing records.
- Deduplicate semantically equivalent bullets and list entries while retaining distinct evidence.
- Treat alternative CV job titles as possible positioning, not automatic factual corrections.
- If dates, employers, titles, credentials, or other facts conflict, choose the most defensible wording and explain the conflict in warnings.
- Field-specific warnings must begin with the canonical field path, for example 'experiences.exp-2.role: ...'.
- Never invent authority, dates, employers, credentials, metrics, language levels, outcomes, or responsibilities.
- The background field preserves useful factual context not represented elsewhere.
- The rules field contains candidate-authored tailoring preferences only.

Example: "Sally – AI Sales Representative | Business Development Manager" can describe employer Sally, context AI Sales Representative, and role Business Development Manager. It must not create a second employer when Sally already exists.`,
    prompt: buildProfileReconciliationPrompt(current, text),
    schema: profileReconciliationSchema(),
    maxTokens: 8000,
  });
  const reconciled = validateReconciledProfile(result.value, current);
  return {
    ...reconciled,
    model: result.model,
  };
}

export function buildProfileReconciliationPrompt(current: WebProfile, text: string): string {
  return `CURRENT CANONICAL PROFILE:
${JSON.stringify(validateProfile(structuredClone(current)))}

NEW IMPORTED SOURCE:
${text.slice(0, 60_000)}

Return the complete reconciled profile and concise warnings.`;
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

  let companyResearch =
    saved?.content_md && !hasUnresolvedWebToolCall(saved.content_md) ? saved.content_md : "";
  let sources: FitReport["sources"] = [];
  if (!companyResearch) {
    const prompt = buildCompanyResearchPrompt(
      application.company,
      application.role,
      application.job_text,
    );
    let result = await requestText({
      operation: "company_research",
      userId: application.user_id,
      applicationId: application.id,
      webSearch: true,
      system:
        "Research companies for job candidates. Use supplied web results and return the final research brief, never tool-call syntax. Prioritize official company sources, then credible recent reporting. Do not search LinkedIn or personal information. Cite factual claims with Markdown links and distinguish facts from inference.",
      prompt,
    });
    let validated: { content: string; sources: ResearchSource[] };
    try {
      validated = validateCompanyResearch(result.value, result.annotations, application.company);
    } catch (error) {
      logEvent("warn", "company_research.rejected", {
        applicationId: application.id,
        userId: application.user_id,
        model: result.model,
        reason: error instanceof Error ? error.message : String(error),
      });
      result = await requestText({
        operation: "company_research_retry",
        userId: application.user_id,
        applicationId: application.id,
        webSearch: true,
        preferFallback: true,
        system:
          "Return a finished company research brief using supplied web results. Never output function calls, XML tool syntax, search plans, or uncited claims. Use Markdown links. Prioritize official company sources and distinguish facts from inference.",
        prompt,
      });
      validated = validateCompanyResearch(result.value, result.annotations, application.company);
    }
    companyResearch = validated.content;
    sources = validated.sources;
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

export function buildCompanyResearchPrompt(company: string, role: string, jobText: string): string {
  return `Research the exact company "${company}" for this role: "${role}".

Search using the exact company name. Prefer the official company website, official reports, and relevant recent business or trade reporting. Ignore results about similarly named entities.

Return a concise final brief covering:
- what the company does;
- current strategy, products, and market;
- recent challenges or priorities relevant to this role;
- likely reason this position exists.

Use Markdown links for every source. Return prose only, never a search plan or tool-call markup.

ROLE CONTEXT EXCERPT:
${jobText.slice(0, 2_500)}`;
}

export function validateCompanyResearch(
  content: string,
  annotations: Array<{
    type?: string;
    url_citation?: { url?: string; title?: string; content?: string };
  }>,
  company: string,
): { content: string; sources: ResearchSource[] } {
  if (hasUnresolvedWebToolCall(content)) {
    throw new Error("Research returned an unresolved web-search tool call.");
  }
  if (content.trim().length < 300) throw new Error("Research response is too short.");

  const sources = annotations
    .map((annotation) => annotation.url_citation)
    .filter(
      (source): source is { url: string; title?: string; content?: string } =>
        Boolean(source?.url) &&
        content.includes(source!.url!) &&
        sourceRelevantToCompany(source!, company),
    )
    .map((source) => ({
      title: source.title ?? source.url,
      url: source.url,
      content: source.content,
    }));
  const unique = [...new Map(sources.map((source) => [source.url, source])).values()];
  if (!unique.length) {
    throw new Error("Research contained no cited source relevant to the company.");
  }
  return { content: content.trim(), sources: unique };
}

function hasUnresolvedWebToolCall(content: string): boolean {
  return /<function_calls>|<invoke\s+name=["']?web_search|<parameter\s+name=["']?query|tool_calls/i.test(
    content,
  );
}

function sourceRelevantToCompany(
  source: { url?: string; title?: string; content?: string },
  company: string,
): boolean {
  if (!source.url) return false;
  const stopWords = new Set([
    "company",
    "corporation",
    "group",
    "groupe",
    "holding",
    "inc",
    "limited",
    "ltd",
    "sas",
    "societe",
  ]);
  const terms = normalizedWords(company).filter((term) => term.length >= 3 && !stopWords.has(term));
  if (!terms.length) return false;
  const sourceWords = new Set(
    normalizedWords(`${source.title ?? ""} ${source.url} ${source.content ?? ""}`),
  );
  const matches = terms.filter((term) => sourceWords.has(term)).length;
  return matches >= Math.min(2, terms.length);
}

function normalizedWords(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
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
      "Tailor a CV with confident, creative positioning but no fabrication. Startup role titles may change only when broad evidenced responsibilities support the new lens. Use only natural, established market titles that stand on their own. Never mechanically combine words from the job post with the existing title to manufacture a hybrid title; never output awkward keyword titles such as 'Chef de Projet Produit'. Prefer the original title when no clearly better standard title exists, and put target keywords in the bullets instead. Skill categories are dynamic: regroup, rename, reorder, or omit them according to the target role instead of forcing fixed categories such as Finance, Techniques, or Gestion de Produit. Infer concise capability labels from demonstrated work and add relevant ATS keywords when they accurately summarize that evidence, even if the exact phrase is absent. Distinguish hands-on expertise from project exposure or familiarity with a technology environment. Never add unsupported technologies, methodologies, domains, certifications, seniority, authority, metrics, or responsibilities. Never change identity, employers, dates, locations, education, or credentials. Return at most 8 material edits. Never return unchanged text. Do not add guarantees, process steps, delivery stages, budgets, quality ownership, KPIs, reporting, or responsibilities unless explicit in the same experience or project evidence.",
    prompt: `Write in ${targetLanguage(application.language, application.job_text)}.
Keep the CV concise and likely within two pages. Do not blindly copy the job post.

APPROVED FIT:
${JSON.stringify(fit)}

JOB:
${application.job_text}

BACKGROUND:
${profile.background}

USER INSTRUCTIONS (additional guidance only; do not replace the job post, research, profile, or existing facts):
${application.user_comment?.trim() || "(none)"}

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

export function validateProfile(value: WebProfile): WebProfile {
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
  value.certifications = stringArray(value.certifications);
  value.skills = stringArray(value.skills);
  value.languages = stringArray(value.languages);
  value.rules = stringArray(value.rules).filter(
    (rule) =>
      !/extract only facts|never infer|preserve original wording|return strict json|extraction instructions/i.test(
        rule,
      ),
  );
  value.experiences = value.experiences.map((experience, index) => ({
    id: experience.id || `experience-${index + 1}`,
    company: String(experience.company ?? ""),
    context: String(experience.context ?? ""),
    location: String(experience.location ?? ""),
    role: String(experience.role ?? ""),
    period: String(experience.period ?? ""),
    bullets: stringArray(experience.bullets),
  }));
  value.projects = (Array.isArray(value.projects) ? value.projects : []).map((project, index) => ({
    id: project.id || `project-${index + 1}`,
    name: String(project.name ?? ""),
    context: String(project.context ?? ""),
    period: String(project.period ?? ""),
    bullets: stringArray(project.bullets),
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
  const seen = new Set<string>();
  for (const edit of value.edits) {
    if (!allowed.has(edit.path)) throw new Error(`Proposal changed protected field: ${edit.path}`);
    const current = getPath(profile, edit.path);
    if (typeof current !== "string" || current !== edit.oldText) {
      throw new Error(`Proposal oldText mismatch: ${edit.path}`);
    }
    if (!edit.newText.trim() || normalizedText(edit.newText) === normalizedText(edit.oldText)) continue;
    if (seen.has(edit.path)) continue;
    if (edit.evidence === "unsupported") {
      value.warnings.push(`Rejected unsupported edit: ${edit.path}`);
      continue;
    }
    if (introducesUnsupportedClaim(edit.newText, evidenceForPath(profile, edit.path))) {
      value.warnings.push(`Rejected unsupported claim expansion: ${edit.path}`);
      continue;
    }
    seen.add(edit.path);
    if (edits.length < 8) edits.push(edit);
  }
  return { edits, warnings: stringArray(value.warnings) };
}

export function validateReconciledProfile(
  value: ProfileReconciliationPayload,
  currentValue: WebProfile,
): { profile: WebProfile; warnings: string[]; reviewPaths: string[] } {
  if (!value || !Array.isArray(value.warnings)) throw new Error("Invalid profile reconciliation.");
  const current = validateProfile(structuredClone(currentValue));
  const profile = validateProfile(structuredClone(value.profile));
  const warnings = stringArray(value.warnings);
  const reviewPaths = new Set<string>(pathsFromWarnings(warnings));

  for (const key of ["name", "email", "phone"] as const) {
    if (
      current.personal[key].trim() &&
      normalizedText(current.personal[key]) !== normalizedText(profile.personal[key])
    ) {
      throw new Error(`Reconciliation changed protected identity field: personal.${key}`);
    }
  }

  validateExistingRecords(
    current.experiences,
    profile.experiences,
    "experience",
    warnings,
    reviewPaths,
    ["company", "role", "period"],
  );
  validateExistingRecords(
    current.projects,
    profile.projects,
    "project",
    warnings,
    reviewPaths,
    ["name", "period"],
  );
  assignNewIds(profile.experiences, new Set(current.experiences.map((item) => item.id)), "experience");
  assignNewIds(profile.projects, new Set(current.projects.map((item) => item.id)), "project");

  for (const key of ["education", "certifications", "skills", "languages", "rules"] as const) {
    for (const removed of removedStrings(current[key], profile[key])) {
      warnings.push(`${key} entry removed: ${removed}`);
      reviewPaths.add(key);
    }
  }
  if (current.summary.trim() && !profile.summary.trim()) {
    warnings.push("Existing summary was removed.");
    reviewPaths.add("summary");
  }
  if (current.background.trim() && !profile.background.trim()) {
    warnings.push("Existing background was removed.");
    reviewPaths.add("background");
  }

  return { profile, warnings: [...new Set(warnings)], reviewPaths: [...reviewPaths] };
}

function validateExistingRecords<T extends { id: string; bullets: string[] }>(
  current: T[],
  next: T[],
  kind: "experience" | "project",
  warnings: string[],
  reviewPaths: Set<string>,
  comparedFields: string[],
): void {
  const nextIds = next.map((item) => item.id).filter(Boolean);
  if (new Set(nextIds).size !== nextIds.length) throw new Error(`Duplicate ${kind} id.`);
  for (const existing of current) {
    const matches = next.filter((item) => item.id === existing.id);
    if (matches.length !== 1) throw new Error(`Reconciliation lost existing ${kind}: ${existing.id}`);
    const reconciled = matches[0]!;
    for (const field of comparedFields) {
      const before = String((existing as unknown as Record<string, unknown>)[field] ?? "");
      const after = String((reconciled as unknown as Record<string, unknown>)[field] ?? "");
      if (normalizedText(before) !== normalizedText(after)) {
        warnings.push(`${kind} ${existing.id} ${field} changed: "${before}" → "${after}"`);
        reviewPaths.add(`${kind === "experience" ? "experiences" : "projects"}.${existing.id}.${field}`);
      }
    }
    for (const removed of removedStrings(existing.bullets, reconciled.bullets)) {
      warnings.push(`${kind} ${existing.id} bullet removed: ${removed}`);
      reviewPaths.add(`${kind === "experience" ? "experiences" : "projects"}.${existing.id}.bullets`);
    }
  }
}

function assignNewIds<T extends { id: string }>(
  records: T[],
  existingIds: Set<string>,
  prefix: string,
): void {
  const used = new Set(existingIds);
  for (const record of records) {
    if (!record.id || !existingIds.has(record.id)) {
      do record.id = `${prefix}-${crypto.randomUUID()}`;
      while (used.has(record.id));
    }
    used.add(record.id);
  }
}

function removedStrings(current: string[], next: string[]): string[] {
  const nextValues = new Set(next.map(normalizedText));
  return current.filter((item) => !nextValues.has(normalizedText(item)));
}

function pathsFromWarnings(warnings: string[]): string[] {
  const paths = new Set<string>();
  const pattern = /\b(?:personal|experiences|projects|summary|background|education|certifications|skills|languages|rules)(?:\.[A-Za-z0-9_-]+)*/g;
  for (const warning of warnings) {
    for (const match of warning.matchAll(pattern)) paths.add(match[0]);
  }
  return [...paths];
}

function normalizedText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function evidenceForPath(profile: WebProfile, path: string): string {
  const experience = path.match(/^experiences\.(\d+)\./);
  if (experience) {
    const item = profile.experiences[Number(experience[1])];
    return item ? Object.values(item).flat().join(" ") : "";
  }
  const project = path.match(/^projects\.(\d+)\./);
  if (project) {
    const item = profile.projects[Number(project[1])];
    return item ? Object.values(item).flat().join(" ") : "";
  }
  const current = getPath(profile, path);
  return typeof current === "string" ? current : "";
}

function introducesUnsupportedClaim(next: string, evidence: string): boolean {
  const normalizedNext = normalizedText(next);
  const normalizedEvidence = normalizedText(evidence);
  const numbers = normalizedNext.match(/\b\d+(?:[.,]\d+)?%?\b/g) ?? [];
  if (numbers.some((number) => !normalizedEvidence.includes(number))) return true;

  const claimMarkers = [
    "doubl",
    "tripl",
    "garant",
    "kpi",
    "reporting",
    "budget",
    "marge",
    "charges",
    "qualite",
    "deploiement",
    "specification",
    "critere d'acceptation",
    "engagement de resultats",
    "cadrage projet",
    "suivi de performance",
  ];
  return claimMarkers.some(
    (marker) => normalizedNext.includes(marker) && !normalizedEvidence.includes(marker),
  );
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
  const portfolioItemSchema = {
    type: "object",
    additionalProperties: false,
    required: ["id", "name", "context", "period", "bullets"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      context: { type: "string" },
      period: { type: "string" },
      bullets: stringArraySchema,
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "personal",
      "summary",
      "background",
      "experiences",
      "projects",
      "education",
      "certifications",
      "skills",
      "languages",
      "rules",
    ],
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
      projects: { type: "array", items: portfolioItemSchema },
      education: {
        ...stringArraySchema,
        description: "Every degree or education entry, preserving institution, program, and date.",
      },
      certifications: {
        ...stringArraySchema,
        description: "Every certification or professional training entry.",
      },
      skills: {
        ...stringArraySchema,
        description: "All explicit technical, product, business, finance, design, and domain skills.",
      },
      languages: {
        ...stringArraySchema,
        description: "Every language exactly as stated, including level only when explicit.",
      },
      rules: {
        ...stringArraySchema,
        description: "Candidate-authored tailoring preferences only; normally empty for a CV import.",
      },
    },
  };
}

function profileReconciliationSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["profile", "warnings"],
    properties: {
      profile: profileSchema(),
      warnings: { type: "array", items: { type: "string" } },
    },
  };
}
