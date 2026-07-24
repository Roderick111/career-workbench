import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import type { TailoringProposal, TemplateSlot, WebProfile } from "../web-types";
import { EMPTY_PROFILE } from "../web-types";
import { auth, migrateAuthSchema, type AuthSession } from "./auth";
import {
  artifactsDir,
  db,
  id,
  json,
  migrateApplicationSchema,
  normalizeCompany,
  now,
} from "./db";
import {
  analyzeTemplate,
  createStarterTemplate,
  extractDocxText,
  isProtectedPath,
  renderMappedTemplate,
  resolveMappingConflicts,
  safeFilename,
  starterTemplateProfile,
} from "./template";
import {
  beginOperation,
  finishOperation,
  logEvent,
  updateOperationInput,
} from "./observability";
import { artifactHeaders } from "./download";
import {
  consumeWorkflowCredit,
  reconcileProfileFromText,
  startWorker,
  stopWorker,
  validateTailoringProposal,
  validateProfile,
} from "./workflow";

await migrateAuthSchema();
migrateApplicationSchema();

type Variables = {
  session: AuthSession | null;
  requestId: string;
};

const app = new Hono<{ Variables: Variables }>();

app.use("/api/*", async (c, next) => {
  const requestId = c.req.header("x-request-id") || id();
  const startedAt = Date.now();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);
  logEvent("info", "http.request.started", {
    requestId,
    method: c.req.method,
    path: c.req.path,
  });
  try {
    await next();
  } finally {
    logEvent("info", "http.request.completed", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
      userId: c.get("session")?.user.id,
    });
  }
});

app.use(
  "/api/*",
  bodyLimit({
    maxSize: 10 * 1024 * 1024,
    onError: (c) => c.json({ error: "Request exceeds 10 MB." }, 413),
  }),
);

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/") || c.req.path === "/api/register" || c.req.path === "/api/health") {
    c.set("session", null);
    return next();
  }
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("session", session);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.get("/api/health", (c) => {
  db.query("SELECT 1").get();
  return c.json({ ok: true });
});

