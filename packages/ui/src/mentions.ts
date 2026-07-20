// @vayo/ui — inline reference tokens for Team Chat: @mentions (people) and
// #tags (endpoints), parsed in one pass and composed the same way. Stored
// raw as `@[Display Name](memberId)` / `#[path](vayoId)` (mirrors the
// extraction `@vayo/server` does independently server-side, for
// notifications and for deriving which endpoints a message is about)
// rather than freeform text matching, so a reference is unambiguous even
// with duplicate names/paths and rendering never has to guess what a token
// refers to.

const REFERENCE_PATTERN = /@\[([^\]]+)\]\(([^)]+)\)|#\[([^\]]+)\]\(([^)]+)\)/g;

export function formatMentionToken(name: string, memberId: string): string {
  return `@[${name}](${memberId})`;
}

export function formatEndpointTagToken(path: string, vayoId: string): string {
  return `#[${path}](${vayoId})`;
}

export interface MentionSegment {
  type: "text" | "mention" | "endpoint";
  content: string;
  memberId?: string;
  vayoId?: string;
}

/** Splits a message body into plain-text, mention, and endpoint-tag
 * segments for rendering — a reference segment's `content` is the display
 * text (name or path) that was current when it was sent (not re-resolved
 * against today's team roster/endpoint list, same reasoning as any other
 * historical text). */
export function parseMentions(body: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  for (const match of body.matchAll(REFERENCE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) segments.push({ type: "text", content: body.slice(lastIndex, index) });
    if (match[1] !== undefined) {
      segments.push({ type: "mention", content: match[1], memberId: match[2] });
    } else {
      segments.push({ type: "endpoint", content: match[3]!, vayoId: match[4] });
    }
    lastIndex = index + match[0].length;
  }
  if (lastIndex < body.length) segments.push({ type: "text", content: body.slice(lastIndex) });
  return segments;
}

export interface MentionTrigger {
  /** Which reference kind is in progress — decided by whichever sigil
   * ("@" or "#") is closest to the cursor. */
  kind: "mention" | "endpoint";
  /** Index of the "@"/"#" that started this in-progress reference. */
  start: number;
  /** Partial text typed so far, after the sigil. */
  query: string;
}

/** Detects an in-progress `@mention` or `#tag` right before the cursor
 * while composing — e.g. typing "@ed" mid-message should show a member
 * dropdown filtered to "ed"; typing "#orders" should show an endpoint
 * dropdown filtered to "orders". Whichever sigil is closer to the cursor
 * wins (only one reference can be "in progress" at a time). Null when the
 * cursor isn't in a triggering position: no sigil before it, or
 * whitespace/newline between the nearest sigil and the cursor (the
 * reference, if any, is already finished/abandoned). */
export function detectMentionTrigger(text: string, cursorIndex: number): MentionTrigger | null {
  const uptoCursor = text.slice(0, cursorIndex);
  const at = uptoCursor.lastIndexOf("@");
  const hash = uptoCursor.lastIndexOf("#");
  const start = Math.max(at, hash);
  if (start === -1) return null;
  const between = uptoCursor.slice(start + 1);
  if (/[\s\n]/.test(between)) return null;
  return { kind: start === hash ? "endpoint" : "mention", start, query: between };
}

/** Replaces the in-progress "@partial"/"#partial" text with the real stored
 * reference token plus a trailing space, and reports where the cursor
 * should land afterward (right after that space). `displayText` is the
 * member's name or the endpoint's path depending on `trigger.kind`. */
export function applyMentionSelection(
  text: string,
  trigger: MentionTrigger,
  displayText: string,
  id: string,
): { text: string; cursorIndex: number } {
  const before = text.slice(0, trigger.start);
  const after = text.slice(trigger.start + 1 + trigger.query.length);
  const token = trigger.kind === "endpoint" ? formatEndpointTagToken(displayText, id) : formatMentionToken(displayText, id);
  return { text: `${before}${token} ${after}`, cursorIndex: before.length + token.length + 1 };
}
