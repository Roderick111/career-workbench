import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import PizZip from "pizzip";
import type { WebProfile } from "../src/web-types";
import { migrateApplicationSchema } from "../src/server/db";
import { beginOperation, finishOperation } from "../src/server/observability";
import { openRouterRouting } from "../src/server/openrouter";
import {
  analyzeTemplate,
  createStarterTemplate,
  extractDocxText,
  renderMappedTemplate,
  starterTemplateProfile,
  resolveMappingConflicts,
  sha256,
} from "../src/server/template";
import {
  buildProfileReconciliationPrompt,
  buildCompanyResearchPrompt,
  validateCompanyResearch,
  validateProfile,
  validateReconciledProfile,
  validateTailoringProposal,
} from "../src/server/workflow";
import { artifactHeaders } from "../src/server/download";

const profile: WebProfile = {
  personal: {
    name: "Ada Example",
    headline: "Product Manager",
    email: "ada@example.test",
    phone: "+33 1 23 45",
    location: "Lyon",
    links: "example.test",
  },
  summary: "Builds useful B2B products from complex information.",
  background: "Verified background.",
  experiences: [
    {
      id: "example",
      company: "Example SAS",
      context: "B2B software",
      location: "Lyon",
      role: "Product Manager",
      period: "2024 - 2026",
      bullets: ["Shipped a product workflow.", "Coordinated technical delivery."],
    },
  ],
  projects: [],
  education: ["MSc Example University"],
  certifications: [],
  skills: ["Product discovery", "SQL"],
  languages: ["English"],
  rules: [],
};

migrateApplicationSchema();

describe("web template workflow", () => {
  test("creates starter from the existing CV visual master", async () => {
    const source = await createStarterTemplate("test-user");
    const analysis = await analyzeTemplate(source, profile);
    expect(analysis.unsupported).toEqual([]);
    const sourceText = await extractDocxText(source);
    expect(sourceText).toContain("Daniel MEDINA");
    expect(sourceText).toContain("Brainform");
    expect(sourceText).not.toContain("{summary}");

    const summary = analysis.paragraphs.find((paragraph) =>
      paragraph.text.startsWith("Chef de Produit & cofondateur"),
    );
    expect(summary).toBeDefined();
    const target = join("/private/tmp", `web-cv-${crypto.randomUUID()}.docx`);
    await renderMappedTemplate(
      source,
      target,
      [
        {
          id: crypto.randomUUID(),
          fieldPath: "summary",
          documentPart: summary!.part,
          paragraphIndex: summary!.index,
          matchText: summary!.text,
          mode: "whole-paragraph",
          protection: "tailorable",
        },
      ],
      { ...profile, summary: "Tailored concise summary." },
    );
    const text = await extractDocxText(target);
    expect(text).toContain("Tailored concise summary.");
    expect(text).toContain("Daniel MEDINA");
    expect(await sha256(target)).not.toBe(await sha256(source));
  });

  test("builds complete mappings before a user has a profile", async () => {
    const source = await createStarterTemplate("empty-profile-user");
    const analysis = await analyzeTemplate(source, await starterTemplateProfile());
    expect(analysis.suggestedSlots.length).toBeGreaterThan(50);
    expect(analysis.suggestedSlots.some((slot) => slot.fieldPath === "personal.name")).toBe(true);
    expect(analysis.suggestedSlots.some((slot) => slot.fieldPath === "summary")).toBe(true);
    expect(analysis.suggestedSlots.some((slot) => slot.fieldPath === "experiences.0.company")).toBe(true);
  });

  test("drops nested inline mappings when whole paragraph is mapped", () => {
    const whole = {
      id: crypto.randomUUID(),
      fieldPath: "experiences.0.bullets.0",
      documentPart: "word/document.xml",
      paragraphIndex: 11,
      matchText: "Built a SQL workflow.",
      mode: "whole-paragraph" as const,
      protection: "tailorable" as const,
    };
    const inline = {
      id: crypto.randomUUID(),
      fieldPath: "skills.0",
      documentPart: "word/document.xml",
      paragraphIndex: 11,
      matchText: "SQL",
      mode: "inline-text" as const,
      protection: "tailorable" as const,
    };
    expect(resolveMappingConflicts([whole, inline])).toEqual([whole]);
  });

  test("removes legacy ReloFrance page breaks from mapped web output", async () => {
    const source = "templates/resume-template.docx";
    const starterProfile = await starterTemplateProfile();
    const analysis = await analyzeTemplate(source, starterProfile);
    const summary = analysis.paragraphs.find((paragraph) => paragraph.text === "{summary}");
    expect(summary).toBeDefined();
    const target = join("/private/tmp", `mapped-page-break-${crypto.randomUUID()}.docx`);
    await renderMappedTemplate(
      source,
      target,
      [
        {
          id: crypto.randomUUID(),
          fieldPath: "summary",
          documentPart: summary!.part,
          paragraphIndex: summary!.index,
          matchText: summary!.text,
          mode: "whole-paragraph",
          protection: "tailorable",
        },
      ],
      starterProfile,
    );
    const xml = new PizZip(await Bun.file(target).arrayBuffer())
      .file("word/document.xml")
      ?.asText();
    const paragraph = xml
      ?.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)
      ?.find((item) => item.includes("ReloFrance"));
    expect(paragraph).not.toContain("<w:pageBreakBefore");
  });
});

