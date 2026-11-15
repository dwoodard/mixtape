import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

describe("inline", () => {
  it("reads bold, italic, code and links, nested", () => {
    expect(parseInline("a **b *c*** `d` [e](http://x)")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", children: [{ kind: "text", text: "b " }, { kind: "em", children: [{ kind: "text", text: "c" }] }] },
      { kind: "text", text: " " },
      { kind: "code", text: "d" },
      { kind: "text", text: " " },
      { kind: "link", href: "http://x", children: [{ kind: "text", text: "e" }] },
    ]);
  });

  it("leaves unclosed markers and snake_case words alone", () => {
    expect(parseInline("2 * 3 and snake_case_name and **open")).toEqual([{ kind: "text", text: "2 * 3 and snake_case_name and **open" }]);
  });

  it("keeps markdown characters inside code literal", () => {
    expect(parseInline("`**no**`")).toEqual([{ kind: "code", text: "**no**" }]);
  });

  it("treats html as plain text, never as markup", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([{ kind: "text", text: "<img src=x onerror=alert(1)>" }]);
  });
});

describe("blocks", () => {
  it("splits paragraphs, headings and rules", () => {
    const blocks = parseMarkdown("# Title\n\nOne\ntwo\n\n---\n\nThree");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "rule", "paragraph"]);
    expect(blocks[1]).toMatchObject({ inline: [{ kind: "text", text: "One\ntwo" }] });
  });

  it("reads bullet and numbered lists, with a wrapped line and a start number", () => {
    const [bullets, numbers] = parseMarkdown("- a\n- b\n  more\n\n3. x\n4. y");
    expect(bullets).toMatchObject({ kind: "list", ordered: false });
    expect((bullets as { items: unknown[] }).items).toHaveLength(2);
    expect(numbers).toMatchObject({ kind: "list", ordered: true, start: 3 });
  });

  it("keeps a code fence verbatim, even when unclosed", () => {
    expect(parseMarkdown("```ts\nlet a = 1;\n- not a list\n```")).toEqual([{ kind: "code", text: "let a = 1;\n- not a list" }]);
    expect(parseMarkdown("```\nopen")).toEqual([{ kind: "code", text: "open" }]);
  });

  it("reads a table with a header and rows", () => {
    const [table] = parseMarkdown("| Song | Year |\n|---|:---:|\n| Halo | 2008 |\n| Blue Monday | 1983 |");
    expect(table.kind).toBe("table");
    expect((table as { head: unknown[]; rows: unknown[] }).head).toHaveLength(2);
    expect((table as { rows: unknown[] }).rows).toHaveLength(2);
  });

  it("ends a paragraph where a list starts", () => {
    expect(parseMarkdown("Here:\n- a\n- b").map((b) => b.kind)).toEqual(["paragraph", "list"]);
  });

  it("reads quotes and ignores blank input", () => {
    expect(parseMarkdown("> hi\n> there")).toEqual([{ kind: "quote", inline: [{ kind: "text", text: "hi\nthere" }] }]);
    expect(parseMarkdown("  \n\n")).toEqual([]);
  });
});
