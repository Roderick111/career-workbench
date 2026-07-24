import PizZip from "pizzip";
import type { Resume } from "./types";

const DOCUMENT_XML = "word/document.xml";
const DELETE_MARKER = "__CV_DELETE_PARAGRAPH__";

export async function buildTemplate(sourcePath: string, targetPath: string): Promise<void> {
  const zip = new PizZip(await Bun.file(sourcePath).arrayBuffer());
  const document = zip.file(DOCUMENT_XML);
  if (!document) throw new Error(`Missing ${DOCUMENT_XML}`);
  let xml = document.asText();

  xml = replaceWholeParagraph(xml, "Chef de Produit |", "{header.line}");
  xml = replaceExactParagraphOccurrence(xml, "Résumé", "{labels.summary}", 0);
  xml = replaceExactParagraphOccurrence(xml, "Résumé", "{labels.experience}", 0);
  xml = replaceWholeParagraph(xml, "Chef de Produit & cofondateur", "{summary}");

  const experienceSlots: Record<string, { context: string; location?: string; role: string; period: string; bullets: string[] }> = {
    brainform: {
      context: "B2B SaaS for retail",
      location: "Lyon, France",
      role: "GTM & SDR",
      period: "Avril 2026 - Juin 2026",
      bullets: [
        "Construit le pipeline complet",
        "Défini la vision stratégique",
        "Géré une campagne de prospection",
      ],
    },
    sally: {
      context: "Société de prospection B2B",
      location: "Lyon, France",
      role: "Responsable Process & SDR",
      period: "Sept 2025 - Jan 2026",
      bullets: [
        "Géré des campagnes de prospection",
        "Construit un système de notification",
        "Créé un assistant IA",
        "Coordonné une équipe de 3 assistants",
      ],
    },
    xlend: {
      context: "Division Fintech d'un groupe coté en bourse",
      location: "Lyon, France",
      role: "COO & PM",
      period: "Août 2023 - Avril 2026",
      bullets: ["Dirigé la recherche UX", "Dirigé les opérations de licence", "Négocié et conclu"],
    },
    archand: {
      context: "Studio de développement de produits",
      role: "Fondateur & PM",
      period: "Déc 2022 - Août 2023",
      bullets: ["Livré 7 projets clients", "Traduit les besoins métier", "Géré les délais des projets"],
    },
    early: {
      context: "Trois entreprises en phase de démarrage dans l'edtech et la legaltech",
      role: "Co-fondateur",
      period: "2021 - 2023",
      bullets: ["Sécurisé 6 clients", "Conçu et présenté", "Mené des entretiens utilisateurs"],
    },
  };

  for (const [key, slot] of Object.entries(experienceSlots)) {
    xml = replaceText(xml, slot.context, `{experiences.${key}.context}`);
    if (slot.location) xml = replaceText(xml, slot.location, `{experiences.${key}.location}`, 1, key === "brainform" ? 0 : undefined);
    xml = replaceText(xml, slot.role, `{experiences.${key}.role}`);
    xml = replaceText(xml, slot.period, `{experiences.${key}.period}`);
    slot.bullets.forEach((prefix, index) => {
      xml = replaceWholeParagraph(xml, prefix, `{experiences.${key}.bullets.${index}}`);
    });
  }
  xml = normalizeLocationTab(xml, "{experiences.xlend.context}");
  xml = normalizeLocationTab(xml, "{experiences.brainform.context}");
  xml = normalizeLocationTab(xml, "{experiences.sally.context}");
  xml = addPageBreakBefore(xml, "ReloFrance, Learnio &amp; Yats");

  const projectSlots: Record<string, { description: string; date: string; bullet: string }> = {
    findr: {
      description: "outil de recherche de fichiers locaux le plus rapide",
      date: "Jan 2026",
      bullet: "Pleine propriété de bout en bout",
    },
    auror: {
      description: "plateforme de développement de jeux open source",
      date: "Jan 2026",
      bullet: "Construit une plateforme Python/TypeScript",
    },
    music: {
      description: "Chaîne Musicale",
      date: "Jan 2022",
      bullet: "Construit et développé une chaîne média",
    },
    stickers: {
      description: "Série de Packs d'Autocollants de Messagerie",
      date: "Fév 2021",
      bullet: "Développé 5 packs",
    },
  };

  for (const [key, slot] of Object.entries(projectSlots)) {
    if (key === "findr" || key === "auror") {
      xml = replaceText(xml, slot.description, `{projects.${key}.description}`);
    }
    xml = replaceText(xml, slot.date, `{projects.${key}.date}`);
    xml = replaceWholeParagraph(xml, slot.bullet, `{projects.${key}.bullet}`);
  }

  xml = replaceText(xml, "Master 1 |Neurosciences", "{education.bordeaux.program}");
  xml = replaceText(xml, "Juin 2027", "{education.bordeaux.date}");
  xml = replaceText(xml, "Licence | Sciences Politiques", "{education.lille.program}");
  xml = replaceText(xml, "Juin 2022", "{education.lille.date}");
  xml = replaceText(xml, "Cours de 2 semestres | Littérature Française", "{education.lyon.program}");
  xml = replaceText(xml, "Juin 2025", "{education.lyon.date}");

  xml = replaceText(xml, "Certification FMVA", "{certifications.fmva.program}");
  xml = replaceText(xml, "2026", "{certifications.fmva.date}");
  xml = replaceText(xml, "Incubation de Startup", "{certifications.emlyon.program}");
  xml = replaceText(xml, "Juin 2024", "{certifications.emlyon.date}");
  xml = replaceText(xml, "Conception UX/UI, Gestion de Projet", "{certifications.google.program}");
  xml = replaceText(xml, "Jan 2021", "{certifications.google.date}");

  xml = replaceText(xml, "Anglais (C1) · Français (C1) · Russe (Langue Maternelle) · Ukrainien", "{skills.languages}");
  xml = replaceText(xml, "Python · Docker  · Excel · SQL · Figma · Photoshop · Illustrator · Tests UX · Prototypage", "{skills.technical}");
  xml = replaceText(xml, "Gestion de Projet", "{skills.productLabel}");
  xml = replaceText(xml, "JTBD · Feuilles de Route Produit · Agile/Scrum · Gestion des Parties Prenantes ", "{skills.product}");
  xml = replaceText(xml, "Modélisation Financière · Élaboration de Cas d'Affaires · Exigences Réglementaires · Due Diligence", "{skills.finance}");
  xml = normalizeBodyFontOverrides(xml);

  zip.file(DOCUMENT_XML, xml);
  await Bun.write(targetPath, zip.generate({ type: "uint8array" }));
}

