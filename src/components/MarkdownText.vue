<script setup lang="ts">
import { computed, h, type VNode } from "vue";
import { parseMarkdown, type Block, type Inline } from "../lib/markdown";

const props = defineProps<{ source: string }>();
const blocks = computed(() => parseMarkdown(props.source));

/** Built with render functions, never v-html: the text of a reply can only ever become text. */
function inline(nodes: Inline[]): (VNode | string)[] {
  return nodes.map((n) => {
    switch (n.kind) {
      case "text":
        return n.text;
      case "strong":
        return h("strong", inline(n.children));
      case "em":
        return h("em", inline(n.children));
      case "code":
        return h("code", n.text);
      // Not a real link: the window must never navigate away from the app.
      case "link":
        return h("span", { class: "link", title: n.href }, inline(n.children));
    }
  });
}

function block(b: Block): VNode {
  switch (b.kind) {
    case "heading":
      return h(`h${Math.min(6, b.level + 2)}`, inline(b.inline));
    case "paragraph":
      return h("p", inline(b.inline));
    case "quote":
      return h("blockquote", inline(b.inline));
    case "rule":
      return h("hr");
    case "code":
      return h("pre", h("code", b.text));
    case "list":
      return h(b.ordered ? "ol" : "ul", { start: b.ordered ? b.start : undefined }, b.items.map((item) => h("li", inline(item))));
    case "table":
      return h("div", { class: "table-wrap" }, h("table", [
        h("thead", h("tr", b.head.map((c) => h("th", inline(c))))),
        h("tbody", b.rows.map((r) => h("tr", r.map((c) => h("td", inline(c)))))),
      ]));
  }
}

const Rendered = () => h("div", { class: "md" }, blocks.value.map(block));
</script>

<template>
  <Rendered />
</template>

<style scoped>
.md { user-select: text; -webkit-user-select: text; overflow-wrap: anywhere; }
.md :deep(> :first-child) { margin-top: 0; }
.md :deep(> :last-child) { margin-bottom: 0; }
.md :deep(p), .md :deep(ul), .md :deep(ol), .md :deep(pre), .md :deep(blockquote), .md :deep(.table-wrap) { margin: 0 0 8px; }
.md :deep(h3), .md :deep(h4), .md :deep(h5), .md :deep(h6) { margin: 10px 0 4px; font-size: 13px; font-weight: 700; }
.md :deep(ul), .md :deep(ol) { padding-left: 20px; }
.md :deep(li) { margin: 2px 0; }
.md :deep(code) { font: 12px ui-monospace, Menlo, monospace; background: var(--bg); padding: 1px 4px; border-radius: 4px; }
.md :deep(pre) { background: var(--bg); padding: 8px 10px; border-radius: 6px; overflow-x: auto; }
.md :deep(pre code) { background: none; padding: 0; white-space: pre; }
.md :deep(blockquote) { padding-left: 10px; border-left: 3px solid var(--line); color: var(--muted); white-space: pre-wrap; }
.md :deep(hr) { border: none; border-top: 1px solid var(--line); margin: 8px 0; }
.md :deep(.link) { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.md :deep(.table-wrap) { overflow-x: auto; }
.md :deep(table) { border-collapse: collapse; font-size: 12px; }
.md :deep(th), .md :deep(td) { border: 1px solid var(--line); padding: 3px 8px; text-align: left; vertical-align: top; }
.md :deep(th) { background: var(--panel-3); }
</style>
