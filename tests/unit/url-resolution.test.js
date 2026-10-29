import { describe, expect, it } from "vitest";

import {
  absolutePublicUrl,
  buildUrlIndex,
  buildUrlRedirects,
  createDocumentResolver,
  renderMarkdown,
  staticRedirectHtml,
  withBasePath,
} from "../../core/content/index.js";

const ids = {
  text: "10000000-0000-4000-8000-000000000001",
  area: "10000000-0000-4000-8000-000000000002",
  document: "10000000-0000-4000-8000-000000000003",
  privateDocument: "10000000-0000-4000-8000-000000000004",
  page: "10000000-0000-4000-8000-000000000005",
};

function records() {
  return [
    { id: ids.text, type: "text", slug: "same", status: "published", data: { canon: { section_id: "section" } } },
    { id: ids.area, type: "text_area", slug: "translation", area: "translation", text_id: ids.text, status: "published", data: {} },
    { id: ids.document, type: "text_document", slug: "chapter", area: "translation", text_id: ids.text, status: "published", data: {} },
    { id: ids.privateDocument, type: "text_document", slug: "private", area: "translation", text_id: ids.text, status: "private", data: {} },
    { id: ids.page, type: "page", slug: "same", status: "published", data: {} },
  ];
}

function contentIndex(history = []) {
  return {
    records: records(),
    taxonomies: [{
      canon_id: "canon",
      sections: [{ id: "section", slug: "same" }],
    }],
    url_history: history,
  };
}

describe("W12 URL resolution and history", () => {
  it("keeps namespaced slugs unique and applies root or repository base paths", () => {
    const index = contentIndex();
    const publicRecords = index.records.filter((record) => record.status === "published");
    const root = buildUrlIndex({ index, publicRecords });
    const repository = buildUrlIndex({
      index,
      publicRecords,
      basePath: "/borido/",
      baseUrl: "https://biwoom.github.io",
    });

    expect(root.ok).toBe(true);
    expect(root.by_id.get(ids.text).path).toBe("/texts/same/");
    expect(root.by_id.get(ids.page).path).toBe("/pages/same/");
    expect(root.by_id.get("taxonomy:canon:section").path).toBe(
      "/texts/categories/same/",
    );
    expect(repository.by_id.get(ids.document).path).toBe(
      "/borido/texts/same/translation/chapter/",
    );
    expect(absolutePublicUrl(repository, repository.by_id.get(ids.document).path)).toBe(
      "https://biwoom.github.io/borido/texts/same/translation/chapter/",
    );
    expect(withBasePath("/search/", "/")).toBe("/search/");
  });

  it("resolves public document IDs and validates anchors", () => {
    const index = contentIndex();
    const publicRecords = index.records.filter((record) => record.status === "published");
    const urls = buildUrlIndex({ index, publicRecords, basePath: "/borido/" });
    const resolver = createDocumentResolver(urls, {
      allRecords: index.records,
      anchorsById: { [ids.document]: ["부분", "fixed"] },
    });

    expect(resolver({ id: ids.document, anchor: "부분" })).toEqual({
      ok: true,
      url: "/borido/texts/same/translation/chapter/#%EB%B6%80%EB%B6%84",
    });
    expect(resolver({ id: ids.privateDocument })).toMatchObject({
      ok: false,
      code: "DOCUMENT_REFERENCE_NOT_PUBLIC",
    });
    expect(resolver({ id: "90000000-0000-4000-8000-000000000001" })).toMatchObject({
      ok: false,
      code: "DOCUMENT_REFERENCE_MISSING",
    });
    expect(resolver({ id: ids.document, anchor: "없음" })).toMatchObject({
      ok: false,
      code: "DOCUMENT_ANCHOR_MISSING",
    });
  });

  it("integrates doc: links with the Markdown renderer", () => {
    const index = contentIndex();
    const publicRecords = index.records.filter((record) => record.status === "published");
    const urls = buildUrlIndex({ index, publicRecords, basePath: "/borido/" });
    const resolveDocument = createDocumentResolver(urls, {
      allRecords: index.records,
      anchorsById: { [ids.document]: ["fixed"] },
    });
    const result = renderMarkdown(`[이동](doc:${ids.document}#fixed)`, {
      resolveDocument,
    });

    expect(result.ok).toBe(true);
    expect(result.html).toContain(
      'href="/borido/texts/same/translation/chapter/#fixed"',
    );
  });

  it("creates direct static redirects for every historical path without mutation", () => {
    const history = [
      { from: "/old/one/", target_id: ids.document, changed_at: "2026-10-29T00:00:00Z" },
      { from: "/old/two/", target_id: ids.document, changed_at: "2026-10-30T00:00:00Z" },
      { from: "/old/private/", target_id: ids.privateDocument, changed_at: "2026-10-30T00:00:00Z" },
      { from: "/old/missing/", target_id: "90000000-0000-4000-8000-000000000001", changed_at: "2026-10-30T00:00:00Z" },
    ];
    const index = contentIndex(history);
    const before = JSON.stringify(index.url_history);
    const publicRecords = index.records.filter((record) => record.status === "published");
    const urls = buildUrlIndex({ index, publicRecords, basePath: "/borido/" });
    const result = buildUrlRedirects(index, urls);

    expect(result.ok).toBe(true);
    expect(result.redirects.map((item) => [item.from, item.to])).toEqual([
      ["/borido/old/one/", "/borido/texts/same/translation/chapter/"],
      ["/borido/old/two/", "/borido/texts/same/translation/chapter/"],
    ]);
    expect(result.redirects[0].html).toContain("새 주소로 이동");
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "URL_HISTORY_TARGET_NOT_PUBLIC",
      "URL_HISTORY_TARGET_MISSING",
    ]);
    expect(JSON.stringify(index.url_history)).toBe(before);
  });

  it("rejects current-path collisions, duplicate history, and self redirects", () => {
    const current = "/texts/same/translation/chapter/";
    const index = contentIndex([
      { from: current, target_id: ids.document },
      { from: "/duplicate/", target_id: ids.document },
      { from: "/duplicate/", target_id: ids.page },
    ]);
    const publicRecords = index.records.filter((record) => record.status === "published");
    const urls = buildUrlIndex({ index, publicRecords });
    const result = buildUrlRedirects(index, urls);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["URL_HISTORY_SELF_REDIRECT", "URL_HISTORY_DUPLICATE"]),
    );
  });

  it("escapes redirect targets and rejects output collisions", () => {
    const html = staticRedirectHtml('/next/?q="<unsafe>');
    expect(html).toContain("&quot;&lt;unsafe&gt;");
    expect(html).not.toContain('q="<unsafe>');

    const index = contentIndex();
    const duplicate = { ...index.records.find((item) => item.id === ids.page), id: "10000000-0000-4000-8000-000000000006" };
    const result = buildUrlIndex({
      index: { ...index, records: [...index.records, duplicate] },
      publicRecords: [...index.records.filter((record) => record.status === "published"), duplicate],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "PUBLIC_URL_COLLISION" }),
    );
  });
});
