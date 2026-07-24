import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { applyProposal, loadResume, validateProposal, writeResume } from "./data";
import { requestProposal } from "./llm";
import { buildTemplate, renderResume } from "./ooxml";
import { buildReview } from "./review";

const options = parseArgs(process.argv.slice(2));
const basePath = stringOption(options, "base") ?? "data/resume.base.yaml";
const templatePath = stringOption(options, "template") ?? "templates/resume-template.docx";
const sourceDocx =
  stringOption(options, "source") ?? "Daniel MEDINA - product manager - Resume Bordeaux FR 2026.docx";
const jobPath = required(stringOption(options, "job"), "--job is required.");
const slug = basename(jobPath).replace(/\.[^.]+$/, "");
const outputDir = stringOption(options, "output") ?? join("output", slug);

if (!(await Bun.file(templatePath).exists())) {
  await mkdir("templates", { recursive: true });
  await buildTemplate(sourceDocx, templatePath);
}

const base = await loadResume(basePath);
const proposalPath = stringOption(options, "proposal");
const proposalRaw = proposalPath
  ? JSON.parse(await Bun.file(proposalPath).text())
  : await requestProposal({
      resume: base,
      background: await Bun.file("my_background.md").text(),
      guidelines: await Bun.file("GUIDELINES.md").text(),
      job: await Bun.file(jobPath).text(),
    });
const proposal = validateProposal(proposalRaw, base);
const tailored = applyProposal(base, proposal);
const review = buildReview(base, tailored, proposal, jobPath);

await mkdir(outputDir, { recursive: true });
await writeResume(join(outputDir, "resume.yaml"), tailored);
await Bun.write(join(outputDir, "review.md"), review);

if (options.approve !== true) {
  console.log(review);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await terminal.question("Generate targeted DOCX? [y/N] ");
  terminal.close();
  if (answer.trim().toLowerCase() !== "y") {
    console.log(`Review written: ${join(outputDir, "review.md")}`);
    process.exit(0);
  }
}

const outputDocx = join(outputDir, "resume.docx");
await renderResume(templatePath, outputDocx, tailored);
console.log(`Tailored YAML: ${join(outputDir, "resume.yaml")}`);
console.log(`Review: ${join(outputDir, "review.md")}`);
console.log(`DOCX: ${outputDocx}`);

function parseArgs(args: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (key === "approve") {
      parsed.approve = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed[key] = value;
  }
  return parsed;
}

function required(value: string | boolean | undefined, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}

function stringOption(options: Record<string, string | boolean>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}
