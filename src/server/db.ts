import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const dataDir = resolve(process.env.DATA_DIR ?? "data/runtime");
export const databasePath = join(dataDir, "job-search.sqlite");
export const artifactsDir = join(dataDir, "users");

await mkdir(dirname(databasePath), { recursive: true });
await mkdir(artifactsDir, { recursive: true });

export const db = new Database(databasePath, { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

export function migrateApplicationSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      claimed_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      user_id TEXT PRIMARY KEY,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      source_filename TEXT NOT NULL,
      source_path TEXT NOT NULL,
      mapping_json TEXT NOT NULL DEFAULT '[]',
      analysis_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS templates_user_idx ON templates(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      company_key TEXT,
      application_id TEXT,
      content_md TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS documents_user_idx ON documents(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS documents_company_idx ON documents(user_id, company_key, kind);

    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      template_id TEXT,
      company TEXT NOT NULL,
      company_key TEXT NOT NULL,
      role TEXT NOT NULL,
      job_text TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'auto',
      reuse_company_context INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      research_json TEXT,
      fit_json TEXT,
      proposal_json TEXT,
      tailored_profile_json TEXT,
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS applications_user_idx ON applications(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS applications_queue_idx ON applications(status, updated_at);

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      application_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      filename TEXT NOT NULL,
      path TEXT NOT NULL,
      preview_text TEXT NOT NULL DEFAULT '',
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS artifacts_application_idx ON artifacts(user_id, application_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      application_id TEXT,
      operation TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      web_search_requests INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_user_month_idx ON usage_events(user_id, created_at);

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      monthly_quota INTEGER NOT NULL DEFAULT 25,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function now(): string {
  return new Date().toISOString();
}

export function id(): string {
  return crypto.randomUUID();
}

export function normalizeCompany(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