export async function renderResume(templatePath: string, targetPath: string, resume: Resume): Promise<void> {
  const zip = new PizZip(await Bun.file(templatePath).arrayBuffer());
  const document = zip.file(DOCUMENT_XML);
  if (!document) throw new Error(`Missing ${DOCUMENT_XML}`);
  let xml = document.asText();

  xml = normalizeBodyFontOverrides(xml);
  xml = ensureProductLabelPlaceholder(xml);
  xml = normalizeLocationTab(xml, "{experiences.xlend.context}");
  xml = normalizeLocationTab(xml, "{experiences.brainform.context}");
  xml = normalizeLocationTab(xml, "{experiences.sally.context}");

  xml = xml.replace(/<w:t([^>]*)>([\s\S]*?)<\/w:t>/g, (full, attributes: string, content: string) => {
    const matches = [...content.matchAll(/\{([a-zA-Z0-9_.]+)\}/g)];
    if (!matches.length) return full;
    let rendered = content;
    for (const match of matches) {
      const value = getPath(resume, match[1]);
      rendered = rendered.replace(match[0], escapeXml(value === undefined ? DELETE_MARKER : String(value)));
    }
    return `<w:t${attributes}>${rendered}</w:t>`;
  });

  xml = removeMarkedParagraphs(xml);
  xml = reorderBlocks(xml, "experience", resume.experienceOrder, resume);
  xml = reorderBlocks(xml, "projects", resume.projectOrder, resume);

  const unresolved = [...xml.matchAll(/\{[a-zA-Z0-9_.]+\}/g)].map((match) => match[0]);
  if (unresolved.length) throw new Error(`Unresolved template tags: ${[...new Set(unresolved)].join(", ")}`);

  zip.file(DOCUMENT_XML, xml);
  await Bun.write(targetPath, zip.generate({ type: "uint8array" }));
}

