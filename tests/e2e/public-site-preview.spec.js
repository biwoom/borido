import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "@playwright/test";

import { buildUrlIndex, generateStaticSite } from "../../core/content/index.js";
import { createSiteSettings, initializeProject } from "../../core/project/index.js";
import { startPreviewServer } from "../../core/preview/server.js";

test("previews classification and reads documents through the current area tree", async ({ page }) => {
  const parent = await mkdtemp(join(tmpdir(), "borido-w17-browser-"));
  let preview;
  try {
    const root = join(parent, "site");
    await initializeProject({
      root,
      settings: createSiteSettings({ siteName: "보리도 검수", description: "공개 사이트 검수", defaultLanguage: "ko", timezone: "Asia/Seoul", publicUrl: "https://example.test/borido/" }),
    });
    const textId = "10000000-0000-4000-8000-000000000021";
    const areaId = "10000000-0000-4000-8000-000000000022";
    const chapterId = "10000000-0000-4000-8000-000000000023";
    const firstId = "10000000-0000-4000-8000-000000000024";
    const secondId = "10000000-0000-4000-8000-000000000025";
    const originalAreaId = "10000000-0000-4000-8000-000000000026";
    const originalDocumentId = "10000000-0000-4000-8000-000000000027";
    const text = {
      id: textId, type: "text", title: "법구경", slug: "dhammapada", status: "published", order: 0,
      parent_id: null, text_id: textId, area: null,
      directory: "content/texts/dhammapada",
      data: { description: "게송 모음", canon: { canon_id: "taisho", section_id: "sutra", catalog_number: "T0210" }, authors: ["법구"] },
    };
    const area = {
      id: areaId, type: "text_area", title: "번역", slug: "translation", status: "published", order: 0,
      parent_id: textId, text_id: textId, area: "translation", directory: "content/texts/dhammapada/translation", data: { area: "translation" },
    };
    const chapter = { id: chapterId, type: "tree_node", title: "제1장", slug: "chapter-one", status: "published", order: 0, parent_id: areaId, text_id: textId, area: "translation", directory: "content/texts/dhammapada/translation/chapter-one", data: { node_kind: "chapter" } };
    const first = { id: firstId, type: "text_document", title: "첫 문서", slug: "first", status: "published", order: 1, parent_id: chapterId, text_id: textId, area: "translation", directory: "content/texts/dhammapada/translation/chapter-one/first", data: { body_file: "body.md" } };
    const second = { id: secondId, type: "text_document", title: "둘째 문서", slug: "second", status: "published", order: 2, parent_id: chapterId, text_id: textId, area: "translation", directory: "content/texts/dhammapada/translation/chapter-one/second", data: { body_file: "body.md", related_documents: [originalDocumentId] } };
    const originalArea = { id: originalAreaId, type: "text_area", title: "원문", slug: "original", status: "published", order: 1, parent_id: textId, text_id: textId, area: "original", directory: "content/texts/dhammapada/original", data: { area: "original" } };
    const originalDocument = { id: originalDocumentId, type: "text_document", title: "원문 문서", slug: "root-text", status: "published", order: 1, parent_id: originalAreaId, text_id: textId, area: "original", directory: "content/texts/dhammapada/original/root-text", data: { body_file: "body.md", related_documents: [secondId] } };
    const records = [text, area, chapter, first, second, originalArea, originalDocument];
    const index = {
      records,
      taxonomies: [{ canon_id: "taisho", name: "대정신수대장경", tradition: "한역 대장경", sections: [{ id: "sutra", slug: "sutra", name: "경장", description: "경전 분류", order: 1 }] }],
    };
    const urls = buildUrlIndex({ index, publicRecords: records, basePath: "/borido/" });
    const generated = await generateStaticSite({
      site: { site_name: "보리도 검수", description: "공개 사이트 검수", default_language: "ko", author_name: "담진", license: "CC", source_repository: { repository_url: "https://github.com/biwoom/borido.git", branch: "main", public_links: true } },
      index,
      publicRecords: records,
      urlIndex: urls,
      markdownById: new Map(records.map((record) => [record.id, {
        html: record.id === firstId
          ? '<h2 id="opening">첫 부분</h2><p>첫 문서 내용입니다.<sup class="footnote-ref"><a href="#fn1" id="fnref1">1</a></sup></p><section class="footnotes"><ol><li id="fn1"><p>각주 내용 <a href="#fnref1">↩</a></p></li></ol></section>'
          : `<p>${record.title} 내용입니다.</p>`,
        toc: record.id === firstId ? [{ id: "opening", title: "첫 부분", level: 2 }] : [],
        footnotes: record.id === firstId ? [{ id: "fn1", number: 1, label: "각주 내용" }] : [],
      }])),
    });
    for (const file of generated.files) {
      const path = join(root, "dist", file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }
    preview = await startPreviewServer({ root });
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

    await page.goto(preview.url);
    await expect(page.getByRole("heading", { level: 1, name: "보리도 검수" })).toBeVisible();
    await page.getByRole("link", { name: "경론 분류에서 시작하기" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "경론 분류" })).toBeVisible();
    await page.getByRole("link", { name: "경장" }).click();
    await page.getByRole("link", { name: "법구경" }).click();
    await expect(page.getByText("T0210")).toBeVisible();
    await page.getByRole("link", { name: "번역" }).click();
    await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText("법구경");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "번역" })).toBeVisible();
    await expect(page.locator('header a[aria-current="page"]')).toContainText("경론");
    await expect(page.getByRole("navigation", { name: "현재 자료 트리" })).toContainText("제1장");
    await page.getByText("제1장", { exact: true }).click();
    await page.getByRole("link", { name: "첫 문서" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "첫 문서" })).toBeVisible();
    await expect(page.locator('.reader-tree a[aria-current="page"]')).toHaveText("첫 문서");
    await page.getByRole("button", { name: "목차" }).click();
    await expect(page.locator(".reader-panel")).toContainText("첫 부분");
    await page.getByRole("button", { name: "닫기" }).click();
    await page.getByRole("button", { name: "각주" }).click();
    await expect(page.locator(".reader-panel")).toContainText("각주 내용");
    await page.getByRole("button", { name: "닫기" }).click();
    await expect(page.locator(".prose .footnotes")).toContainText("각주 내용");
    await page.locator(".footnote-ref a").click();
    await expect(page.locator(".reader-panel .footnotes")).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
    await expect(page.locator(".prose .footnotes")).toContainText("각주 내용");
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await expect(page.locator(".reader-panel .footnotes")).toBeVisible();
    await page.locator(".reader-panel .footnotes a").click();
    await expect(page.locator(".reader-panel")).toBeHidden();
    await expect(page.locator(".footnote-ref a")).toBeFocused();
    await page.evaluate(() => { location.hash = "#fn1"; });
    await expect(page.locator(".reader-panel .footnotes")).toBeVisible();
    await page.getByRole("button", { name: "닫기" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole("navigation", { name: "현재 자료 트리" })).toBeHidden();
    await page.getByRole("button", { name: "자료 트리" }).click();
    await expect(page.getByRole("navigation", { name: "현재 자료 트리" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("navigation", { name: "현재 자료 트리" })).toBeHidden();
    await page.getByRole("button", { name: "목차" }).click();
    await expect(page.getByRole("button", { name: "패널 닫기" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".reader-panel")).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator(".document-pagination .next").click();
    await expect(page.getByRole("heading", { level: 1, name: "둘째 문서" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "문서 이동" })).toContainText("첫 문서");
    await expect(page.getByRole("link", { name: "GitHub에서 원본 보기" })).toHaveAttribute("href", /github\.com\/biwoom\/borido\/blob\/main/);
    await page.getByRole("navigation", { name: "자료 영역" }).getByRole("link", { name: "원문" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "원문 문서" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "현재 자료 트리" })).not.toContainText("첫 문서");
    await page.getByRole("link", { name: "검색", exact: true }).click();
    await page.getByRole("searchbox").fill("둘째 문서");
    await page.getByRole("button", { name: "검색" }).click();
    await expect(page.locator(".search-results")).toContainText("둘째 문서");
    expect(errors).toEqual([]);
    const missingResponse = await page.goto(`${preview.url}missing/`);
    expect(missingResponse.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "페이지를 찾을 수 없습니다" })).toBeVisible();
  } finally {
    if (preview) await preview.close();
    await rm(parent, { recursive: true, force: true });
  }
});
