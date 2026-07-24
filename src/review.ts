import type { Proposal, Resume } from "./types";

export function buildReview(base: Resume, tailored: Resume, proposal: Proposal, jobPath: string): string {
  const sections: string[] = [
    "# CV personalization review",
    "",
    `Job source: \`${jobPath}\``,
    "",
    "## Protected facts",
    "",
    "Company names, dates, locations, education, certifications, contact details, and existing metrics were not editable by the proposal. Responsibilities are factual; startup titles are flexible positioning labels, and every title change is shown below.",
    "",
  ];

  addChange(sections, "Header", base.header.line, tailored.header.line);
  addChange(sections, "Summary", base.summary, tailored.summary);
  if (base.experienceOrder.join("|") !== tailored.experienceOrder.join("|")) {
    sections.push(
      "## Experience order",
      "",
      `- Before: ${base.experienceOrder.join(" → ")}`,
      `- After: ${tailored.experienceOrder.join(" → ")}`,
      "",
    );
  }

  for (const key of tailored.experienceOrder) {
    const before = base.experiences[key];
    const after = tailored.experiences[key];
    if (
      before.context === after.context &&
      before.role === after.role &&
      before.bullets.join("|") === after.bullets.join("|")
    ) continue;
    sections.push(`## ${after.company}`, "");
    if (before.context !== after.context) {
      sections.push(`- Context before: ${before.context}`, `- Context after: ${after.context}`, "");
    }
    if (before.role !== after.role) {
      sections.push(`- Title before: ${before.role}`, `- Title after: ${after.role}`, "");
    }
    sections.push("Before:", "", ...before.bullets.map((item) => `- ${item}`), "", "After:", "", ...after.bullets.map((item) => `- ${item}`), "");
  }

  if (base.projectOrder.join("|") !== tailored.projectOrder.join("|")) {
    sections.push(
      "## Project selection",
      "",
      `- Before: ${base.projectOrder.join(" → ")}`,
      `- After: ${tailored.projectOrder.join(" → ")}`,
      "",
    );
  }
  for (const key of tailored.projectOrder) {
    const before = base.projects[key];
    const after = tailored.projects[key];
    if (before.description === after.description && before.bullet === after.bullet) continue;
    sections.push(
      `## Project: ${after.name}`,
      "",
      `- Before: ${before.description} — ${before.bullet}`,
      `- After: ${after.description} — ${after.bullet}`,
      "",
    );
  }

  for (const key of ["languages", "technical", "productLabel", "product", "finance"] as const) {
    addChange(sections, `Skill: ${key}`, base.skills[key], tailored.skills[key]);
  }

  sections.push("## Warnings requiring confirmation", "");
  if (proposal.warnings?.length) sections.push(...proposal.warnings.map((warning) => `- ${warning}`));
  else sections.push("- None supplied.");
  sections.push("");
  return sections.join("\n");
}

function addChange(sections: string[], title: string, before: string, after: string): void {
  if (before === after) return;
  sections.push(`## ${title}`, "", `- Before: ${before}`, `- After: ${after}`, "");
}
