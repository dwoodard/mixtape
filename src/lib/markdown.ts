/** A small, safe markdown reader for the DJ's replies. It makes data, never HTML, so nothing a model writes can run. */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong" | "em"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "quote"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { kind: "code"; text: string }
  | { kind: "table"; head: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

const text = (value: string): Inline => ({ kind: "text", text: value });

/** Bold, italic, `code` and [links](url), nested. Anything unclosed stays as plain text. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push(text(plain));
    plain = "";
  };
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^`([^`\n]+)`/))) {
      flush();
      out.push({ kind: "code", text: m[1] });
    } else if ((m = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/))) {
      flush();
      // "**b *c***": the closing run is longer than two, so the extra marks belong to the inside.
      let inner = m[2];
      let length = m[0].length;
      while (source[i + length] === m[1][0]) {
        inner += m[1][0];
        length++;
      }
      out.push({ kind: "strong", children: parseInline(inner) });
      i += length;
      continue;
    } else if ((m = rest.match(/^(\*|_)(?=\S)([^*_\n]*?\S)\1(?![A-Za-z0-9])/)) && (i === 0 || !/[A-Za-z0-9]/.test(source[i - 1]))) {
      flush();
      out.push({ kind: "em", children: parseInline(m[2]) });
    } else if ((m = rest.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)/))) {
      flush();
      out.push({ kind: "link", href: m[2], children: parseInline(m[1]) });
    } else if (rest[0] === "\\" && rest.length > 1 && /[\\`*_{}[\]()#+\-.!|<>~]/.test(rest[1])) {
      plain += rest[1];
      i += 2;
      continue;
    } else {
      plain += rest[0];
      i += 1;
      continue;
    }
    i += m![0].length;
  }
  flush();
  return out;
}

const splitRow = (line: string): string[] => {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
};
const isTableRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
const isTableRow = (line: string) => line.includes("|");

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const startsBlock = (line: string, next?: string) =>
    /^\s*(```|#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(line) ||
    (isTableRow(line) && next !== undefined && isTableRule(next));

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = line.match(/^\s*```/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (or the end)
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, inline: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() !== "" && isTableRow(lines[i])) rows.push(splitRow(lines[i++]).map(parseInline));
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", inline: parseInline(quoted.join("\n")) });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/;
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const start = ordered ? Number(line.match(numbered)![1]) : 1;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = (ordered ? numbered : bullet).exec(lines[i]);
        if (m) {
          items.push(parseInline(ordered ? m[2] : m[1]));
          i++;
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length && !startsBlock(lines[i].trim())) {
          // A wrapped line belongs to the item above.
          items[items.length - 1].push(text(" "), ...parseInline(lines[i].trim()));
          i++;
        } else break;
      }
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && (para.length === 0 || !startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim());
    blocks.push({ kind: "paragraph", inline: parseInline(para.join("\n")) });
  }
  return blocks;
}