app.post("/api/register", async (c) => {
  const body = await c.req.json<{ token?: string; email?: string; name?: string; password?: string }>();
  if (!body.token || !body.email || !body.name || !body.password) {
    return c.json({ error: "Token, email, name, and password are required." }, 400);
  }
  if (body.password.length < 10) return c.json({ error: "Password must contain at least 10 characters." }, 400);
  const tokenHash = hashToken(body.token);
  const invite = db
    .query(
      `SELECT id, email FROM invites
       WHERE token_hash = ? AND claimed_at IS NULL AND expires_at > ?`,
    )
    .get(tokenHash, now()) as { id: string; email: string } | null;
  if (!invite || invite.email.toLowerCase() !== body.email.trim().toLowerCase()) {
    return c.json({ error: "Invite is invalid, expired, or belongs to another email." }, 400);
  }
  const claimId = id();
  const claimed = db
    .query("UPDATE invites SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL")
    .run(`pending:${claimId}`, invite.id);
  if (claimed.changes !== 1) return c.json({ error: "Invite has already been used." }, 409);
  try {
    const created = await auth.api.signUpEmail({
      body: {
        email: body.email.trim().toLowerCase(),
        name: body.name.trim(),
        password: body.password,
      },
      headers: new Headers({
        "x-invite-token": body.token,
        "x-invite-claim": claimId,
      }),
    });
    db.query("UPDATE invites SET claimed_at = ? WHERE id = ?").run(now(), invite.id);
    const timestamp = now();
    db.query(
      `INSERT INTO profiles (user_id, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(created.user.id, JSON.stringify(EMPTY_PROFILE), timestamp, timestamp);
    db.query(
      `INSERT INTO user_settings (user_id, monthly_quota, created_at, updated_at)
       VALUES (?, 25, ?, ?)`,
    ).run(created.user.id, timestamp, timestamp);
    return c.json({ ok: true }, 201);
  } catch (error) {
    db.query("UPDATE invites SET claimed_at = NULL WHERE id = ?").run(invite.id);
    return c.json({ error: message(error) }, 400);
  }
});

app.get("/api/me", (c) => {
  const session = requiredSession(c);
  const usage = monthlyUsage(session.user.id);
  return c.json({ user: session.user, usage });
});

app.get("/api/profile", (c) => {
  const userId = requiredSession(c).user.id;
  const row = db.query("SELECT content_json FROM profiles WHERE user_id = ?").get(userId) as
    | { content_json: string }
    | null;
  return c.json(
    validateProfile(
      row
        ? json<WebProfile>(row.content_json, structuredClone(EMPTY_PROFILE))
        : structuredClone(EMPTY_PROFILE),
    ),
  );
});

app.put("/api/profile", async (c) => {
  const userId = requiredSession(c).user.id;
  try {
    const profile = validateProfile((await c.req.json()) as WebProfile);
    saveProfile(userId, profile);
    return c.json({ ok: true, savedAt: now() });
  } catch (error) {
    return c.json({ error: message(error) }, 400);
  }
});

app.post("/api/profile/extract", async (c) => {
  const userId = requiredSession(c).user.id;
  const requestId = c.get("requestId");
  const operation = beginOperation(userId, "profile_reconcile", requestId);
  if (!operation) {
    return c.json(
      {
        error: "Profile update is already running. Wait for the current analysis to finish.",
        requestId,
      },
      409,
    );
  }
  try {
    const form = await c.req.formData();
    const file = form.get("file");
    const pasted = String(form.get("text") ?? "");
    const sourceMode = form.get("mode") === "context" ? "context" : "profile";
    let text = pasted;
    let inputName = pasted.trim() ? "pasted-text" : undefined;
    let inputBytes = new TextEncoder().encode(pasted).byteLength;
    if (file instanceof File && file.size) {
      const lowerName = file.name.toLowerCase();
      if (!lowerName.endsWith(".docx") && !lowerName.endsWith(".md") && !lowerName.endsWith(".txt")) {
        throw new Error("Import accepts DOCX, Markdown, TXT, or pasted text.");
      }
      const directory = join(artifactsDir, userId, "imports");
      await mkdir(directory, { recursive: true });
      const path = join(directory, `${id()}-${safeFilename(file.name)}`);
      await Bun.write(path, file);
      text = lowerName.endsWith(".docx") ? await extractDocxText(path) : await file.text();
      inputName = safeFilename(file.name);
      inputBytes = file.size;
    }
    updateOperationInput(operation, {
      name: inputName,
      bytes: inputBytes,
      characters: text.length,
    });
    if (text.trim().length < 50) throw new Error("Not enough source text.");

    if (sourceMode === "context") {
      const current = loadProfile(userId);
      const saved = !profileHasContent(current);
      const title = inputName && inputName !== "pasted-text" ? `## ${inputName}\n\n` : "";
      const addition = `${title}${text.trim()}`;
      const profile = validateProfile({
        ...current,
        background: [current.background.trim(), addition].filter(Boolean).join("\n\n---\n\n"),
      });
      if (saved) saveProfile(userId, profile);
      const details = {
        sourceMode,
        saved,
        contextCharactersAdded: addition.length,
      };
      finishOperation(operation, "succeeded", details);
      return c.json({
        profile,
        mode: sourceMode,
        saved,
        warnings: [],
        reviewPaths: [],
        requestId,
        durationMs: Date.now() - operation.startedAt,
      });
    }

    const current = loadProfile(userId);
    const currentHasContent = profileHasContent(current);
    const result = await reconcileProfileFromText(userId, current, text, requestId);
    const saved = !currentHasContent;
    if (saved) saveProfile(userId, result.profile);
    const details = {
      sourceMode,
      model: result.model,
      warningCount: result.warnings.length,
      saved,
      experienceCount: result.profile.experiences.length,
      projectCount: result.profile.projects.length,
      educationCount: result.profile.education.length,
      certificationCount: result.profile.certifications.length,
      skillCount: result.profile.skills.length,
      languageCount: result.profile.languages.length,
    };
    finishOperation(operation, "succeeded", details);
    return c.json({
      profile: result.profile,
      mode: sourceMode,
      saved,
      warnings: result.warnings,
      reviewPaths: result.reviewPaths,
      requestId,
      durationMs: Date.now() - operation.startedAt,
    });
  } catch (error) {
    finishOperation(operation, "failed", {}, error);
    const status = /Import accepts|Not enough source text/.test(message(error)) ? 400 : 502;
    return c.json({ error: message(error), requestId }, status);
  }
});