describe("profile reconciliation guardrails", () => {
  test("strips extraction prompt leakage", () => {
    const incomplete = structuredClone(profile);
    incomplete.rules = ["Never infer dates, employers, metrics, credentials, authority, or language levels."];
    const normalized = validateProfile(incomplete);
    expect(normalized.rules).toEqual([]);
  });

  test("allows only one active profile reconciliation per user", () => {
    const userId = `test-user-${crypto.randomUUID()}`;
    const first = beginOperation(userId, "profile_reconcile", crypto.randomUUID());
    expect(first).not.toBeNull();
    for (let click = 0; click < 5; click += 1) {
      expect(beginOperation(userId, "profile_reconcile", crypto.randomUUID())).toBeNull();
    }
    finishOperation(first!, "succeeded");
    const next = beginOperation(userId, "profile_reconcile", crypto.randomUUID());
    expect(next).not.toBeNull();
    finishOperation(next!, "succeeded");
  });

  test("accepts one reconciled Sally record with the existing stable id", () => {
    const current = structuredClone(profile);
    current.experiences[0] = {
      ...current.experiences[0]!,
      company: "Sally",
      role: "Responsable Process & SDR",
    };
    const reconciled = structuredClone(current);
    reconciled.experiences[0] = {
      ...reconciled.experiences[0]!,
      company: "Sally",
      context: "AI Sales Representative",
      bullets: [...reconciled.experiences[0]!.bullets, "Handled 2,000 prospects weekly."],
    };
    reconciled.projects = [
      {
        id: "",
        name: "Portfolio",
        context: "Personal project",
        period: "2026",
        bullets: ["Shipped a web application."],
      },
    ];

    const result = validateReconciledProfile(
      { profile: reconciled, warnings: ["Matched Sally – AI Sales Representative to Sally."] },
      current,
    );
    expect(result.profile.experiences).toHaveLength(1);
    expect(result.profile.experiences[0]!.id).toBe("example");
    expect(result.profile.experiences[0]!.company).toBe("Sally");
    expect(result.profile.projects[0]!.id).not.toBe("");
  });

  test("rejects lost existing records and identity changes", () => {
    const reconciled = structuredClone(profile);
    reconciled.personal.email = "different@example.test";
    reconciled.experiences = [];
    expect(() =>
      validateReconciledProfile({ profile: reconciled, warnings: [] }, profile),
    ).toThrow(/identity field|existing experience/i);
  });

  test("warns when dates, titles, or existing bullets change", () => {
    const reconciled = structuredClone(profile);
    reconciled.experiences[0]!.role = "Product Owner";
    reconciled.experiences[0]!.period = "2025 - 2026";
    reconciled.experiences[0]!.bullets = ["Shipped a product workflow."];
    const result = validateReconciledProfile(
      { profile: reconciled, warnings: [] },
      profile,
    );
    expect(result.warnings.join(" ")).toMatch(/role changed/i);
    expect(result.warnings.join(" ")).toMatch(/period changed/i);
    expect(result.warnings.join(" ")).toMatch(/bullet removed/i);
    expect(result.reviewPaths).toEqual(expect.arrayContaining([
      "experiences.example.role",
      "experiences.example.period",
      "experiences.example.bullets",
    ]));
  });

  test("sends current profile and raw source to one reconciliation prompt", () => {
    const prompt = buildProfileReconciliationPrompt(
      profile,
      "### Sally – AI Sales Representative | Business Development Manager",
    );
    expect(prompt).toContain('"company":"Example SAS"');
    expect(prompt).toContain("Sally – AI Sales Representative");
    expect(prompt).toContain("CURRENT CANONICAL PROFILE");
    expect(prompt).toContain("NEW IMPORTED SOURCE");
  });
});

