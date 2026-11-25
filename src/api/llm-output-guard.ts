import { addedNumericFacts, changedUnits, missingNumericFacts } from "../engine/number-fidelity.ts";
import {
  fencedCodeSpans,
  frontmatterSpans,
  inlineCodeSpans,
  quotedSpans,
  type TextSpan,
} from "../engine/text-shield.ts";

const URL_RE = /https?:\/\/[^\s)）】，。；、"']+/g;
const MAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const HEADING_RE = /^#{1,6}\s+.+$/gm;
const LINK_TARGET_RE = /\]\(([^\n)]+)\)/g;
const TABLE_ROW_RE = /^\|.*\|$/gm;
const STEP_MARKER_RE = /^\d+[.)]\s/gm;
const EXPLICIT_ID_RE = /<[^>]+\bid="[^"]+"[^>]*>/g;
const CJK_RE = /[\u3400-\u9fff]/g;
const LATIN_RE = /[A-Za-z]/g;

const uniqueSorted = (values: string[]) => [...new Set(values)].sort();
const grab = (text: string, re: RegExp) =>
  uniqueSorted(text.match(re) ?? []).map((value) =>
    re === URL_RE ? value.replace(/[.,;:!?]+$/g, "") : value,
  );
const quotedContents = (text: string) =>
  spanTexts(text, quotedSpans(text)).map((value) => value.slice(1, -1));
const normalizeQuoteTypography = (quote: string) =>
  /[\u3400-\u9fff]/.test(quote)
    ? quote
        .replace(/,/g, "，")
        .replace(/;/g, "；")
        .replace(/:/g, "：")
        .replace(/!/g, "！")
        .replace(/\?/g, "？")
    : quote;
const spanTexts = (text: string, spans: TextSpan[]) =>
  spans.map((span) => text.slice(span.start, span.end));
const sameList = (before: string[], after: string[]) =>
  JSON.stringify(uniqueSorted(before)) === JSON.stringify(uniqueSorted(after));
const visibleLength = (text: string) => text.replace(/\s/g, "").length;

function languageDrift(original: string, rewritten: string): boolean {
  const originalCjk = original.match(CJK_RE)?.length ?? 0;
  const originalLatin = original.match(LATIN_RE)?.length ?? 0;
  const rewrittenCjk = rewritten.match(CJK_RE)?.length ?? 0;
  const rewrittenVisible = Math.max(1, visibleLength(rewritten));
  if (originalLatin > originalCjk * 2 && rewrittenCjk / rewrittenVisible > 0.1) return true;
  return originalCjk > originalLatin * 2 && rewrittenCjk / rewrittenVisible < 0.15;
}

export function llmOutputIssues(original: string, rewritten: string): string[] {
  const issues: string[] = [];
  if (!rewritten.trim()) return ["empty-output"];

  const missing = missingNumericFacts(original, rewritten);
  if (missing.length) issues.push(`missing-numbers:${missing.join(",")}`);
  const added = addedNumericFacts(original, rewritten);
  if (added.length) issues.push(`added-numbers:${added.join(",")}`);
  const units = changedUnits(original, rewritten);
  if (units.length) issues.push(`changed-units:${units.join(",")}`);

  if (languageDrift(original, rewritten)) issues.push("language-drift");

  const originalUrls = grab(original, URL_RE);
  const rewrittenUrls = new Set(grab(rewritten, URL_RE));
  const lostUrls = originalUrls.filter((url) => !rewrittenUrls.has(url));
  if (lostUrls.length) issues.push(`lost-url:${lostUrls.join(",")}`);
  const originalMails = grab(original, MAIL_RE);
  const rewrittenMails = new Set(grab(rewritten, MAIL_RE));
  const lostMails = originalMails.filter((mail) => !rewrittenMails.has(mail));
  if (lostMails.length) issues.push(`lost-email:${lostMails.join(",")}`);

  const originalQuotes = quotedContents(original).map(normalizeQuoteTypography);
  const rewrittenQuotes = new Set(quotedContents(rewritten).map(normalizeQuoteTypography));
  if (originalQuotes.some((quote) => !rewrittenQuotes.has(quote))) issues.push("quote-changed");
  if (
    !sameList(
      spanTexts(original, fencedCodeSpans(original)),
      spanTexts(rewritten, fencedCodeSpans(rewritten)),
    )
  ) {
    issues.push("fenced-code-changed");
  }
  if (
    !sameList(
      spanTexts(original, frontmatterSpans(original)),
      spanTexts(rewritten, frontmatterSpans(rewritten)),
    )
  ) {
    issues.push("frontmatter-changed");
  }
  const originalInlineCode = spanTexts(original, inlineCodeSpans(original));
  const rewrittenInlineCode = new Set(spanTexts(rewritten, inlineCodeSpans(rewritten)));
  if (originalInlineCode.some((code) => !rewrittenInlineCode.has(code)))
    issues.push("inline-code-lost");

  if (!sameList(grab(original, HEADING_RE), grab(rewritten, HEADING_RE)))
    issues.push("headings-changed");
  if (!sameList(grab(original, LINK_TARGET_RE), grab(rewritten, LINK_TARGET_RE)))
    issues.push("link-targets-changed");
  if (!sameList(grab(original, TABLE_ROW_RE), grab(rewritten, TABLE_ROW_RE)))
    issues.push("table-rows-changed");
  if (!sameList(grab(original, STEP_MARKER_RE), grab(rewritten, STEP_MARKER_RE)))
    issues.push("step-markers-changed");
  if (!sameList(grab(original, EXPLICIT_ID_RE), grab(rewritten, EXPLICIT_ID_RE)))
    issues.push("explicit-ids-changed");

  const originalLength = visibleLength(original);
  const rewrittenLength = visibleLength(rewritten);
  if (originalLength >= 60 && rewrittenLength < originalLength * 0.4) issues.push("severe-shrink");
  if (
    originalLength >= 60 &&
    rewrittenLength > originalLength * 1.5 &&
    rewrittenLength - originalLength > 60
  ) {
    issues.push("inflation");
  }
  return issues;
}
