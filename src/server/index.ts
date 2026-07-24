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
  safeFilename,
} from "./template";
import {
  consumeWorkflowCredit,
  extractProfileFromText,
  startWorker,
  stopWorker,
  validateTailoringProposal,
} from "./workflow";

await migrateAuthSchema();
migrateApplicationSchema();

type Variables = {
  session: AuthSession | null;
};

const app = new Hono<{ Variables: Variables }>();

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
  return c.json(row ? json<WebProfile>(row.content_json, EMPTY_PROFILE) : EMPTY_PROFILE);
});

app.put("/api/profile", async (c) => {
  const userId = requiredSession(c).user.id;
  const profile = (await c.req.json()) as WebProfile;
  if (!profile?.personal || !Array.isArray(profile.experiences)) {
    return c.json({ error: "Invalid profile." }, 400);
  }
  const timestamp = now();
  db.query(
    `INSERT INTO profiles (user_id, content_json, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET content_json = excluded.content_json, updated_at = excluded.updated_at`,
  ).run(userId, JSON.stringify(profile), timestamp, timestamp);
  return c.json({ ok: true });
});

app.post("/api/profile/extract", async (c) => {
  const userId = requiredSession(c).user.id;
  const form = await c.req.formData();
  const file = form.get("file");
  const pasted = String(form.get("text") ?? "");
  let text = pasted;
  if (file instanceof File && file.size) {
    if (!file.name.toLowerCase().endsWith(".docx")) {
      return c.json({ error: "CV import accepts DOCX or pasted text." }, 400);
    }
    const directory = join(artifactsDir, userId, "imports");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${id()}-${safeFilename(file.name)}`);
    await Bun.write(path, file);
    text = await extractDocxText(path);
  }
  if (text.trim().length < 50) return c.json({ error: "Not enough CV text." }, 400);
  try {
    return c.json(await extractProfileFromText(userId, text));
  } catch (error) {
    return c.json({ error: message(error) }, 502);
  }
});

app.get("/api/templates", (c) => {
  const userId = requiredSession(c).user.id;
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
  const profile = loadProfile(userId);
  const sourcePath = await createStarterTemplate(userId, profile);
  return c.json(await saveTemplate(userId, "Private starter", sourcePath, "starter.docx", profile), 201);
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
    validateSlots(body.slots);
    const testPath = join(artifactsDir, userId, "templates", `${templateId}-validation.docx`);
    await renderMappedTemplate(template.source_path, testPath, body.slots, loadProfile(userId));
    db.query(
      "UPDATE templates SET mapping_json = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    ).run(JSON.stringify(body.slots), body.activate ? "active" : "draft", now(), templateId, userId);
    return c.json({ ok: true });
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
  return c.json({
    ...application,
    research: json(String(application.research_json ?? ""), null),
    fit: json(String(application.fit_json ?? ""), null),
    proposal: json(String(application.proposal_json ?? ""), null),
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
  return row ? json<WebProfile>(row.content_json, structuredClone(EMPTY_PROFILE)) : structuredClone(EMPTY_PROFILE);
}

async function saveTemplate(
  userId: string,
  name: string,
  sourcePath: string,
  sourceFilename: string,
  profile: WebProfile,
): Promise<Record<string, unknown>> {
  const analysis = await analyzeTemplate(sourcePath, profile);
  if (analysis.unsupported.length) throw new Error(analysis.unsupported.join("; "));
  const templateId = id();
  const timestamp = now();
  db.query(
    `INSERT INTO templates
      (id, user_id, name, source_filename, source_path, mapping_json, analysis_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
  ).run(
    templateId,
    userId,
    name,
    safeFilename(sourceFilename, "template.docx"),
    sourcePath,
    JSON.stringify(analysis.suggestedSlots),
    JSON.stringify(analysis),
    timestamp,
    timestamp,
  );
  return { id: templateId, name, analysis, mapping: analysis.suggestedSlots, status: "draft" };
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
    headers: {
      "Content-Type": filename.endsWith(".docx")
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeFilename(filename)}"`,
      "Content-Length": String(file.size),
    },
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
