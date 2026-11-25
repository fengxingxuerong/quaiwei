import {
  addedNumericFacts,
  changedUnits,
  missingNumericFacts,
} from "../src/engine/number-fidelity.ts";
import { collapseIssues } from "../src/engine/humanize-metrics.ts";

const URL_RE = /https?:\/\/[^\s)）】，。；、"']+/g;
const MAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const QUOTE_RE = /“[^”]+”|"[^"]+"/g;
const CJK_RE = /[\u3400-\u9fff]/g;

const uniqueSorted = (values: string[]) => [...new Set(values)].sort();
const grab = (text: string, re: RegExp) => uniqueSorted(text.match(re) ?? []);

// Adapted from op7418/Humanizer-zh tests/check_structure.py (MIT).
export function protectedMarkdownParts(text: string) {
  const frontmatter = /^---\n.*?\n---\n/.exec(text);
  return {
    frontmatter: frontmatter?.[0] ?? null,
    fencedCode: text.match(/^```[^\n]*\n.*?^```[ \t]*$/gm) ?? [],
    inlineCode: text.match(/(?<!`)`([^`\n]+)`(?!`)/g) ?? [],
    headings: text.match(/^#{1,6} .+$/gm) ?? [],
    linkTargets: text.match(/\]\(([^\n)]+)\)/g) ?? [],
    tableRows: text.match(/^\|.*\|$/gm) ?? [],
    orderedStepMarkers: text.match(/^\d+[.)]/gm) ?? [],
    explicitIds: text.match(/<[^>]+\bid="[^"]+"[^>]*>/g) ?? [],
  };
}

function cjkRatio(text: string): number {
  const visible = text.replace(/\s/g, "");
  return visible.length ? (text.match(CJK_RE)?.length ?? 0) / visible.length : 0;
}

export function hardFidelityIssues(input: string, output: string): string[] {
  const issues: string[] = [];
  if (!output.trim()) issues.push("empty-output");

  const missing = missingNumericFacts(input, output);
  if (missing.length) issues.push(`missing-numbers:${missing.join(",")}`);
  const added = addedNumericFacts(input, output);
  if (added.length) issues.push(`added-numbers:${added.join(",")}`);
  const units = changedUnits(input, output);
  if (units.length) issues.push(`changed-units:${units.join(",")}`);

  for (const [label, re] of [
    ["url", URL_RE],
    ["email", MAIL_RE],
    ["quote", QUOTE_RE],
  ] as const) {
    const before = grab(input, re);
    const after = new Set(grab(output, re));
    const lost = before.filter((value) => !after.has(value));
    if (lost.length) issues.push(`lost-${label}:${lost.join(",")}`);
  }

  const beforeParts = protectedMarkdownParts(input);
  const afterParts = protectedMarkdownParts(output);
  for (const key of Object.keys(beforeParts) as Array<keyof typeof beforeParts>) {
    if (key === "orderedStepMarkers" && beforeParts[key].length === 0) continue;
    if (key === "inlineCode") {
      const after = new Set(afterParts.inlineCode);
      if (beforeParts.inlineCode.some((code) => !after.has(code)))
        issues.push("markdown-inlineCode");
      continue;
    }
    if (JSON.stringify(beforeParts[key]) !== JSON.stringify(afterParts[key])) {
      issues.push(`markdown-${key}`);
    }
  }

  const collapse = collapseIssues(input, output);
  if (collapse.length) issues.push(`collapse:${collapse.join(",")}`);

  const ratioIn = cjkRatio(input);
  const ratioOut = cjkRatio(output);
  if (ratioIn >= 0.15 && ratioOut < ratioIn - 0.2) issues.push("language-drift");
  return issues;
}