app.get("/api/templates", async (c) => {
  const userId = requiredSession(c).user.id;
  await ensureDefaultTemplate(userId);
  const rows = db
    .query(
      `SELECT id, name, source_filename, mapping_json, analysis_json, status, created_at, updated_at
       FROM templates WHERE user_id = ? ORDER BY updated_at DESC`,
    )
    .all(userId) as Array<Record<string, unknown>>;
  return c.json(
    rows.map((row) => ({
      ...row,
      mapping: json(String(row.mapping_json), []),
      analysis: json(String(row.analysis_json), {}),
      mapping_json: undefined,
      analysis_json: undefined,
    })),
  );
});

app.post("/api/templates/starter", async (c) => {
  const userId = requiredSession(c).user.id;
  return c.json(await ensureDefaultTemplate(userId), 200);
});

app.post("/api/templates/upload", async (c) => {
  const userId = requiredSession(c).user.id;
  const form = await c.req.formData();
  const file = form.get("file");
  const name = String(form.get("name") ?? "My template").trim();
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".docx")) {
    return c.json({ error: "Upload a DOCX file." }, 400);
  }
  const directory = join(artifactsDir, userId, "templates");
  await mkdir(directory, { recursive: true });
  const sourcePath = join(directory, `${id()}-${safeFilename(file.name)}`);
  await Bun.write(sourcePath, file);
  try {
    return c.json(await saveTemplate(userId, name, sourcePath, file.name, loadProfile(userId)), 201);
  } catch (error) {
    return c.json({ error: message(error) }, 400);
  }
});

app.put("/api/templates/:id/mapping", async (c) => {
  const userId = requiredSession(c).user.id;
  const templateId = c.req.param("id");
  const body = await c.req.json<{ slots?: TemplateSlot[]; activate?: boolean }>();
  if (!Array.isArray(body.slots)) return c.json({ error: "slots must be an array." }, 400);
  const template = ownedTemplate(templateId, userId);
  try {
    const slots = resolveMappingConflicts(body.slots);
    validateSlots(slots);
    const testPath = join(artifactsDir, userId, "templates", `${templateId}-validation.docx`);
    await renderMappedTemplate(template.source_path, testPath, slots, loadProfile(userId));
    db.query(
      "UPDATE templates SET mapping_json = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    ).run(JSON.stringify(slots), body.activate ? "active" : "draft", now(), templateId, userId);
    return c.json({ ok: true, repairedMappings: body.slots.length - slots.length });
  } catch (error) {
    return c.json({ error: message(error) }, 400);
  }
});

app.get("/api/templates/:id/download", (c) => {
  const userId = requiredSession(c).user.id;
  const template = ownedTemplate(c.req.param("id"), userId);
  return download(template.source_path, template.source_filename);
});

app.get("/api/documents", (c) => {
  const userId = requiredSession(c).user.id;
  const rows = db
    .query(
      `SELECT id, kind, title, company_key, application_id, content_md, created_at, updated_at
       FROM documents WHERE user_id = ? ORDER BY updated_at DESC`,
    )
    .all(userId);
  return c.json(rows);
});

app.post("/api/documents", async (c) => {
  const userId = requiredSession(c).user.id;
  const body = await c.req.json<{ kind?: string; title?: string; company?: string; content?: string }>();
  if (!body.title?.trim()) return c.json({ error: "Title is required." }, 400);
  const documentId = id();
  const timestamp = now();
  db.query(
    `INSERT INTO documents
      (id, user_id, kind, title, company_key, content_md, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    documentId,
    userId,
    body.kind ?? "note",
    body.title.trim(),
    body.company ? normalizeCompany(body.company) : null,
    body.content ?? "",
    timestamp,
    timestamp,
  );
  return c.json({ id: documentId }, 201);
});

app.put("/api/documents/:id", async (c) => {
  const userId = requiredSession(c).user.id;
  const body = await c.req.json<{ title?: string; content?: string }>();
  const result = db
    .query(
      `UPDATE documents SET title = COALESCE(?, title), content_md = COALESCE(?, content_md), updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(body.title ?? null, body.content ?? null, now(), c.req.param("id"), userId);
  return result.changes ? c.json({ ok: true }) : c.json({ error: "Document not found." }, 404);
});

app.delete("/api/documents/:id", (c) => {
  const result = db
    .query("DELETE FROM documents WHERE id = ? AND user_id = ?")
    .run(c.req.param("id"), requiredSession(c).user.id);
  return result.changes ? c.json({ ok: true }) : c.json({ error: "Document not found." }, 404);
});

app.get("/api/documents/:id/download", (c) => {
  const userId = requiredSession(c).user.id;
  const row = db
    .query("SELECT title, content_md FROM documents WHERE id = ? AND user_id = ?")
    .get(c.req.param("id"), userId) as { title: string; content_md: string } | null;
  if (!row) return c.json({ error: "Document not found." }, 404);
  return new Response(row.content_md, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFilename(row.title)}.md"`,
    },
  });
});

