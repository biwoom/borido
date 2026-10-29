import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "@playwright/test";

import { buildUrlIndex, generateStaticSite } from "../../core/content/index.js";
import { createSiteSettings, initializeProject } from "../../core/project/index.js";
import { startPreviewServer } from "../../core/preview/server.js";

test("previews home → classification → text → area with direct reload", async ({ page }) => {
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
    const text = {
      id: textId, type: "text", title: "법구경", slug: "dhammapada", status: "published", order: 0,
      parent_id: null, text_id: textId, area: null,
      data: { description: "게송 모음", canon: { canon_id: "taisho", section_id: "sutra", catalog_number: "T0210" }, authors: ["법구"] },
    };
    const area = {
      id: areaId, type: "text_area", title: "번역", slug: "translation", status: "published", order: 0,
      parent_id: textId, text_id: textId, area: "translation", data: { area: "translation" },
    };
    const records = [text, area];
    const index = {
      records,
      taxonomies: [{ canon_id: "taisho", name: "대정신수대장경", tradition: "한역 대장경", sections: [{ id: "sutra", slug: "sutra", name: "경장", description: "경전 분류", order: 1 }] }],
    };
    const urls = buildUrlIndex({ index, publicRecords: records, basePath: "/borido/" });
    const generated = await generateStaticSite({
      site: { site_name: "보리도 검수", description: "공개 사이트 검수", default_language: "ko", author_name: "담진", license: "CC" },
      index,
      publicRecords: records,
      urlIndex: urls,
      markdownById: new Map([[textId, { html: "<p>법구경 개요입니다.</p>", toc: [] }], [areaId, { html: "<p>번역 자료 안내입니다.</p>", toc: [] }]]),
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
    expect(errors).toEqual([]);
  } finally {
    if (preview) await preview.close();
    await rm(parent, { recursive: true, force: true });
  }
});
