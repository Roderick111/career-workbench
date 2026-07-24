import { loadResume } from "../src/data";
import { normalizeTemplate } from "../src/ooxml";

const path = process.argv[2] ?? "templates/resume-template.docx";
await normalizeTemplate(path, await loadResume("data/resume.base.yaml"));
console.log(`Normalized ${path}`);