app.get("/api/applications", (c) => {
  const rows = db
    .query(
      `SELECT id, template_id, company, role, language, status, error, created_at, updated_at
       FROM applications WHERE user_id = ? ORDER BY updated_at DESC`,
    )
    .all(requiredSession(c).user.id);
  return c.json(rows);
});

app.post("/api/applications", async (c) => {
  const userId = requiredSession(c).user.id;
  const body = await c.req.json<{
    company?: string;
    role?: string;
    jobText?: string;
    templateId?: string;
    language?: string;
    reuseCompanyContext?: boolean;
  }>();
  if (!body.company?.trim() || !body.role?.trim() || !body.jobText?.trim()) {
    return c.json({ error: "Company, role, and job post are required." }, 400);
  }
  if (!profileHasContent(loadProfile(userId))) {
    return c.json({ error: "Complete your profile before creating an application." }, 400);
  }
  if (body.jobText.length > 30_000) return c.json({ error: "Job post exceeds 30,000 characters." }, 400);
  if (!body.templateId) return c.json({ error: "Select an active template." }, 400);
  const chosenTemplate = ownedTemplate(body.templateId, userId);
  if (chosenTemplate.status !== "active") return c.json({ error: "Selected template is not active." }, 400);
  const applicationId = id();
  const timestamp = now();
  db.query(
    `INSERT INTO applications
      (id, user_id, template_id, company, company_key, role, job_text, language,
       reuse_company_context, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
  ).run(
    applicationId,
    userId,
    body.templateId ?? null,
    body.company.trim(),
    normalizeCompany(body.company),
    body.role.trim(),
    body.jobText.trim(),
    body.language ?? "auto",
    body.reuseCompanyContext === false ? 0 : 1,
    timestamp,
    timestamp,
  );
  return c.json({ id: applicationId }, 201);
});

app.get("/api/applications/:id", (c) => {
  const userId = requiredSession(c).user.id;
  const application = db
    .query("SELECT * FROM applications WHERE id = ? AND user_id = ?")
    .get(c.req.param("id"), userId) as Record<string, unknown> | null;
  if (!application) return c.json({ error: "Application not found." }, 404);
  const artifacts = db
    .query(
      `SELECT id, kind, filename, preview_text, sha256, created_at
       FROM artifacts WHERE application_id = ? AND user_id = ? ORDER BY created_at DESC`,
    )
    .all(c.req.param("id"), userId);
  let proposal: TailoringProposal | null = application.proposal_json
    ? json<TailoringProposal>(String(application.proposal_json), { edits: [], warnings: [] })
    : null;
  if (proposal && application.template_id) {
    const template = db
      .query("SELECT mapping_json FROM templates WHERE id = ? AND user_id = ?")
      .get(String(application.template_id), userId) as { mapping_json: string } | null;
    if (template) {
      const allowed = new Set(
        json<TemplateSlot[]>(template.mapping_json, [])
          .filter((slot) => slot.protection === "tailorable")
          .map((slot) => slot.fieldPath),
      );
      try {
        proposal = validateTailoringProposal(proposal, loadProfile(userId), allowed);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Stored proposal is stale.";
        logEvent("warn", "application.proposal.stale", {
          applicationId: application.id,
          userId,
          message,
        });
        proposal = {
          ...proposal,
          warnings: [
            ...proposal.warnings,
            "Stored proposal no longer matches the current profile; regenerate it before using it.",
          ],
        };
      }
    }
  }
  return c.json({
    ...application,
    research: json(String(application.research_json ?? ""), null),
    fit: json(String(application.fit_json ?? ""), null),
    proposal,
    research_json: undefined,
    fit_json: undefined,
    proposal_json: undefined,
    tailored_profile_json: undefined,
    artifacts,
  });
});

app.put("/api/applications/:id/review", async (c) => {
  const userId = requiredSession(c).user.id;
  const body = await c.req.json<{ fit?: unknown; proposal?: TailoringProposal }>();
  const application = ownedApplication(c.req.param("id"), userId);
  if (body.fit !== undefined && application.status === "research_ready") {
    db.query("UPDATE applications SET fit_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(body.fit),
      now(),
      application.id,
    );
  }
  if (body.proposal !== undefined && application.status === "proposal_ready") {
    const row = db
      .query(
        `SELECT applications.template_id, templates.mapping_json
         FROM applications JOIN templates ON templates.id = applications.template_id
         WHERE applications.id = ? AND applications.user_id = ?`,
      )
      .get(application.id, userId) as { mapping_json: string } | null;
    if (!row) return c.json({ error: "Application template not found." }, 400);
    const allowed = new Set(
      json<TemplateSlot[]>(row.mapping_json, [])
        .filter((slot) => slot.protection === "tailorable")
        .map((slot) => slot.fieldPath),
    );
    const proposal = validateTailoringProposal(body.proposal, loadProfile(userId), allowed);
    db.query("UPDATE applications SET proposal_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(proposal),
      now(),
      application.id,
    );
  }
  return c.json({ ok: true });
});

app.put("/api/applications/:id/comment", async (c) => {
  const userId = requiredSession(c).user.id;
  const application = db
    .query("SELECT id, status FROM applications WHERE id = ? AND user_id = ?")
    .get(c.req.param("id"), userId) as { id: string; status: string } | null;
  if (!application) return c.json({ error: "Application not found." }, 404);
  if (!["research_ready", "research_approved", "proposal_ready", "proposal_approved", "complete"].includes(application.status)) {
    return c.json({ error: "Additional instructions can be edited after fit research is ready." }, 409);
  }
  const body = await c.req.json<{ comment?: unknown }>();
  const comment = typeof body.comment === "string" ? body.comment.trim() : "";
  if (comment.length > 5000) return c.json({ error: "Additional instructions are limited to 5,000 characters." }, 400);
  db.query("UPDATE applications SET user_comment = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(
    comment,
    now(),
    application.id,
    userId,
  );
  return c.json({ ok: true, savedAt: now(), comment });
});

app.post("/api/applications/:id/actions/:action", (c) => {
  const userId = requiredSession(c).user.id;
  const application = ownedApplication(c.req.param("id"), userId);
  const action = c.req.param("action");
  const transitions: Record<string, [string, string]> = {
    research: ["draft", "research_queued"],
    approve_research: ["research_ready", "research_approved"],
    tailor: ["research_approved", "tailor_queued"],
    approve_proposal: ["proposal_ready", "proposal_approved"],
    generate: ["proposal_approved", "generate_queued"],
    regenerate: ["complete", "tailor_queued"],
    retry_research: ["failed", "research_queued"],
  };
  const transition = transitions[action];
  if (!transition || application.status !== transition[0]) {
    return c.json({ error: `Action ${action} is invalid from ${application.status}.` }, 409);
  }
  try {
    if (action === "research" || action === "retry_research") {
      consumeWorkflowCredit(userId, application.id);
    }
    db.query("UPDATE applications SET status = ?, error = NULL, updated_at = ? WHERE id = ? AND user_id = ?").run(
      transition[1],
      now(),
      application.id,
      userId,
    );
    if (action === "regenerate") {
      db.query("UPDATE applications SET proposal_json = NULL, tailored_profile_json = NULL WHERE id = ? AND user_id = ?").run(
        application.id,
        userId,
      );
    }
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: message(error) }, 429);
  }
});

app.get("/api/artifacts/:id/download", (c) => {
  const userId = requiredSession(c).user.id;
  const artifact = db
    .query("SELECT filename, path FROM artifacts WHERE id = ? AND user_id = ?")
    .get(c.req.param("id"), userId) as { filename: string; path: string } | null;
  if (!artifact) return c.json({ error: "Artifact not found." }, 404);
  return download(artifact.path, artifact.filename);
});

app.get("/api/artifacts", (c) => {
  const userId = requiredSession(c).user.id;
  const rows = db
    .query(
      `SELECT artifacts.id, artifacts.application_id, artifacts.kind, artifacts.filename,
        artifacts.preview_text, artifacts.sha256, artifacts.created_at,
        applications.company, applications.role
       FROM artifacts
       JOIN applications ON applications.id = artifacts.application_id
       WHERE artifacts.user_id = ?
       ORDER BY artifacts.created_at DESC`,
    )
    .all(userId);
  return c.json(rows);
});

app.get("/api/admin/invites", (c) => {
  requireAdmin(c);
  return c.json(
    db
      .query("SELECT id, email, expires_at, claimed_at, created_at FROM invites ORDER BY created_at DESC")
      .all(),
  );
});

app.post("/api/admin/invites", async (c) => {
  const session = requireAdmin(c);
  const body = await c.req.json<{ email?: string }>();
  if (!body.email?.includes("@")) return c.json({ error: "Valid email required." }, 400);
  const token = `${id()}${id()}`.replaceAll("-", "");
  const inviteId = id();
  db.query(
    `INSERT INTO invites (id, email, token_hash, created_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    inviteId,
    body.email.trim().toLowerCase(),
    hashToken(token),
    session.user.id,
    new Date(Date.now() + 7 * 86_400_000).toISOString(),
    now(),
  );
  const origin = process.env.APP_ORIGIN?.split(",")[0] ?? "http://localhost:5173";
  return c.json({ id: inviteId, url: `${origin}/?invite=${token}&email=${encodeURIComponent(body.email)}` }, 201);
});

app.get("/api/admin/users", async (c) => {
  requireAdmin(c);
  const users = await auth.api.listUsers({ query: { limit: 100 }, headers: c.req.raw.headers });
  const quotas = db.query("SELECT user_id, monthly_quota FROM user_settings").all() as Array<{
    user_id: string;
    monthly_quota: number;
  }>;
  return c.json({
    users: users.users.map((user) => ({
      ...user,
      monthlyQuota: quotas.find((quota) => quota.user_id === user.id)?.monthly_quota ?? 25,
      usage: monthlyUsage(user.id),
    })),
  });
});

app.get("/api/admin/operations", (c) => {
  requireAdmin(c);
  const rows = db
    .query(
      `SELECT operation_logs.id, operation_logs.request_id, operation_logs.user_id,
        operation_logs.operation, operation_logs.status, operation_logs.input_name,
        operation_logs.input_bytes, operation_logs.input_characters,
        operation_logs.details_json, operation_logs.error, operation_logs.started_at,
        operation_logs.completed_at, operation_logs.duration_ms, user.email
       FROM operation_logs
       LEFT JOIN user ON user.id = operation_logs.user_id
       ORDER BY operation_logs.started_at DESC
       LIMIT 100`,
    )
    .all() as Array<Record<string, unknown>>;
  return c.json(
    rows.map((row) => ({
      ...row,
      details: json(String(row.details_json), {}),
      details_json: undefined,
    })),
  );
});

app.put("/api/admin/users/:id/quota", async (c) => {
  requireAdmin(c);
  const body = await c.req.json<{ quota?: number }>();
  if (!Number.isInteger(body.quota) || (body.quota ?? 0) < 0 || (body.quota ?? 0) > 500) {
    return c.json({ error: "Quota must be an integer from 0 to 500." }, 400);
  }
  const quota = body.quota as number;
  const timestamp = now();
  db.query(
    `INSERT INTO user_settings (user_id, monthly_quota, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET monthly_quota = excluded.monthly_quota, updated_at = excluded.updated_at`,
  ).run(c.req.param("id"), quota, timestamp, timestamp);
  return c.json({ ok: true });
});

app.post("/api/admin/users/:id/password", async (c) => {
  requireAdmin(c);
  const body = await c.req.json<{ password?: string }>();
  if (!body.password || body.password.length < 10) {
    return c.json({ error: "Temporary password must contain at least 10 characters." }, 400);
  }
  await auth.api.setUserPassword({
    body: { userId: c.req.param("id"), newPassword: body.password },
    headers: c.req.raw.headers,
  });
  await auth.api.revokeUserSessions({
    body: { userId: c.req.param("id") },
    headers: c.req.raw.headers,
  });
  return c.json({ ok: true });
});

const webRoot = "dist/web";
app.use("/*", serveStatic({ root: webRoot }));
app.get("*", serveStatic({ root: webRoot, path: "index.html" }));

const port = Number(process.env.PORT ?? "3000");
const server = Bun.serve({ port, fetch: app.fetch });
startWorker();

const shutdown = (): void => {
  stopWorker();
  db.close();
  server.stop();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`Tailored CV listening on http://localhost:${port}`);

function requiredSession(c: { get(name: "session"): AuthSession | null }): AuthSession {
  const session = c.get("session");
  if (!session) throw new Error("Unauthorized");
  return session;
}

function requireAdmin(c: { get(name: "session"): AuthSession | null }): AuthSession {
  const session = requiredSession(c);
  if ((session.user as { role?: string }).role !== "admin") throw new Error("Forbidden");
  return session;
}

function loadProfile(userId: string): WebProfile {
  const row = db.query("SELECT content_json FROM profiles WHERE user_id = ?").get(userId) as
    | { content_json: string }
    | null;
  return validateProfile(
    row
      ? json<WebProfile>(row.content_json, structuredClone(EMPTY_PROFILE))
      : structuredClone(EMPTY_PROFILE),
  );
}

function saveProfile(userId: string, profile: WebProfile): void {
  const timestamp = now();
  db.query(
    `INSERT INTO profiles (user_id, content_json, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET content_json = excluded.content_json, updated_at = excluded.updated_at`,
  ).run(userId, JSON.stringify(validateProfile(profile)), timestamp, timestamp);
}

export function profileHasContent(profile: WebProfile): boolean {
  return Boolean(
    profile.personal.name.trim() ||
      profile.summary.trim() ||
      profile.background.trim() ||
      profile.experiences.length ||
      profile.projects.length ||
      profile.education.length ||
      profile.certifications.length ||
      profile.skills.length ||
      profile.languages.length ||
      profile.rules.length,
  );
}

async function saveTemplate(
  userId: string,
  name: string,
  sourcePath: string,
  sourceFilename: string,
  profile: WebProfile,
  status = "draft",
): Promise<Record<string, unknown>> {
  const analysis = await analyzeTemplate(sourcePath, profile);
  if (analysis.unsupported.length) throw new Error(analysis.unsupported.join("; "));
  const templateId = id();
  const timestamp = now();
  db.query(
    `INSERT INTO templates
      (id, user_id, name, source_filename, source_path, mapping_json, analysis_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    templateId,
    userId,
    name,
    safeFilename(sourceFilename, "template.docx"),
    sourcePath,
    JSON.stringify(analysis.suggestedSlots),
    JSON.stringify(analysis),
    status,
    timestamp,
    timestamp,
  );
  return { id: templateId, name, analysis, mapping: analysis.suggestedSlots, status };
}

async function ensureDefaultTemplate(userId: string): Promise<Record<string, unknown>> {
  const existing = db
    .query(
      `SELECT id, name, source_filename, source_path, mapping_json, analysis_json, status
       FROM templates
       WHERE user_id = ? AND source_filename = 'resume-template.docx'
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(userId) as Record<string, unknown> | null;
  if (existing) {
    let mapping = json<TemplateSlot[]>(String(existing.mapping_json), []);
    let analysis: unknown = json(String(existing.analysis_json), {});
    if (existing.status !== "active" || mapping.length === 0) {
      const rebuilt = await analyzeTemplate(String(existing.source_path), await starterTemplateProfile());
      mapping = rebuilt.suggestedSlots;
      analysis = rebuilt;
      db.query(
        "UPDATE templates SET mapping_json = ?, analysis_json = ?, status = 'active', updated_at = ? WHERE id = ?",
      ).run(JSON.stringify(mapping), JSON.stringify(analysis), now(), String(existing.id));
    }
    return {
      ...existing,
      status: "active",
      mapping,
      analysis,
      source_path: undefined,
      mapping_json: undefined,
      analysis_json: undefined,
    };
  }

  const sourcePath = await createStarterTemplate(userId);
  return saveTemplate(
    userId,
    "Default template",
    sourcePath,
    "resume-template.docx",
    await starterTemplateProfile(),
    "active",
  );
}

function ownedTemplate(templateId: string, userId: string): {
  id: string;
  source_path: string;
  source_filename: string;
  status: string;
} {
  const template = db
    .query("SELECT id, source_path, source_filename, status FROM templates WHERE id = ? AND user_id = ?")
    .get(templateId, userId) as {
    id: string;
    source_path: string;
    source_filename: string;
    status: string;
  } | null;
  if (!template) throw new Error("Template not found.");
  return template;
}

function ownedApplication(applicationId: string, userId: string): {
  id: string;
  status: string;
} {
  const application = db
    .query("SELECT id, status FROM applications WHERE id = ? AND user_id = ?")
    .get(applicationId, userId) as { id: string; status: string } | null;
  if (!application) throw new Error("Application not found.");
  return application;
}

function validateSlots(slots: TemplateSlot[]): void {
  const ids = new Set<string>();
  for (const slot of slots) {
    if (!slot.id || ids.has(slot.id)) throw new Error("Every mapping needs a unique id.");
    ids.add(slot.id);
    if (!slot.fieldPath || !slot.documentPart || !Number.isInteger(slot.paragraphIndex) || !slot.matchText) {
      throw new Error("Invalid template mapping.");
    }
    if (!["whole-paragraph", "inline-text"].includes(slot.mode)) throw new Error("Invalid mapping mode.");
    if (!["protected", "tailorable"].includes(slot.protection)) throw new Error("Invalid mapping protection.");
    const expectedProtection = isProtectedPath(slot.fieldPath) ? "protected" : "tailorable";
    if (slot.protection !== expectedProtection) {
      throw new Error(`Incorrect protection for ${slot.fieldPath}.`);
    }
  }
}

function monthlyUsage(userId: string): { used: number; quota: number; cost: number } {
  const month = new Date().toISOString().slice(0, 7);
  const row = db
    .query(
      `SELECT
         SUM(CASE WHEN operation = 'workflow_credit' THEN 1 ELSE 0 END) AS used,
         COALESCE(SUM(cost), 0) AS cost
       FROM usage_events WHERE user_id = ? AND substr(created_at, 1, 7) = ?`,
    )
    .get(userId, month) as { used: number | null; cost: number };
  const quota =
    (
      db.query("SELECT monthly_quota FROM user_settings WHERE user_id = ?").get(userId) as
        | { monthly_quota: number }
        | null
    )?.monthly_quota ?? 25;
  return { used: row.used ?? 0, quota, cost: row.cost };
}

function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function download(path: string, filename: string): Response {
  const file = Bun.file(path);
  return new Response(file, {
    headers: artifactHeaders(filename, file.size),
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
