import { parse, stringify } from "yaml";
import type { Proposal, Resume } from "./types";

export async function loadResume(path: string): Promise<Resume> {
  return validateResume(parse(await Bun.file(path).text()));
}

export async function writeResume(path: string, resume: Resume): Promise<void> {
  await Bun.write(path, stringify(resume, { lineWidth: 0 }));
}

export function validateResume(value: unknown): Resume {
  if (!value || typeof value !== "object") throw new Error("Resume YAML must contain an object.");
  const resume = value as Resume;
  if (!resume.header?.line || !resume.summary) throw new Error("Resume requires header.line and summary.");
  if (!Array.isArray(resume.experienceOrder) || !resume.experiences) {
    throw new Error("Resume requires experiences and experienceOrder.");
  }
  if (!Array.isArray(resume.projectOrder) || !resume.projects) {
    throw new Error("Resume requires projects and projectOrder.");
  }
  for (const key of resume.experienceOrder) {
    const item = resume.experiences[key];
    if (!item || !item.company || !item.role || !item.period || !Array.isArray(item.bullets)) {
      throw new Error(`Invalid experience: ${key}`);
    }
  }
  for (const key of resume.projectOrder) {
    if (!resume.projects[key]?.name || !resume.projects[key]?.bullet) {
      throw new Error(`Invalid project in projectOrder: ${key}`);
    }
  }
  return resume;
}

const TOP_LEVEL_KEYS = new Set([
  "header",
  "summary",
  "experienceOrder",
  "experiences",
  "projectOrder",
  "projects",
  "skills",
  "warnings",
]);

export function validateProposal(value: unknown, base: Resume): Proposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Proposal must be a JSON object.");
  }
  const proposal = value as Record<string, unknown>;
  for (const key of Object.keys(proposal)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new Error(`Proposal cannot change protected field: ${key}`);
  }
  if (proposal.header) assertKeys(proposal.header, ["line"], "header");
  if (proposal.skills) {
    assertKeys(
      proposal.skills,
      ["languages", "technical", "productLabel", "product", "finance"],
      "skills",
    );
  }

  if (proposal.experiences) {
    if (typeof proposal.experiences !== "object" || Array.isArray(proposal.experiences)) {
      throw new Error("Proposal experiences must be an object.");
    }
    for (const [key, edit] of Object.entries(proposal.experiences)) {
      if (!base.experiences[key]) throw new Error(`Proposal references unknown experience: ${key}`);
      assertKeys(edit, ["context", "role", "bullets"], `experiences.${key}`);
      const role = (edit as { role?: unknown }).role;
      if (role !== undefined && (typeof role !== "string" || !role.trim())) {
        throw new Error(`experiences.${key}.role must be a non-empty string.`);
      }
    }
  }
  if (proposal.projects) {
    if (typeof proposal.projects !== "object" || Array.isArray(proposal.projects)) {
      throw new Error("Proposal projects must be an object.");
    }
    for (const [key, edit] of Object.entries(proposal.projects)) {
      if (!base.projects[key]) throw new Error(`Proposal references unknown project: ${key}`);
      assertKeys(edit, ["description", "bullet"], `projects.${key}`);
    }
  }
  if (proposal.experienceOrder) validateOrder(proposal.experienceOrder, base.experiences, "experience");
  if (proposal.projectOrder) validateOrder(proposal.projectOrder, base.projects, "project");
  return proposal as Proposal;
}

function assertKeys(value: unknown, allowed: string[], path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Proposal cannot change protected field: ${path}.${key}`);
  }
}

function validateOrder(order: unknown, items: Record<string, unknown>, kind: string): void {
  if (!Array.isArray(order) || order.some((key) => typeof key !== "string" || !items[key])) {
    throw new Error(`Invalid ${kind} order.`);
  }
  if (new Set(order).size !== order.length) throw new Error(`Duplicate key in ${kind} order.`);
}

export function applyProposal(base: Resume, proposal: Proposal): Resume {
  const result = structuredClone(base);
  if (proposal.header?.line) result.header.line = proposal.header.line;
  if (proposal.summary) result.summary = proposal.summary;
  if (proposal.experienceOrder) result.experienceOrder = [...proposal.experienceOrder];
  if (proposal.projectOrder) result.projectOrder = [...proposal.projectOrder];

  for (const [key, edit] of Object.entries(proposal.experiences ?? {})) {
    if (edit.context !== undefined) result.experiences[key].context = edit.context;
    if (edit.role !== undefined) result.experiences[key].role = edit.role;
    if (edit.bullets !== undefined) result.experiences[key].bullets = [...edit.bullets];
  }
  for (const [key, edit] of Object.entries(proposal.projects ?? {})) {
    if (edit.description !== undefined) result.projects[key].description = edit.description;
    if (edit.bullet !== undefined) result.projects[key].bullet = edit.bullet;
  }
  Object.assign(result.skills, proposal.skills ?? {});
  return validateResume(result);
}