export async function normalizeTemplate(templatePath: string, resume: Resume): Promise<void> {
  const zip = new PizZip(await Bun.file(templatePath).arrayBuffer());
  const document = zip.file(DOCUMENT_XML);
  if (!document) throw new Error(`Missing ${DOCUMENT_XML}`);
  let xml = document.asText();

  xml = normalizeBodyFontOverrides(xml);
  for (const key of ["xlend", "brainform", "sally"]) {
    xml = normalizeLocationTab(xml, `{experiences.${key}.context}`);
  }
  for (const key of Object.keys(resume.experiences)) {
    xml = normalizeParagraphLeftAlignment(xml, `{experiences.${key}.context}`);
    xml = normalizeParagraphLeftAlignment(xml, `{experiences.${key}.role}`);
  }
  xml = ensureProductLabelPlaceholder(xml);
  xml = reorderBlocks(xml, "experience", resume.experienceOrder, resume);

  zip.file(DOCUMENT_XML, xml);
  await Bun.write(templatePath, zip.generate({ type: "uint8array" }));
}

export async function extractDocumentText(path: string): Promise<string[]> {
  const zip = new PizZip(await Bun.file(path).arrayBuffer());
  const xml = zip.file(DOCUMENT_XML)?.asText();
  if (!xml) throw new Error(`Missing ${DOCUMENT_XML}`);
  return paragraphs(xml).map(paragraphText).filter(Boolean);
}

function replaceWholeParagraph(xml: string, prefix: string, replacement: string): string {
  let replaced = false;
  const result = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (!replaced && paragraphText(paragraph).replace(/^\u200b+/, "").startsWith(prefix)) {
      replaced = true;
      return rebuildParagraph(paragraph, replacement);
    }
    return paragraph;
  });
  if (!replaced) throw new Error(`Template paragraph not found: ${prefix}`);
  return result;
}

function replaceExactParagraphOccurrence(xml: string, text: string, replacement: string, occurrence: number): string {
  let seen = 0;
  let replaced = false;
  const result = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (!replaced && paragraphText(paragraph) === text) {
      if (seen === occurrence) {
        replaced = true;
        return rebuildParagraph(paragraph, replacement);
      }
      seen += 1;
    }
    return paragraph;
  });
  if (!replaced) throw new Error(`Template paragraph occurrence not found: ${text}[${occurrence}]`);
  return result;
}

