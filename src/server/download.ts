export function artifactHeaders(filename: string, size: number): HeadersInit {
  const asciiName =
    filename
      .normalize("NFKD")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/["\\]/g, "_")
      .trim() || "download";
  const encodedName = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return {
    "Content-Type": filename.toLowerCase().endsWith(".docx")
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : filename.toLowerCase().endsWith(".md")
        ? "text/markdown; charset=utf-8"
        : "application/octet-stream",
    "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    "Content-Length": String(size),
  };
}
