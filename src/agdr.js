const RUN_LINE = /^run: (ayr-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8})$/;

export function runLinkFromAgdr(text) {
  if (typeof text !== "string") return null;
  const lines = text.split("\n");
  if ((lines[0] ?? "").replace(/\r$/, "") !== "---") return null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, "");
    if (line === "---") return null;
    const match = RUN_LINE.exec(line);
    if (match) return match[1];
  }
  return null;
}
