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
      record(ids.story, "story", "황금 이야기", "golden-story", { description: "이야기 설명" }),
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
      "texts/index.html", "search-index.json", "sitemap.xml", "assets/site.css",
    ]));
    const page = result.files.find((file) => file.path === "pages/about/index.html").content;
    expect(page).toContain("소개 &lt;script&gt;");
    expect(page).not.toContain("소개 <script>");
    expect(page).toContain('href="/borido/assets/site.css"');
    expect(result.search.find((item) => item.id === ids.story)).toMatchObject({ text: "본문 story", url: "/borido/stories/golden-story/" });
    expect(result.sitemap_urls).toContain("https://example.test/borido/stories/golden-story/");
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
});
