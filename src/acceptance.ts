export function acceptanceCriteria(body: string): string[] {
  const lines = body.split("\n");
  const heading = lines.findIndex((line) => line.trim() === "## Acceptance criteria");
  if (heading === -1) return [];
  const nextSection = lines.findIndex((line, index) => index > heading && line.startsWith("## "));
  return lines
    .slice(heading + 1, nextSection === -1 ? undefined : nextSection)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}
