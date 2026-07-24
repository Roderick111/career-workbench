import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TabStopPosition,
  TabStopType,
  TextRun,
} from "docx";
import PizZip from "pizzip";
import type { TemplateParagraph, TemplateSlot, WebProfile } from "../web-types";
import { artifactsDir } from "./db";

const PART_PATTERN = /^word\/(?:document|header\d+|footer\d+)\.xml$/;
const PARAGRAPH_PATTERN = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

export interface TemplateAnalysis {
  paragraphs: TemplateParagraph[];
  suggestedSlots: TemplateSlot[];
  unsupported: string[];
}

export async function analyzeTemplate(path: string, profile: WebProfile): Promise<TemplateAnalysis> {
  const zip = new PizZip(await Bun.file(path).arrayBuffer());
  const paragraphs: TemplateParagraph[] = [];
  const unsupported: string[] = [];

  for (const part of Object.keys(zip.files).filter((name) => PART_PATTERN.test(name))) {
    const xml = zip.file(part)?.asText() ?? "";
    if (/<w:txbxContent|<wps:txbx|<v:textbox/i.test(xml)) {
      unsupported.push(`${part}: text boxes are not supported`);
    }
    [...xml.matchAll(PARAGRAPH_PATTERN)].forEach((match, index) => {
      const text = paragraphText(match[0]);
      if (!text.trim()) return;
      paragraphs.push({
        id: `${part}:${index}`,
        part,
        index,
        text,
        inTable: isParagraphInTable(xml, match.index ?? 0),
      });
    });
  }

  return {
    paragraphs,
    suggestedSlots: suggestMappings(paragraphs, profile),
    unsupported,
  };
}

export async function renderMappedTemplate(
  sourcePath: string,
  targetPath: string,
  slots: TemplateSlot[],
  profile: WebProfile,
): Promise<void> {
  const zip = new PizZip(await Bun.file(sourcePath).arrayBuffer());
  const grouped = new Map<string, TemplateSlot[]>();
  for (const slot of slots) {
    const key = `${slot.documentPart}:${slot.paragraphIndex}`;
    grouped.set(key, [...(grouped.get(key) ?? []), slot]);
  }

  const changedParts = new Set<string>();
  for (const [part, file] of Object.entries(zip.files)) {
    if (!PART_PATTERN.test(part) || file.dir) continue;
    let xml = file.asText();
    let paragraphIndex = 0;
    xml = xml.replace(PARAGRAPH_PATTERN, (paragraph) => {
      const mapping = grouped.get(`${part}:${paragraphIndex++}`);
      if (!mapping?.length) return paragraph;
      let updated = paragraph;
      const whole = mapping.filter((slot) => slot.mode === "whole-paragraph");
      if (whole.length > 1 || (whole.length && mapping.length > 1)) {
        throw new Error(`Paragraph ${part}:${paragraphIndex - 1} has conflicting mappings.`);
      }
      for (const slot of mapping) {
        const value = getPath(profile, slot.fieldPath);
        if (typeof value !== "string") {
          throw new Error(`Mapped field is not text: ${slot.fieldPath}`);
        }
        updated = replaceVisibleText(
          updated,
          slot.mode === "whole-paragraph" ? paragraphText(updated) : slot.matchText,
          value,
        );
      }
      changedParts.add(part);
      return updated;
    });
    if (changedParts.has(part)) zip.file(part, xml);
  }

  for (const slot of slots) {
    if (!changedParts.has(slot.documentPart)) {
      throw new Error(`Mapped document part was not changed: ${slot.documentPart}`);
    }
  }
  await mkdir(join(targetPath, ".."), { recursive: true });
  await Bun.write(targetPath, zip.generate({ type: "uint8array" }));
  new PizZip(await Bun.file(targetPath).arrayBuffer());
}

export async function createStarterTemplate(userId: string, profile: WebProfile): Promise<string> {
  const directory = join(artifactsDir, userId, "templates");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `starter-${crypto.randomUUID()}.docx`);
  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: profile.personal.name || "Your name", bold: true, size: 42 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun(profile.personal.headline || "Professional headline")],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun(
          [profile.personal.location, profile.personal.phone, profile.personal.email]
            .filter(Boolean)
            .join(" | ") || "City | Phone | Email",
        ),
      ],
    }),
    heading(profile, "Résumé", "Summary"),
    new Paragraph(profile.summary || "Professional summary"),
    heading(profile, "Expérience", "Experience"),
  ];

  for (const experience of profile.experiences) {
    children.push(
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children: [
          new TextRun({ text: experience.company, bold: true }),
          new TextRun(experience.context ? ` — ${experience.context}` : ""),
          new TextRun(`\t${experience.location}`),
        ],
      }),
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children: [
          new TextRun(experience.role),
          new TextRun(`\t${experience.period}`),
        ],
      }),
      ...experience.bullets.map(
        (bullet) =>
          new Paragraph({
            text: bullet,
            bullet: { level: 0 },
          }),
      ),
    );
  }

  if (profile.education.length) {
    children.push(
      heading(profile, "Formation", "Education"),
      ...profile.education.map((item) => new Paragraph(item)),
    );
  }
  if (profile.skills.length || profile.languages.length) {
    children.push(
      heading(profile, "Compétences", "Skills"),
      new Paragraph([...profile.skills, ...profile.languages].join(" · ")),
    );
  }

  const document = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Aptos", size: 21 },
          paragraph: { spacing: { after: 90 } },
        },
      },
    },
    sections: [{ children }],
  });
  await Bun.write(path, await Packer.toBuffer(document));
  return path;
}