describe("tailoring proposal guardrails", () => {
  test("removes no-op edits and unsupported claim expansion", () => {
    const current = structuredClone(profile);
    current.experiences[0]!.bullets = [
      "Géré les campagnes pour 2 000 prospects par semaine.",
      "Agile/Scrum",
    ];
    const result = validateTailoringProposal(
      {
        warnings: [],
        edits: [
          {
            path: "experiences.0.bullets.1",
            oldText: "Agile/Scrum",
            newText: "Agile/Scrum",
            reason: "Same",
            evidence: "transferable",
          },
          {
            path: "experiences.0.bullets.0",
            oldText: "Géré les campagnes pour 2 000 prospects par semaine.",
            newText:
              "Piloté les campagnes pour 2 000 prospects par semaine, avec KPI et reporting régulier.",
            reason: "Inflated",
            evidence: "transferable",
          },
        ],
      },
      current,
      new Set(["experiences.0.bullets.0", "experiences.0.bullets.1"]),
    );

    expect(result.edits).toEqual([]);
    expect(result.warnings).toContain(
      "Rejected unsupported claim expansion: experiences.0.bullets.0",
    );
  });

  test("keeps concise wording changes supported by same role", () => {
    const current = structuredClone(profile);
    current.experiences[0]!.bullets = ["Géré les campagnes clients."];
    const result = validateTailoringProposal(
      {
        warnings: [],
        edits: [
          {
            path: "experiences.0.bullets.0",
            oldText: "Géré les campagnes clients.",
            newText: "Piloté les campagnes clients.",
            reason: "More direct",
            evidence: "transferable",
          },
        ],
      },
      current,
      new Set(["experiences.0.bullets.0"]),
    );
    expect(result.edits).toHaveLength(1);
  });
});

describe("artifact downloads", () => {
  test("creates valid headers for accented filenames", () => {
    const headers = new Headers(
      artifactHeaders("Défense & Systèmes Complexes - CV.docx", 42),
    );
    expect(headers.get("content-disposition")).toContain(
      "filename*=UTF-8''D%C3%A9fense%20%26%20Syst%C3%A8mes%20Complexes%20-%20CV.docx",
    );
    expect(headers.get("content-length")).toBe("42");
  });
});

describe("company research guardrails", () => {
  test("rejects unresolved tool calls and unrelated citations", () => {
    expect(() =>
      validateCompanyResearch(
        `<function_calls><invoke name="web_search"><parameter name="query">Groupe SII</parameter></invoke></function_calls>`,
        [
          {
            type: "url_citation",
            url_citation: {
              title: "Unrelated current news",
              url: "https://news.example/world",
              content: "Current international news with no company connection.",
            },
          },
        ],
        "Groupe SII",
      ),
    ).toThrow("unresolved web-search tool call");
  });

  test("keeps only cited sources relevant to the company", () => {
    const officialUrl = "https://sii-group.com/fr-FR/secteurs-dactivite";
    const result = validateCompanyResearch(
      `Groupe SII works in aerospace, defense, and complex engineering services. Its official sector page describes work across design, validation, industrial engineering, software, quality, safety, and certification. This makes technical project delivery directly relevant to the advertised role. [Official SII source](${officialUrl})`,
      [
        {
          type: "url_citation",
          url_citation: {
            title: "Secteurs d'activité | Groupe SII",
            url: officialUrl,
            content: "Groupe SII accompagne le secteur aéronautique, spatial et défense.",
          },
        },
        {
          type: "url_citation",
          url_citation: {
            title: "Unrelated current news",
            url: "https://news.example/world",
            content: "Current international news.",
          },
        },
      ],
      "Groupe SII",
    );
    expect(result.sources.map((source) => source.url)).toEqual([officialUrl]);
  });

  test("does not send the full job post into web search", () => {
    const prompt = buildCompanyResearchPrompt("Groupe SII", "Project Manager", "x".repeat(30_000));
    expect(prompt.length).toBeLessThan(5_000);
    expect(prompt).toContain("Groupe SII");
    expect(prompt).toContain("Project Manager");
  });
});

describe("OpenRouter routing", () => {
  test("normalizes model prefixes and applies requested provider order", () => {
    process.env.DEFAULT_MODEL = "openrouter/minimax/minimax-m3";
    process.env.FALLBACK_MODEL = "openrouter/deepseek/deepseek-v4-flash";
    process.env.OPENROUTER_MINIMAX_PROVIDER_ORDER = "Morph,Together";
    process.env.OPENROUTER_DEEPSEEK_PROVIDER_ORDER = "WandB,AtlasCloud,DigitalOcean";
    process.env.OPENROUTER_MINIMAX_ALLOW_FALLBACKS = "false";
    const routing = openRouterRouting();
    expect(routing[0]).toMatchObject({
      model: "minimax/minimax-m3",
      provider: { order: ["Morph", "Together"], allow_fallbacks: false, require_parameters: true },
    });
    expect(routing[1]).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      provider: { order: ["WandB", "AtlasCloud", "DigitalOcean"] },
    });
  });
});
