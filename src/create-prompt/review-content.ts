import { sanitizeContent } from "../github/utils/sanitizer";

/** Preserve visible Markdown code while removing hidden HTML comments before prose cleanup. */
export function sanitizeReviewBody(body: string): string {
  let result = "";
  let prose = "";
  let offset = 0;
  /** Flush prose independently from code so HTML sanitization cannot change code syntax. */
  const flush = () => {
    result += sanitizeContent(prose);
    prose = "";
  };
  while (offset < body.length) {
    if (body.startsWith("<!--", offset)) {
      const close = body.indexOf("-->", offset + 4);
      offset = close < 0 ? body.length : close + 3;
      continue;
    }
    if (offset === 0 || body[offset - 1] === "\n") {
      const opening = /^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/.exec(
        body.slice(offset),
      );
      if (opening && !(opening[1]![0] === "`" && opening[2]!.includes("`"))) {
        const delimiter = opening[1]!;
        const closing = new RegExp(
          `^ {0,3}${delimiter[0]}{${delimiter.length},}[\\t ]*\\r?$`,
          "gm",
        );
        closing.lastIndex = offset + opening[0].length;
        const match = closing.exec(body);
        const end = match ? match.index + match[0].length : body.length;
        flush();
        result += body.slice(offset, end);
        offset = end;
        continue;
      }
    }
    if (body[offset] === "`") {
      const delimiter = /^`+/.exec(body.slice(offset))![0];
      const closing = new RegExp(`(?<!\u0060)${delimiter}(?!\u0060)`, "g");
      closing.lastIndex = offset + delimiter.length;
      const match = closing.exec(body);
      if (match) {
        const end = match.index + delimiter.length;
        flush();
        result += body.slice(offset, end);
        offset = end;
        continue;
      }
    }
    prose += body[offset++];
  }
  flush();
  return result;
}