export async function extractDocxText(path: string): Promise<string> {
  const zip = new PizZip(await Bun.file(path).arrayBuffer());
  const texts: string[] = [];
  for (const part of Object.keys(zip.files).filter((name) => PART_PATTERN.test(name))) {
    const xml = zip.file(part)?.asText() ?? "";
    texts.push(...[...xml.matchAll(PARAGRAPH_PATTERN)].map((match) => paragraphText(match[0])));
  }
  return texts.filter(Boolean).join("\n");
}

export async function sha256(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

export function safeFilename(value: string, fallback = "document"): string {
  const cleaned = basename(value)
    .replace(/[^a-zA-Z0-9À-ÿ._ -]+/g, "")
    .trim()
    .slice(0, 100);
  return cleaned || fallback;
}

function heading(profile: WebProfile, french: string, english: string): Paragraph {
  const useFrench = profile.languages.some((language) => /fran/i.test(language));
  return new Paragraph({
    text: useFrench ? french : english,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 180, after: 100 },
  });
}

function suggestMappings(paragraphs: TemplateParagraph[], profile: WebProfile): TemplateSlot[] {
  const values = flattenProfile(profile)
    .filter((item) => item.value.trim().length >= 3)
    .sort((a, b) => b.value.length - a.value.length);
  const slots: TemplateSlot[] = [];
  const usedMatches = new Set<string>();
  for (const item of values) {
    const candidates = paragraphs.filter(
      (paragraph) =>
        occurrences(paragraph.text, item.value) === 1 &&
        !usedMatches.has(`${paragraph.id}:${item.value}`),
    );
    const paragraph = candidates[0];
    if (!paragraph) continue;
    if (slots.some((slot) => slot.fieldPath === item.path)) continue;
    usedMatches.add(`${paragraph.id}:${item.value}`);
    slots.push({
      id: crypto.randomUUID(),
      fieldPath: item.path,
      documentPart: paragraph.part,
      paragraphIndex: paragraph.index,
      matchText: item.value,
      mode: paragraph.text.trim() === item.value.trim() ? "whole-paragraph" : "inline-text",
      protection: isProtectedPath(item.path) ? "protected" : "tailorable",
    });
  }
  return slots;
}

function flattenProfile(profile: WebProfile): Array<{ path: string; value: string }> {
  const result: Array<{ path: string; value: string }> = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      result.push({ path, value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}.${index}`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key === "background" || key === "rules") continue;
        visit(item, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(profile, "");
  return result;
}

export function isProtectedPath(path: string): boolean {
  return (
    path.startsWith("personal.") ||
    /^experiences\.\d+\.(company|location|period)$/.test(path) ||
    path.startsWith("education.") ||
    path.startsWith("languages.")
  );
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function replaceVisibleText(paragraph: string, needle: string, replacement: string): string {
  const nodes = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    open: match[0].slice(0, match[0].indexOf(">") + 1),
    text: decodeXml(match[1]),
  }));
  const visible = nodes.map((node) => node.text).join("");
  const start = visible.indexOf(needle);
  if (start < 0 || visible.indexOf(needle, start + needle.length) >= 0) {
    throw new Error(`Mapped text must occur exactly once: ${needle.slice(0, 80)}`);
  }
  const end = start + needle.length;
  let cursor = 0;
  let first = -1;
  let last = -1;
  let startOffset = 0;
  let endOffset = 0;
  nodes.forEach((node, index) => {
    const nodeStart = cursor;
    const nodeEnd = cursor + node.text.length;
    if (first < 0 && start >= nodeStart && start <= nodeEnd) {
      first = index;
      startOffset = start - nodeStart;
    }
    if (end >= nodeStart && end <= nodeEnd) {
      last = index;
      endOffset = end - nodeStart;
    }
    cursor = nodeEnd;
  });
  if (first < 0 || last < 0) throw new Error(`Could not map text: ${needle.slice(0, 80)}`);

  const updated = nodes.map((node) => node.text);
  if (first === last) {
    updated[first] =
      updated[first].slice(0, startOffset) + replacement + updated[first].slice(endOffset);
  } else {
    updated[first] = updated[first].slice(0, startOffset) + replacement;
    for (let index = first + 1; index < last; index += 1) updated[index] = "";
    updated[last] = updated[last].slice(endOffset);
  }

  let xml = paragraph;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    xml =
      xml.slice(0, node.start) +
      `${node.open}${escapeXml(updated[index])}</w:t>` +
      xml.slice(node.end);
  }
  return xml;
}

function paragraphText(paragraph: string): string {
  const parts: string[] = [];
  for (const match of paragraph.matchAll(
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br(?:\s[^>]*)?\/>/g,
  )) {
    if (match[1] !== undefined) parts.push(decodeXml(match[1]));
    else if (match[0].startsWith("<w:tab")) parts.push("\t");
    else parts.push("\n");
  }
  return parts.join("");
}

function isParagraphInTable(xml: string, index: number): boolean {
  const before = xml.slice(0, index);
  return before.lastIndexOf("<w:tbl") > before.lastIndexOf("</w:tbl>");
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}
