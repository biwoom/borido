import { describe, expect, it } from "vitest";

import { automaticAnchor, renderMarkdown } from "../../core/content/index.js";

const documentId = "10000000-0000-4000-8000-000000000004";
const assetId = "20000000-0000-4000-8000-000000000001";

function resolvers() {
  return {
    resolveDocument: ({ id, anchor }) => ({
      ok: true,
      url: `/documents/${id}/${anchor ? `#${anchor}` : ""}`,
    }),
    resolveAsset: ({ id }) => ({ ok: true, url: `/assets/${id}.png` }),
  };
}

describe("W11 Markdown rendering", () => {
  it("preserves multilingual headings and assigns deterministic unique anchors", () => {
    const result = renderMarkdown(
      "## 붓다 佛陀\n\n### Ānāpānasati\n\n## 붓다 佛陀\n\n## 고정 {#fixed-anchor}\n",
      resolvers(),
    );

    expect(result.ok).toBe(true);
    expect(result.toc).toEqual([
      { level: 2, id: "붓다-佛陀", text: "붓다 佛陀" },
      { level: 3, id: "ānāpānasati", text: "Ānāpānasati" },
      { level: 2, id: "붓다-佛陀-2", text: "붓다 佛陀" },
      { level: 2, id: "fixed-anchor", text: "고정" },
    ]);
    expect(result.html).toContain('<h2 id="fixed-anchor">고정</h2>');
    expect(automaticAnchor("Śūnyatā 空")).toBe("śūnyatā-空");
  });

  it("reserves manual anchors and rejects invalid or duplicate manual IDs", () => {
    const reserved = renderMarkdown("## Fixed\n\n## 수동 {#fixed}\n", resolvers());
    expect(reserved.toc.map((item) => item.id)).toEqual(["fixed-2", "fixed"]);

    const invalid = renderMarkdown(
      "## 하나 {#Duplicate}\n\n## 둘 {#same}\n\n## 셋 {#same}\n",
      resolvers(),
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["HEADING_ANCHOR_INVALID", "HEADING_ANCHOR_DUPLICATE"]),
    );
  });

  it("renders first-reference footnote order and repeated backlinks", () => {
    const result = renderMarkdown(
      "본문[^b] 반복[^b] 다음[^a]\n\n[^a]: 첫 정의\n\n[^b]: 두 문단 정의\n\n    둘째 문단\n",
      resolvers(),
    );

    expect(result.ok).toBe(true);
    expect(result.footnotes).toEqual([
      { number: 1, label: "b", references: 2, id: "fn1" },
      { number: 2, label: "a", references: 1, id: "fn2" },
    ]);
    expect(result.html).toContain('id="fnref1"');
    expect(result.html).toContain('id="fnref1:1"');
    expect(result.html).toContain('href="#fnref1:1"');
  });

  it("diagnoses missing, duplicate, unused, nested, and inline footnotes", () => {
    const result = renderMarkdown(
      "없는 각주[^missing] 인라인^[지원 안 함] 사용[^used]\n\n" +
        "[^used]: 중첩[^nested]\n\n[^used]: 중복\n\n[^unused]: 미사용\n\n[^nested]: 정의\n",
      resolvers(),
    );
    const codes = result.diagnostics.map((item) => item.code);

    expect(result.ok).toBe(false);
    expect(codes).toEqual(expect.arrayContaining([
      "FOOTNOTE_DEFINITION_MISSING",
      "FOOTNOTE_DEFINITION_DUPLICATE",
      "FOOTNOTE_DEFINITION_UNUSED",
      "NESTED_FOOTNOTE_UNSUPPORTED",
      "INLINE_FOOTNOTE_UNSUPPORTED",
    ]));
  });

  it("resolves document and asset tokens without leaving internal schemes", () => {
    const result = renderMarkdown(
      `[문서](doc:${documentId}#부분)\n\n![대체 텍스트](asset:${assetId})`,
      resolvers(),
    );

    expect(result.ok).toBe(true);
    expect(result.references).toEqual([
      expect.objectContaining({ kind: "doc", id: documentId, anchor: "부분" }),
      expect.objectContaining({ kind: "asset", id: assetId, context: "image" }),
    ]);
    expect(result.html).toContain(`href="/documents/${documentId}/#부분"`);
    expect(result.html).toContain(`src="/assets/${assetId}.png"`);
    expect(result.html).not.toMatch(/(?:doc|asset):/u);
  });

  it("sanitizes raw HTML and rejects dangerous links and external images", () => {
    const source =
      "<script>alert(1)</script><img src=x onerror=alert(1)>\n\n" +
      "[위험](javascript:alert(1)) ![원격](https://tracker.example/pixel.png)\n\n" +
      "[안전](https://example.com/)";
    const result = renderMarkdown(source, resolvers());

    expect(result.ok).toBe(false);
    expect(result.html).not.toContain("<script>");
    expect(result.html).not.toContain("onerror");
    expect(result.html).not.toContain("javascript:");
    expect(result.html).toContain('href="https://example.com/"');
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["MARKDOWN_LINK_UNSAFE", "EXTERNAL_IMAGE_UNSUPPORTED"]),
    );
  });

  it("does not mutate the Markdown source", () => {
    const source = "## 제목\n\n본문[^n]\n\n[^n]: 각주\n";
    const before = source.slice();
    renderMarkdown(source, resolvers());
    expect(source).toBe(before);
  });
});
