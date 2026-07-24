import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadResume } from "../src/data";
import { buildTemplate, normalizeTemplate } from "../src/ooxml";

const source =
  process.argv[2] ?? process.env.RESUME_SOURCE ?? "resume.docx";
const target = process.argv[3] ?? "templates/resume-template.docx";

await mkdir(dirname(target), { recursive: true });
await buildTemplate(source, target);
await normalizeTemplate(target, await loadResume("data/resume.base.yaml"));
console.log(`Template written: ${target}`);
