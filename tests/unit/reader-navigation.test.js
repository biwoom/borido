import { describe, expect, it } from "vitest";

import { buildReaderData, buildUrlIndex, githubSourceUrl } from "../../core/content/index.js";

const ids = {
  text: "10000000-0000-4000-8000-000000000031",
  translation: "10000000-0000-4000-8000-000000000032",
  chapter: "10000000-0000-4000-8000-000000000033",
  first: "10000000-0000-4000-8000-000000000034",
  second: "10000000-0000-4000-8000-000000000035",
  original: "10000000-0000-4000-8000-000000000036",
  originalOne: "10000000-0000-4000-8000-000000000037",
  originalTwo: "10000000-0000-4000-8000-000000000038",
};

function value(id, type, title, slug, { parent_id = null, area = null, order = 0, related = [] } = {}) {
  return {
    id, type, title, slug, status: "published", parent_id, text_id: type === "text" ? id : ids.text,
    area, order, directory: `content/texts/sample/${slug}`,
    data: { body_file: type === "text_document" ? "body.md" : undefined, related_documents: related },
  };
}

describe("W18 reader tree and document movement", () => {
  const text = value(ids.text, "text", "법구경", "dhammapada");
  const translation = value(ids.translation, "text_area", "번역", "translation", { parent_id: ids.text, area: "translation" });
  const chapter = value(ids.chapter, "tree_node", "제1장", "chapter-one", { parent_id: ids.translation, area: "translation" });
  const first = value(ids.first, "text_document", "첫 문서", "first", { parent_id: ids.chapter, area: "translation", order: 1 });
  const second = value(ids.second, "text_document", "둘째 문서", "second", { parent_id: ids.chapter, area: "translation", order: 2, related: [ids.originalOne] });
  const original = value(ids.original, "text_area", "원문", "original", { parent_id: ids.text, area: "original" });
  const originalOne = value(ids.originalOne, "text_document", "원문 하나", "original-one", { parent_id: ids.original, area: "original" });
  const records = [text, translation, chapter, first, second, original, originalOne];
  const index = { records, taxonomies: [] };
  const urls = buildUrlIndex({ index, publicRecords: records, basePath: "/borido/" });

  it("keeps the current area tree, opens ancestors, and computes DFS previous/next", () => {
    const reader = buildReaderData({ record: second, publicRecords: records, urlIndex: urls, site: {} });
    expect(reader.tree).toHaveLength(1);
    expect(reader.tree[0]).toMatchObject({ id: ids.chapter, open: true });
    expect(reader.tree[0].children.map((item) => item.id)).toEqual([ids.first, ids.second]);
    expect(reader.tree[0].children[1].current).toBe(true);
    expect(reader.previous).toMatchObject({ title: "첫 문서" });
    expect(reader.next).toBeNull();
    expect(JSON.stringify(reader.tree)).not.toContain(ids.originalOne);
  });

  it("uses a single explicit correspondence and never guesses among multiple targets", () => {
    const single = buildReaderData({ record: second, publicRecords: records, urlIndex: urls, site: {} });
    expect(single.areas.find((area) => area.area === "original")).toMatchObject({
      url: `/borido/texts/dhammapada/original/original-one/`, multiple: false,
    });
    const originalTwo = value(ids.originalTwo, "text_document", "원문 둘", "original-two", { parent_id: ids.original, area: "original" });
    const changedSecond = { ...second, data: { ...second.data, related_documents: [ids.originalOne, ids.originalTwo] } };
    const expanded = [...records.filter((item) => item.id !== ids.second), changedSecond, originalTwo];
    const expandedIndex = { records: expanded, taxonomies: [] };
    const expandedUrls = buildUrlIndex({ index: expandedIndex, publicRecords: expanded, basePath: "/borido/" });
    expect(buildReaderData({ record: changedSecond, publicRecords: expanded, urlIndex: expandedUrls, site: {} }).areas.find((area) => area.area === "original")).toMatchObject({
      url: `/borido/texts/dhammapada/original/`, multiple: true,
      choices: [
        { title: "원문 하나", url: "/borido/texts/dhammapada/original/original-one/" },
        { title: "원문 둘", url: "/borido/texts/dhammapada/original/original-two/" },
      ],
    });
  });

  it("shows GitHub source only when public links are explicitly enabled", () => {
    const site = { source_repository: { repository_url: "https://github.com/biwoom/borido.git", branch: "main", public_links: true } };
    expect(githubSourceUrl(site, second)).toBe("https://github.com/biwoom/borido/blob/main/project/content/texts/sample/second/body.md");
    expect(githubSourceUrl({ source_repository: { ...site.source_repository, public_links: false } }, second)).toBeNull();
  });
});