function rebuildParagraph(paragraph: string, text: string): string {
  const open = paragraph.match(/^<w:p(?:\s[^>]*)?>/)?.[0] ?? "<w:p>";
  const properties = paragraph.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
  const runProperties = paragraph.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? "";
  return `${open}${properties}<w:r>${runProperties}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function replaceText(xml: string, oldText: string, replacement: string, count = 1, skipOccurrence?: number): string {
  const escapedOld = escapeXml(oldText);
  let seen = 0;
  let changed = 0;
  const result = xml.replace(new RegExp(escapeRegExp(escapedOld), "g"), (match) => {
    if (skipOccurrence !== undefined && seen++ < skipOccurrence) return match;
    if (changed >= count) return match;
    changed += 1;
    return escapeXml(replacement);
  });
  if (!changed) throw new Error(`Template text not found: ${oldText}`);
  return result;
}

function normalizeLocationTab(xml: string, marker: string): string {
  let changed = false;
  const result = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (!paragraph.includes(marker)) return paragraph;
    changed = true;
    const markerIndex = paragraph.indexOf(marker);
    const beforeMarker = paragraph.slice(0, markerIndex).replace(/<w:tab\s*\/>/g, "");
    const afterMarker = paragraph.slice(markerIndex);
    let seenTab = false;
    let normalizedAfter = afterMarker.replace(/<w:tab\s*\/>/g, () => {
      if (seenTab) return "";
      seenTab = true;
      return "<w:tab/>";
    });
    let normalized = beforeMarker + normalizedAfter;
    normalized = normalized.replace(/<w:tabs>[\s\S]*?<\/w:tabs>/, "");
    const locationTab = '<w:tabs><w:tab w:val="left" w:leader="none" w:pos="9450"/></w:tabs>';
    normalized = normalized.replace(/(<w:pStyle\b[^>]*\/>)/, `$1${locationTab}`);
    return normalized;
  });
  if (!changed) throw new Error(`Template paragraph not found for location-tab normalization: ${marker}`);
  return result;
}

function normalizeParagraphLeftAlignment(xml: string, marker: string): string {
  let changed = false;
  const result = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (!paragraph.includes(marker)) return paragraph;
    changed = true;
    const markerIndex = paragraph.indexOf(marker);
    const beforeMarker = paragraph.slice(0, markerIndex).replace(/<w:tab\s*\/>/g, "");
    const afterMarker = paragraph.slice(markerIndex);
    return (beforeMarker + afterMarker).replace(/<w:ind\b[^>]*\/>/, "<w:ind/>");
  });
  if (!changed) throw new Error(`Template paragraph not found for alignment normalization: ${marker}`);
  return result;
}

function normalizeBodyFontOverrides(xml: string): string {
  return xml.replace(/<w:rFonts\b[^>]*Arial Unicode MS[^>]*\/>/g, "");
}

function ensureProductLabelPlaceholder(xml: string): string {
  if (xml.includes("{skills.productLabel}")) return xml;
  return replaceText(xml, "Gestion de Produit", "{skills.productLabel}");
}

function addPageBreakBefore(xml: string, marker: string): string {
  let changed = false;
  const pageBreak = '<w:pageBreakBefore w:val="1"/>';
  const result = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (!paragraph.includes(marker)) return paragraph;
    changed = true;
    if (paragraph.includes(pageBreak)) return paragraph;
    if (/<w:pStyle\b[^>]*\/>/.test(paragraph)) {
      return paragraph.replace(/(<w:pStyle\b[^>]*\/>)/, `$1${pageBreak}`);
    }
    return paragraph.replace("<w:pPr>", `<w:pPr>${pageBreak}`);
  });
  if (!changed) throw new Error(`Template paragraph not found for page break: ${marker}`);
  return result;
}

function removeMarkedParagraphs(xml: string): string {
  return xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) =>
    paragraph.includes(DELETE_MARKER) ? "" : paragraph,
  );
}

function reorderBlocks(xml: string, kind: "experience" | "projects", order: string[], resume: Resume): string {
  const bodyMatch = xml.match(/<w:body>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) throw new Error("DOCX body not found.");
  const body = bodyMatch[1];
  const items = paragraphs(body);
  const names =
    kind === "experience"
      ? Object.fromEntries(Object.entries(resume.experiences).map(([key, item]) => [key, item.company]))
      : Object.fromEntries(Object.entries(resume.projects).map(([key, item]) => [key, item.name]));
  const sectionLabels =
    kind === "experience"
      ? [resume.labels.experience, "{labels.experience}"]
      : ["Projets"];
  const sectionStart = items.findIndex((item) =>
    sectionLabels.some((label) => normalizedParagraphText(item).startsWith(label)),
  );
  const sectionEnd = items.findIndex(
    (item, index) =>
      index > sectionStart &&
      normalizedParagraphText(item).startsWith(kind === "experience" ? "Projets" : "Formation"),
  );
  if (sectionStart < 0 || sectionEnd < 0) throw new Error(`Could not locate ${kind} section.`);

  const starts: Array<{ key: string; index: number }> = [];
  for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
    const text = normalizedParagraphText(items[index]);
    const entry = Object.entries(names).find(([, name]) => text.startsWith(name));
    if (entry) starts.push({ key: entry[0], index });
  }
  const groups = new Map<string, string[]>();
  starts.forEach((start, index) => {
    const end = starts[index + 1]?.index ?? sectionEnd;
    groups.set(start.key, items.slice(start.index, end));
  });
  const firstStart = starts[0]?.index;
  if (firstStart === undefined) throw new Error(`No ${kind} blocks found.`);
  const reordered = order.flatMap((key) => {
    const group = groups.get(key);
    if (!group) throw new Error(`Template has no ${kind} block for ${key}`);
    return group;
  });
  const newItems = [...items.slice(0, firstStart), ...reordered, ...items.slice(sectionEnd)];
  let cursor = 0;
  const rebuiltBody = body.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, () => newItems[cursor++] ?? "");
  return xml.replace(bodyMatch[0], `<w:body>${rebuiltBody}</w:body>`);
}

function normalizedParagraphText(paragraph: string): string {
  return paragraphText(paragraph).replace(/^[\s\u200b]+/, "");
}

function paragraphs(xml: string): string[] {
  return [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((match) => match[0]);
}

function paragraphText(paragraph: string): string {
  const parts: string[] = [];
  const tokenPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br(?:\s[^>]*)?\/>/g;
  for (const match of paragraph.matchAll(tokenPattern)) {
    if (match[1] !== undefined) parts.push(decodeXml(match[1]));
    else if (match[0].startsWith("<w:tab")) parts.push("\t");
    else parts.push("\n");
  }
  return parts.join("");
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
