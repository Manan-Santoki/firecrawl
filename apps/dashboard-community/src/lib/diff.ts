export type DiffLine = { kind: "add" | "del" | "hunk" | "ctx"; text: string };

/** Splits a unified diff into typed lines for the diff viewer. */
export function diffLines(text: string): DiffLine[] {
  return text.split("\n").map((line) => {
    if (line.startsWith("@@")) return { kind: "hunk", text: line };
    if (line.startsWith("+") && !line.startsWith("+++")) return { kind: "add", text: line };
    if (line.startsWith("-") && !line.startsWith("---")) return { kind: "del", text: line };
    return { kind: "ctx", text: line };
  });
}
