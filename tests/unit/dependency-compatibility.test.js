import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import nunjucks from "nunjucks";
import sanitizeHtml from "sanitize-html";
import { describe, expect, it } from "vitest";

describe("W01 selected dependency combination", () => {
  it("loads the adopted ESM and CommonJS packages together", () => {
    const validate = new Ajv().compile({
      type: "object",
      required: ["title"],
      properties: { title: { type: "string" } },
    });
    const markdown = new MarkdownIt({ html: true }).use(footnote);
    const rendered = markdown.render(
      "# 제목\n\n본문 각주[^1]\n\n[^1]: <script>위험</script>설명",
    );
    const clean = sanitizeHtml(rendered);

    expect(validate({ title: "보리도" })).toBe(true);
    expect(clean).toContain('href="#fn1"');
    expect(clean).toContain('href="#fnref1"');
    expect(clean).not.toContain("<script>");
    expect(nunjucks.renderString("{{ title }}", { title: "보리도" })).toBe(
      "보리도",
    );
  });

  it("resolves the local Basecoat default Vega stylesheet", async () => {
    const stylesheet = fileURLToPath(import.meta.resolve("basecoat-css"));
    const metadata = await stat(stylesheet);

    expect(stylesheet).toMatch(/basecoat(?:\.bundle)?\.css$/);
    expect(metadata.size).toBeGreaterThan(0);
  });
});
