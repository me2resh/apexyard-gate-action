const RUN_ID = /^ayr-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
const TRAILER = /^([A-Za-z0-9-]+)[:=][ \t]*(.*)$/;

export function trailerRunId(message) {
  if (typeof message !== "string") return null;
  const lines = message.split("\n").map((line) => line.replace(/\r$/, ""));
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const block = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.trim() === "") break;
    const match = TRAILER.exec(line);
    if (!match) break;
    block.push({ key: match[1], value: match[2].trim() });
  }
  const runs = block.filter((trailer) => trailer.key === "ApexYard-Run");
  if (runs.length !== 1) return null;
  if (!RUN_ID.test(runs[0].value)) return null;
  return runs[0].value;
}

export function collectRunIds(commits) {
  const ids = [];
  const seen = new Set();
  let withTrailer = 0;
  const list = Array.isArray(commits) ? commits : [];
  for (const commit of list) {
    const id = trailerRunId(commit && commit.message);
    if (!id) continue;
    withTrailer += 1;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { ids, withTrailer, commitCount: list.length };
}
