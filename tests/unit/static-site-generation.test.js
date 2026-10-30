import { describe, expect, it } from "vitest";

import { buildUrlIndex, generateStaticSite } from "../../core/content/index.js";

const ids = {
  text: "10000000-0000-4000-8000-000000000001",
  story: "10000000-0000-4000-8000-000000000002",
  blog: "10000000-0000-4000-8000-000000000003",
  page: "10000000-0000-4000-8000-000000000004",
};

function record(id, type, title, slug, data = {}) {
  return { id, type, title, slug, status: "published", order: 0, text_id: type === "text" ? id : null, area: null, data: { description: "", ...data } };
}

describe("W14 page templates and public indexes", () => {
  it("renders every public top-level type, lists, search, sitemap, and local CSS", async () => {
    const records = [
      record(ids.text, "text", "법구경", "dhammapada", { canon: { section_id: "sutra" } }),
      record(ids.story, "story", "황금 이야기", "golden-story", { description: "이야기 설명", source_text: "출처 서지", adapted: true, adaptation_note: "현대어 각색" }),
      record(ids.blog, "blog", "새 소식", "news", { published_at: "2026-10-30T00:00:00Z", tags: ["공지"] }),
      record(ids.page, "page", "소개 <script>", "about", { menu_visible: true, menu_order: 1 }),
    ];
    const index = {
      records,
      taxonomies: [{ canon_id: "taisho", name: "대정신수대장경", sections: [{ id: "sutra", slug: "sutra", name: "경장" }] }],
    };
    const urls = buildUrlIndex({ index, publicRecords: records, basePath: "/borido/", baseUrl: "https://example.test" });
    const markdownById = new Map(records.map((item) => [item.id, { html: `<p>본문 ${item.type}</p>`, toc: [] }]));
    const result = await generateStaticSite({
      site: { site_name: "보리도", description: "자료실", default_language: "ko", author_name: "담진", license: "CC" },
      index,
      publicRecords: records,
      urlIndex: urls,
      markdownById,
    });

    expect(result.ok).toBe(true);
    expect(result.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      "index.html", "texts/dhammapada/index.html", "stories/golden-story/index.html",
      "blog/news/index.html", "pages/about/index.html", "texts/categories/sutra/index.html",
      "texts/index.html", "search/index.html", "search-index.json", "404.html", "robots.txt",
      "assets/site.css", "assets/reader.js", "assets/search.js",
    ]));
    const page = result.files.find((file) => file.path === "pages/about/index.html").content;
    expect(page).toContain("소개 &lt;script&gt;");
    expect(page).not.toContain("소개 <script>");
    expect(page).toContain('href="/borido/assets/site.css"');
    const searchPage = result.files.find((file) => file.path === "search/index.html").content;
    expect(searchPage).toContain('href="/borido/search/" aria-current="page"');
    expect(searchPage).toContain('data-search-index="/borido/search-index.json"');
    expect(result.search.find((item) => item.id === ids.story)).toMatchObject({ text: "본문 story", url: "/borido/stories/golden-story/" });
    expect(result.sitemap_urls).toContain("https://example.test/borido/stories/golden-story/");
    const story = result.files.find((file) => file.path === "stories/golden-story/index.html").content;
    expect(story).toContain("출처 서지");
    expect(story).toContain("현대어 각색");
    expect(story).not.toContain('class="reader-tree"');
    const blog = result.files.find((file) => file.path === "blog/news/index.html").content;
    expect(blog).toContain("2026. 10. 30.");
  });

  it("renders useful empty collection pages without private records", async () => {
    const index = { records: [], taxonomies: [] };
    const urls = buildUrlIndex({ index, publicRecords: [], basePath: "/" });
    const result = await generateStaticSite({
      site: { site_name: "빈 자료실", description: "", default_language: "ko", author_name: "", license: "" },
      index,
      publicRecords: [],
      urlIndex: urls,
    });
    expect(result.files.find((file) => file.path === "stories/index.html").content).toContain("공개된 항목이 없습니다.");
    expect(result.search).toEqual([]);
  });

  it("rejects unknown page template names instead of silently rendering them", async () => {
    const records = [record(ids.page, "page", "소개", "about", { template: "unknown" })];
    const index = { records, taxonomies: [] };
    const result = await generateStaticSite({
      site: { site_name: "보리도", description: "", default_language: "ko", author_name: "", license: "" },
      index, publicRecords: records, urlIndex: buildUrlIndex({ index, publicRecords: records }),
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "STATIC_TEMPLATE_UNSUPPORTED" }));
  });

  it("rejects a redirect that collides with a generated page", async () => {
    const recordValue = record(ids.page, "page", "소개", "about");
    const index = { records: [recordValue], taxonomies: [] };
    const urls = buildUrlIndex({ index, publicRecords: [recordValue] });
    const result = await generateStaticSite({
      site: { site_name: "보리도", description: "", default_language: "ko", author_name: "", license: "" },
      index,
      publicRecords: [recordValue],
      urlIndex: urls,
      redirects: [{ internal_from: "/pages/about/", html: "redirect", target_id: ids.page }],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "STATIC_OUTPUT_COLLISION" }));
  });

  it("builds classification, text overview, area entry, and real breadcrumbs", async () => {
    const areaId = "10000000-0000-4000-8000-000000000005";
    const nodeId = "10000000-0000-4000-8000-000000000006";
    const text = record(ids.text, "text", "법구경", "dhammapada", {
      description: "게송 모음",
      canon: { canon_id: "taisho", section_id: "sutra", catalog_number: "T0210" },
      authors: ["법구"],
    });
    const area = { ...record(areaId, "text_area", "번역", "translation", { area: "translation" }), parent_id: ids.text, text_id: ids.text, area: "translation" };
    const node = { ...record(nodeId, "tree_node", "제1장", "chapter-one", { node_kind: "chapter" }), parent_id: areaId, text_id: ids.text, area: "translation" };
    const records = [text, area, node];
    const index = {
      records,
      taxonomies: [{ canon_id: "taisho", name: "대정신수대장경", tradition: "한역 대장경", sections: [{ id: "sutra", slug: "sutra", name: "경장", description: "경전 분류", order: 1 }] }],
    };
    const urls = buildUrlIndex({ index, publicRecords: records, basePath: "/borido/" });
    const result = await generateStaticSite({
      site: { site_name: "보리도", description: "", default_language: "ko", author_name: "", license: "" },
      index,
      publicRecords: records,
      urlIndex: urls,
      markdownById: new Map(records.map((item) => [item.id, { html: `<p>${item.title} 개요</p>`, toc: [] }])),
    });

    const categoryIndex = result.files.find((file) => file.path === "texts/categories/index.html").content;
    expect(categoryIndex).toContain("대정신수대장경");
    expect(categoryIndex).toContain("경장");
    expect(categoryIndex).toContain("1편");
    const category = result.files.find((file) => file.path === "texts/categories/sutra/index.html").content;
    expect(category).toContain("T0210");
    const textPage = result.files.find((file) => file.path === "texts/dhammapada/index.html").content;
    expect(textPage).toContain("자료 영역");
    expect(textPage).toContain('/borido/texts/dhammapada/translation/');
    expect(textPage).toContain("목록 번호");
    const areaPage = result.files.find((file) => file.path === "texts/dhammapada/translation/index.html").content;
    expect(areaPage).toContain('aria-label="현재 위치"');
    expect(areaPage).toContain("법구경");
    expect(areaPage).toContain('/borido/texts/dhammapada/translation/nodes/chapter-one/');
  });
});
