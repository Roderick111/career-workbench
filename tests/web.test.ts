import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { WebProfile } from "../src/web-types";
import { openRouterRouting } from "../src/server/openrouter";
import {
  analyzeTemplate,
  createStarterTemplate,
  extractDocxText,
  renderMappedTemplate,
  sha256,
} from "../src/server/template";

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
  education: ["MSc Example University"],
  skills: ["Product discovery", "SQL"],
  languages: ["English"],
  rules: [],
};

describe("web template workflow", () => {
  test("creates, maps, and renders a private starter DOCX", async () => {
    const source = await createStarterTemplate("test-user", profile);
    const analysis = await analyzeTemplate(source, profile);
    expect(analysis.unsupported).toEqual([]);
    expect(analysis.suggestedSlots.length).toBeGreaterThan(8);
    expect(
      analysis.suggestedSlots.find((slot) => slot.fieldPath === "experiences.0.company")?.protection,
    ).toBe("protected");
    expect(
      analysis.suggestedSlots.find((slot) => slot.fieldPath === "experiences.0.role")?.protection,
    ).toBe("tailorable");

    const tailored = structuredClone(profile);
    tailored.summary = "Tailored concise summary.";
    tailored.experiences[0].role = "Technical Product Manager";
    const target = join("/private/tmp", `web-cv-${crypto.randomUUID()}.docx`);
    await renderMappedTemplate(source, target, analysis.suggestedSlots, tailored);
    const text = await extractDocxText(target);
    expect(text).toContain("Technical Product Manager");
    expect(text).toContain("Tailored concise summary.");
    expect(text).toContain("Example SAS");
    expect(await sha256(target)).not.toBe(await sha256(source));
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
