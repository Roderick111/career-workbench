import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import PizZip from "pizzip";
import { applyProposal, loadResume, validateProposal } from "../src/data";
import {
  buildTemplate,
  extractDocumentText,
  normalizeTemplate,
  renderResume,
} from "../src/ooxml";

const source = "Daniel MEDINA - product manager - Resume Bordeaux FR 2026.docx";
let testDir: string;
let template: string;
let output: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "job-search-resume-"));
  template = join(testDir, "template.docx");
  output = join(testDir, "resume.docx");
  const base = await loadResume("data/resume.base.yaml");
  const proposal = validateProposal(
    JSON.parse(await Bun.file("fixtures/weplace.proposal.json").text()),
    base,
  );
  await buildTemplate(source, template);
  await renderResume(template, output, applyProposal(base, proposal));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("resume rendering", () => {
  test("normalizes visual master chronology and experience alignment", async () => {
    const base = await loadResume("data/resume.base.yaml");
    const normalizedTemplate = join(testDir, "normalized-template.docx");
    await Bun.write(
      normalizedTemplate,
      new Uint8Array(await Bun.file("templates/resume-template.docx").arrayBuffer()),
    );
    await normalizeTemplate(normalizedTemplate, base);

    const joined = (await extractDocumentText(normalizedTemplate)).join("\n");
    expect(joined.indexOf("Brainform —")).toBeLessThan(joined.indexOf("Xlend —"));
    expect(joined.indexOf("Xlend —")).toBeLessThan(joined.indexOf("Sally —"));
    expect(joined.indexOf("Sally —")).toBeLessThan(joined.indexOf("Archand —"));
    expect(joined).toContain(
      "{experiences.brainform.role}\t{experiences.brainform.period}",
    );
    expect(joined).not.toContain(
      "\t{experiences.brainform.role}\t{experiences.brainform.period}",
    );

    const xml = new PizZip(await Bun.file(normalizedTemplate).arrayBuffer())
      .file("word/document.xml")
      ?.asText();
    const brainformCompany = xml
      ?.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)
      ?.find((item) => item.includes("{experiences.brainform.context}"));
    expect(brainformCompany).toContain("<w:ind/>");
  });

  test("renders the user-edited visual master with leading alignment tabs", async () => {
    const base = await loadResume("data/resume.base.yaml");
    const proposal = validateProposal(
      JSON.parse(await Bun.file("fixtures/weplace.proposal.json").text()),
      base,
    );
    const editedOutput = join(testDir, "edited-template-resume.docx");
    await renderResume(
      "templates/resume-template.docx",
      editedOutput,
      applyProposal(base, proposal),
    );
    const joined = (await extractDocumentText(editedOutput)).join("\n");
    expect(joined.indexOf("Xlend —")).toBeLessThan(joined.indexOf("Brainform —"));
    expect(joined).toContain("Brainform — B2B SaaS for retail\tLyon, France");
  });

  test("renders targeted content in requested order", async () => {
    const text = await extractDocumentText(output);
    const joined = text.join("\n");
    expect(joined.indexOf("Xlend —")).toBeLessThan(joined.indexOf("Brainform —"));
    expect(joined.indexOf("Brainform —")).toBeLessThan(joined.indexOf("Sally —"));
    expect(joined.indexOf("Sally —")).toBeLessThan(joined.indexOf("Archand —"));
    expect(joined).toContain("Chef de Produit orienté B2B");
    expect(joined).toContain("plateforme éducative LLM");
    expect(joined).toContain("Gestion de Produit");
  });

  test("removes omitted bullets and projects without leaking markers", async () => {
    const joined = (await extractDocumentText(output)).join("\n");
    expect(joined).not.toContain("Chaîne Musicale");
    expect(joined).not.toContain("Packs d'Autocollants");
    expect(joined).not.toContain("__CV_DELETE_PARAGRAPH__");
    expect(joined).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);
    expect(joined).not.toContain("legaltech dans l'edtech");
  });

  test("renders canonical roles and protected dates", async () => {
    const joined = (await extractDocumentText(output)).join("\n");
    expect(joined).toContain("COO & PM\tAoût 2023 - Juin 2026");
    expect(joined).toContain("GTM & Sales Engineering\tAvril 2026 - Juin 2026");
  });

  test("uses one shared right-column tab before experience locations", async () => {
    const text = await extractDocumentText(output);
    expect(text).toContain("Xlend — Division Fintech d'un groupe coté en bourse\tLyon, France");
    expect(text).toContain("Brainform — B2B SaaS for retail\tLyon, France");
    expect(text).toContain("Sally — Société de prospection B2B\tLyon, France");

    const xml = new PizZip(await Bun.file(output).arrayBuffer())
      .file("word/document.xml")
      ?.asText();
    for (const company of ["Xlend", "Brainform", "Sally"]) {
      const paragraph = xml
        ?.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)
        ?.find((item) => item.includes(company));
      expect(paragraph).toContain('<w:tab w:val="left" w:leader="none" w:pos="9450"/>');
    }
  });

  test("uses document styles without direct body-font outliers", async () => {
    const xml = new PizZip(await Bun.file(output).arrayBuffer())
      .file("word/document.xml")
      ?.asText();
    expect(xml).not.toContain("Arial Unicode MS");
  });

  test("does not force the oldest experience onto page two", async () => {
    const xml = new PizZip(await Bun.file(output).arrayBuffer())
      .file("word/document.xml")
      ?.asText();
    const paragraph = xml
      ?.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)
      ?.find((item) => item.includes("ReloFrance"));
    expect(paragraph).not.toContain("<w:pageBreakBefore");
  });
});

describe("proposal guardrails", () => {
  test("allows reviewed functional title reframing", async () => {
    const base = await loadResume("data/resume.base.yaml");
    const proposal = validateProposal(
      {
        experiences: {
          brainform: {
            role: "Product & Sales Engineering",
          },
        },
      },
      base,
    );
    expect(applyProposal(base, proposal).experiences.brainform.role).toBe(
      "Product & Sales Engineering",
    );
  });

  test("rejects protected date edits", async () => {
    const base = await loadResume("data/resume.base.yaml");
    expect(() =>
      validateProposal({ experiences: { xlend: { period: "2023 - Present" } } }, base),
    ).toThrow("protected field");
  });
});
