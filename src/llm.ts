import type { Proposal, Resume } from "./types";

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export async function requestProposal(input: {
  resume: Resume;
  background: string;
  guidelines: string;
  job: string;
}): Promise<Proposal> {
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  const baseUrl = (process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  if (!apiKey || !model) {
    throw new Error("Set LLM_API_KEY and LLM_MODEL, or pass --proposal <fixture.json>.");
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You personalize a French CV. Return JSON only. Be assertive. Responsibilities are factual; startup titles are flexible positioning labels. Actively choose the evidenced product, GTM, sales, operations, or software lens most relevant to the job. The base title is a default, not a ceiling, but use only natural, established market titles that stand on their own. Never mechanically combine words from the job post with the existing title to manufacture a hybrid title; never output awkward keyword titles such as 'Chef de Projet Produit'. Prefer the original title when no clearly better standard title exists, and put target keywords in the bullets instead. Skill categories are dynamic: regroup, rename, reorder, or omit them according to the target role instead of forcing fixed categories such as Finance, Techniques, or Gestion de Produit. Infer concise capability labels from demonstrated work and add relevant ATS keywords when they accurately summarize that evidence, even if the exact phrase is absent. Distinguish hands-on expertise from project exposure or familiarity with a technology environment. Never add unsupported technologies, methodologies, domains, certifications, seniority, authority, metrics, or responsibilities. Keep the final CV within two readable pages. Treat language selection as positioning: do not foreground non-native status or native-language labels. Never invent dates, ownership, credentials, or language levels.",
        },
        {
          role: "user",
          content: buildPrompt(input),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
  const payload = (await response.json()) as ChatResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned no content.");
  return JSON.parse(content) as Proposal;
}

function buildPrompt(input: {
  resume: Resume;
  background: string;
  guidelines: string;
  job: string;
}): string {
  return `Personalize this resume for the job.

Allowed JSON fields only:
{
  "header": {"line": "string"},
  "summary": "string",
  "experienceOrder": ["existing experience keys"],
  "experiences": {"existing key": {"context": "string", "role": "string", "bullets": ["strings"]}},
  "projectOrder": ["existing project keys"],
  "projects": {"existing key": {"description": "string", "bullet": "string"}},
  "skills": {"languages": "string", "technical": "string", "productLabel": "string", "product": "string", "finance": "string"},
  "warnings": ["facts requiring confirmation"]
}

Do not return company, period, location, education, certification, contact, or metric edits.
Role edits are encouraged when another functional lens better represents substantial evidenced responsibilities for this target. The base title is not protected or authoritative, but any replacement must be a natural, established market title that is understandable without the job post. Do not mechanically combine target keywords with the existing title or invent hybrid titles such as "Chef de Projet Produit". Prefer the original title when no clearly better standard title exists; put target keywords in bullets instead. Skill categories are dynamic: regroup, rename, reorder, or omit them according to the target role instead of forcing fixed categories. Infer concise capability labels from demonstrated work and add relevant ATS keywords when they accurately summarize that evidence, even if the exact phrase is absent. Distinguish hands-on expertise from project exposure or familiarity with a technology environment. Never add unsupported technologies, methodologies, domains, certifications, seniority, formal authority, people management, ownership, a separate job, or the target title merely as a keyword. The title and bullets must tell the same defensible story.
Default to reverse chronology. Reorder only overlapping or equally recent roles when relevance justifies it.
Do not add User Stories, Backlog ownership, or Agile ritual ownership unless directly evidenced.
Use concise French. Final CV must not exceed two pages; two full readable pages are acceptable.

GUIDELINES:
${input.guidelines}

BACKGROUND:
${input.background}

BASE RESUME:
${JSON.stringify(input.resume)}

JOB:
${input.job}`;
}
