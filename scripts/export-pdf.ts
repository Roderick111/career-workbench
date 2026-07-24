import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const input = resolve(process.argv[2] ?? "output/weplace-product-owner/resume.docx");
const output = resolve(process.argv[3] ?? input.replace(/\.docx$/i, ".pdf"));
const x2t =
  process.env.ONLYOFFICE_X2T ??
  "/Applications/ONLYOFFICE.app/Contents/Resources/converter/x2t";
const fontDir =
  process.env.ONLYOFFICE_FONT_DIR ??
  join(
    homedir(),
    "Library/Application Support/asc.onlyoffice.ONLYOFFICE/data/fonts",
  );
const allFonts = join(fontDir, "AllFonts.js");

for (const path of [input, x2t, allFonts]) {
  if (!(await Bun.file(path).exists())) throw new Error(`Required file not found: ${path}`);
}

await mkdir(dirname(output), { recursive: true });
const taskDir = await mkdtemp(join(tmpdir(), "job-search-x2t-"));
const taskPath = join(taskDir, "task.xml");

try {
  await Bun.write(
    taskPath,
    `<?xml version="1.0" encoding="utf-8"?>
<TaskQueueDataConvert>
  <m_sFileFrom>${escapeXml(input)}</m_sFileFrom>
  <m_sFileTo>${escapeXml(output)}</m_sFileTo>
  <m_nFormatFrom>65</m_nFormatFrom>
  <m_nFormatTo>513</m_nFormatTo>
  <m_sAllFontsPath>${escapeXml(allFonts)}</m_sAllFontsPath>
  <m_sFontDir>${escapeXml(fontDir)}</m_sFontDir>
</TaskQueueDataConvert>`,
  );
  const process = Bun.spawn([x2t, taskPath], {
    cwd: dirname(x2t),
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`ONLYOFFICE conversion failed with exit code ${exitCode}`);
  if (!(await Bun.file(output).exists())) throw new Error("ONLYOFFICE did not create the PDF.");
  console.log(`PDF: ${output}`);
} finally {
  await rm(taskDir, { recursive: true, force: true });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
