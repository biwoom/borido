import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import nunjucks from "nunjucks";

import { absolutePublicUrl, withBasePath } from "../url/index.js";
import { AREA_LABELS, buildReaderData } from "./reader.js";
import { createAssetResolver } from "../media/index.js";

const SITE_ROOT = fileURLToPath(new URL("../../site/", import.meta.url));
const TYPE_LABELS = Object.freeze({
  text: "경론",
  text_area: "자료 영역",
  tree_node: "구조",
  text_document: "경론 문서",
  story: "이야기",
  blog: "블로그",
  page: "페이지",
  taxonomy_section: "경론 분류",
});

function outputPathFromInternal(internalPath) {
  if (internalPath === "/") return "index.html";
  return `${internalPath.replace(/^\//u, "").replace(/\/$/u, "")}/index.html`;
}

function plainText(html) {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();
}

function jsonForHtml(value) {
  return `${JSON.stringify(value, null, 2).replaceAll("<", "\\u003c")}\n`;
}

function compareContent(left, right) {
  if (left.type === "blog" && right.type === "blog") {
    const date = String(right.data?.published_at ?? "").localeCompare(
      String(left.data?.published_at ?? ""),
      "en",
    );
    return date || left.id.localeCompare(right.id, "en");
  }
  const order = (left.order ?? 0) - (right.order ?? 0);
  return order || left.title.localeCompare(right.title, "ko") || left.id.localeCompare(right.id, "en");
}

function parentContext(record, recordsById) {
  const text = record.text_id ? recordsById.get(record.text_id) : null;
  return {
    text_title: text?.title ?? null,
    area: record.area ?? null,
  };
}

function menuPages(publicRecords, urlIndex) {
  return publicRecords
    .filter((record) => record.type === "page" && record.data?.menu_visible)
    .sort((left, right) =>
      (left.data.menu_order ?? 0) - (right.data.menu_order ?? 0) ||
      left.id.localeCompare(right.id, "en"),
    )
    .map((record) => ({ key: `page:${record.id}`, title: record.title, url: urlIndex.by_id.get(record.id)?.path }));
}

function fixedPages(basePath) {
  return [
    { key: "home", title: "홈", url: withBasePath("/", basePath) },
    { key: "texts", title: "경론", url: withBasePath("/texts/", basePath) },
    { key: "stories", title: "이야기", url: withBasePath("/stories/", basePath) },
    { key: "blog", title: "블로그", url: withBasePath("/blog/", basePath) },
    { key: "search", title: "검색", url: withBasePath("/search/", basePath) },
  ];
}

function navigationKey(type, id = null) {
  if (["text", "text_area", "tree_node", "text_document", "taxonomy_section"].includes(type)) return "texts";
  if (type === "story") return "stories";
  if (type === "blog") return "blog";
  return type === "page" ? `page:${id}` : "home";
}

function breadcrumb(title, url = null) {
  return { title, url, current: url === null };
}

function recordBreadcrumbs(record, recordsById, urlIndex) {
  const base = [
    breadcrumb("홈", withBasePath("/", urlIndex.base_path)),
    breadcrumb(
      ["story"].includes(record.type) ? "이야기" : record.type === "blog" ? "블로그" : record.type === "page" ? "페이지" : "경론",
      withBasePath(record.type === "story" ? "/stories/" : record.type === "blog" ? "/blog/" : record.type === "page" ? "/pages/" : "/texts/", urlIndex.base_path),
    ),
  ];
  const ancestors = [];
  let parent = record.parent_id ? recordsById.get(record.parent_id) : null;
  while (parent) {
    ancestors.unshift(parent);
    parent = parent.parent_id ? recordsById.get(parent.parent_id) : null;
  }
  for (const ancestor of ancestors) {
    const entry = urlIndex.by_id.get(ancestor.id);
    if (entry) base.push(breadcrumb(ancestor.title, entry.path));
  }
  base.push(breadcrumb(record.title));
  return base;
}

function textMetadata(record, index) {
  if (record.type !== "text") return [];
  const canon = record.data?.canon;
  const taxonomy = (index.taxonomies ?? []).find((item) => item.canon_id === canon?.canon_id);
  const section = taxonomy?.sections?.find((item) => item.id === canon?.section_id);
  const values = [
    ["분류", section?.name],
    ["목록 번호", canon?.catalog_number],
    ["저자", record.data?.authors?.join(", ")],
    ["역자", record.data?.translators?.join(", ")],
    ["원전 언어", record.data?.source_languages?.join(", ")],
    ["판본", record.data?.edition?.name],
    ["디지털 자료", record.data?.source_edition?.source_id],
  ];
  return values.filter(([, value]) => typeof value === "string" && value.trim() !== "").map(([label, value]) => ({ label, value }));
}

function publicChildren(record, publicById, urlIndex) {
  return [...publicById.values()]
    .filter((candidate) => candidate.parent_id === record.id && urlIndex.by_id.has(candidate.id))
    .sort(compareContent)
    .map((candidate) => ({
      title: candidate.title,
      description: candidate.data?.description ?? "",
      type_label: candidate.type === "text_area" ? AREA_LABELS[candidate.area] : TYPE_LABELS[candidate.type],
      url: urlIndex.by_id.get(candidate.id).path,
    }));
}

function featuredImage(record, index, urlIndex) {
  const asset = (index.assets ?? []).find((asset) => asset.id === record.data?.featured_media_id && asset.media_type.startsWith("image/"));
  const resolved = asset && createAssetResolver(index, { basePath: urlIndex.base_path })({ id: asset.id });
  return resolved?.ok ? { url: resolved.url, alt: asset.alt ?? "" } : null;
}

function pageRecord(record, entry, markdown, recordsById, publicById, urlIndex, index, site) {
  const children = publicChildren(record, publicById, urlIndex);
  const page = {
    id: record.id,
    type: record.type,
    type_label: TYPE_LABELS[record.type] ?? record.type,
    title: record.title,
    description: record.data?.description ?? "",
    url: entry.path,
    internal_path: entry.internal_path,
    body_html: markdown?.html ?? "",
    toc: markdown?.toc ?? [],
    footnotes: markdown?.footnotes ?? [],
    published_at: record.data?.published_at ?? null,
    author: record.data?.author ?? null,
    published_label: record.data?.published_at ? new Intl.DateTimeFormat("ko-KR", { timeZone: site.timezone ?? "UTC", dateStyle: "medium" }).format(new Date(record.data.published_at)) : null,
    source_text: record.data?.source_text ?? "",
    sources: (record.data?.sources ?? []).map((source) => ({ ...source, url: /^https?:\/\//iu.test(source.url ?? "") ? source.url : null })),
    adaptation_note: record.data?.adaptation_note ?? (record.data?.adapted ? "각색한 이야기입니다." : ""),
    featured_image: featuredImage(record, index, urlIndex),
    tags: record.data?.tags ?? [],
    nav_key: navigationKey(record.type, record.id),
    breadcrumbs: recordBreadcrumbs(record, recordsById, urlIndex),
    metadata: textMetadata(record, index),
    items: children,
    area_label: AREA_LABELS[record.area] ?? null,
    ...parentContext(record, recordsById),
  };
  page.reader = buildReaderData({
    record,
    publicRecords: [...publicById.values()],
    urlIndex,
    site,
  });
  return page;
}

function taxonomyPage(entry, index, publicRecords, urlIndex) {
  const [, canonId, sectionId] = entry.id.split(":");
  const taxonomy = (index.taxonomies ?? []).find((item) => item.canon_id === canonId);
  const section = taxonomy?.sections?.find((item) => item.id === sectionId);
  const items = publicRecords
    .filter((record) => record.type === "text" && record.data?.canon?.section_id === sectionId)
    .sort(compareContent)
    .map((record) => ({
      title: record.title,
      description: record.data?.description ?? "",
      meta: record.data?.canon?.catalog_number ?? "",
      url: urlIndex.by_id.get(record.id)?.path,
    }));
  return {
    id: entry.id,
    type: "taxonomy_section",
    type_label: TYPE_LABELS.taxonomy_section,
    title: section?.name ?? sectionId,
    description: section?.description ?? taxonomy?.name ?? "",
    url: entry.path,
    internal_path: entry.internal_path,
    items,
    nav_key: "texts",
    breadcrumbs: [
      breadcrumb("홈", withBasePath("/", urlIndex.base_path)),
      breadcrumb("경론", withBasePath("/texts/", urlIndex.base_path)),
      breadcrumb("분류", withBasePath("/texts/categories/", urlIndex.base_path)),
      breadcrumb(section?.name ?? sectionId),
    ],
    metadata: [],
  };
}

function taxonomyIndex(index, publicRecords, urlIndex) {
  const referenced = new Set(publicRecords.filter((record) => record.type === "text").map((record) => record.data?.canon?.section_id).filter(Boolean));
  const groups = (index.taxonomies ?? []).map((taxonomy) => ({
    title: taxonomy.name,
    description: taxonomy.tradition,
    sections: (taxonomy.sections ?? [])
      .filter((section) => referenced.has(section.id))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id, "en"))
      .map((section) => {
        const entry = urlIndex.by_id.get(`taxonomy:${taxonomy.canon_id}:${section.id}`);
        return {
          title: section.name,
          description: section.description ?? "",
          count: publicRecords.filter((record) => record.type === "text" && record.data?.canon?.section_id === section.id).length,
          url: entry?.path,
          source_id: entry?.id,
        };
      }).filter((section) => section.url),
  })).filter((group) => group.sections.length > 0);
  return {
    title: "경론 분류",
    description: "검증된 문헌 분류에 따라 공개 경론을 탐색합니다.",
    url: withBasePath("/texts/categories/", urlIndex.base_path),
    nav_key: "texts",
    breadcrumbs: [breadcrumb("홈", withBasePath("/", urlIndex.base_path)), breadcrumb("경론", withBasePath("/texts/", urlIndex.base_path)), breadcrumb("분류")],
    groups,
  };
}

function sitemapXml(urls) {
  const escape = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) => `  <url><loc>${escape(url)}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
}

export async function generateStaticSite({
  site,
  index,
  publicRecords,
  urlIndex,
  markdownById = new Map(),
  redirects = [],
}) {
  const loader = new nunjucks.FileSystemLoader(join(SITE_ROOT, "templates"), {
    noCache: true,
    watch: false,
  });
  const environment = new nunjucks.Environment(loader, {
    autoescape: true,
    throwOnUndefined: true,
  });
  const render = (template, context) => environment.render(template, context);
  const recordsById = new Map(index.records.map((record) => [record.id, record]));
  const publicById = new Map(publicRecords.map((record) => [record.id, record]));
  const navigation = [
    ...fixedPages(urlIndex.base_path),
    ...menuPages(publicRecords, urlIndex),
  ];
  const common = {
    site: {
      name: site.site_name,
      description: site.description,
      language: site.default_language,
      author: site.author_name,
      license: site.license,
      base_path: urlIndex.base_path,
      stylesheet_url: withBasePath("/assets/site.css", urlIndex.base_path),
      basecoat_url: withBasePath("/assets/basecoat-vega.css", urlIndex.base_path),
    },
    navigation,
  };
  const files = [];
  const pages = [];

  for (const entry of urlIndex.entries) {
    const record = publicById.get(entry.id);
    const page = record
      ? pageRecord(record, entry, markdownById.get(record.id), recordsById, publicById, urlIndex, index, site)
      : taxonomyPage(entry, index, publicRecords, urlIndex);
    pages.push(page);
    files.push({
      path: outputPathFromInternal(entry.internal_path),
      content: render(page.type === "taxonomy_section" ? "list.njk" : page.reader ? "reader.njk" : "content.njk", {
        ...common,
        page,
      }),
      source_ids: record ? [record.id] : page.items.map((item) =>
        publicRecords.find((candidate) => urlIndex.by_id.get(candidate.id)?.path === item.url)?.id,
      ).filter(Boolean),
    });
  }

  const collections = [
    { key: "texts", internal_path: "/texts/", title: "경론", types: ["text"] },
    { key: "stories", internal_path: "/stories/", title: "이야기", types: ["story"] },
    { key: "blog", internal_path: "/blog/", title: "블로그", types: ["blog"] },
    { key: "page", internal_path: "/pages/", title: "페이지", types: ["page"] },
  ];
  for (const collection of collections) {
    const records = publicRecords.filter((record) => collection.types.includes(record.type)).sort(compareContent);
    const page = {
      title: collection.title,
      description: "",
      url: withBasePath(collection.internal_path, urlIndex.base_path),
      nav_key: collection.key,
      breadcrumbs: [breadcrumb("홈", withBasePath("/", urlIndex.base_path)), breadcrumb(collection.title)],
      metadata: [],
      items: records.map((record) => ({
        title: record.title,
        description: record.data?.description ?? "",
        url: urlIndex.by_id.get(record.id)?.path,
        published_at: record.data?.published_at ?? null,
        featured_image: featuredImage(record, index, urlIndex),
        published_label: record.data?.published_at ? new Intl.DateTimeFormat("ko-KR", { timeZone: site.timezone ?? "UTC", dateStyle: "medium" }).format(new Date(record.data.published_at)) : null,
        author: record.data?.author ?? null,
        tags: record.data?.tags ?? [],
      })),
    };
    files.push({
      path: outputPathFromInternal(collection.internal_path),
      content: render("list.njk", { ...common, page }),
      source_ids: records.map((record) => record.id),
    });
  }
  const categoryPage = taxonomyIndex(index, publicRecords, urlIndex);
  files.push({
    path: outputPathFromInternal("/texts/categories/"),
    content: render("taxonomy-index.njk", { ...common, page: categoryPage }),
    source_ids: categoryPage.groups.flatMap((group) => group.sections.map((section) => section.source_id)),
  });
  const recent = publicRecords
    .filter((record) => ["story", "blog", "page"].includes(record.type))
    .sort((left, right) => String(right.data?.published_at ?? right.data?.updated_at ?? "").localeCompare(String(left.data?.published_at ?? left.data?.updated_at ?? ""), "en") || left.id.localeCompare(right.id, "en"))
    .slice(0, 6)
    .map((record) => ({ id: record.id, title: record.title, type_label: TYPE_LABELS[record.type], url: urlIndex.by_id.get(record.id)?.path }));
  files.push({
    path: "index.html",
    content: render("home.njk", {
      ...common,
      page: { title: site.site_name, description: site.description, nav_key: "home", breadcrumbs: [] },
      collections: collections.map((collection) => ({
        title: collection.title,
        url: withBasePath(collection.internal_path, urlIndex.base_path),
        count: publicRecords.filter((record) => collection.types.includes(record.type)).length,
      })).filter((collection) => collection.title !== "페이지" || collection.count > 0),
      categories_url: categoryPage.groups.length > 0 ? categoryPage.url : null,
      recent,
    }),
    source_ids: recent.map((item) => item.id),
  });

  const search = pages
    .filter((page) => page.type !== "taxonomy_section" || page.items.length > 0)
    .map((page) => ({
      id: page.id,
      type: page.type,
      title: page.title,
      url: page.url,
      description: page.description,
      text: plainText(page.body_html),
      text_title: page.text_title ?? null,
      area: page.area ?? null,
    }))
    .sort((left, right) => left.title.localeCompare(right.title, "ko") || left.id.localeCompare(right.id, "en"));
  files.push({ path: "search-index.json", content: jsonForHtml(search), source_ids: search.map((item) => item.id) });
  files.push({ path: "search/index.html", content: render("search.njk", { ...common, page: { title: "검색", nav_key: "search", breadcrumbs: [breadcrumb("홈", withBasePath("/", urlIndex.base_path)), breadcrumb("검색")] }, search_index_url: withBasePath("/search-index.json", urlIndex.base_path) }), source_ids: search.filter((item) => item.id).map((item) => item.id) });
  files.push({ path: "404.html", content: render("404.njk", { ...common, page: { title: "페이지를 찾을 수 없습니다", nav_key: null, breadcrumbs: [breadcrumb("홈", withBasePath("/", urlIndex.base_path)), breadcrumb("페이지를 찾을 수 없습니다")] } }), source_ids: [] });

  const sitemapPaths = [
    ...fixedPages(urlIndex.base_path).map((item) => item.url),
    ...collections.map((collection) => withBasePath(collection.internal_path, urlIndex.base_path)),
    categoryPage.url,
    ...pages.map((page) => page.url),
  ];
  const sitemapUrls = [...new Set(sitemapPaths)]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((path) => absolutePublicUrl(urlIndex, path));
  files.push({ path: "sitemap.xml", content: sitemapXml(sitemapUrls), source_ids: pages.map((page) => page.id) });
  files.push({ path: "assets/site.css", content: await readFile(join(SITE_ROOT, "assets", "site.css"), "utf8"), source_ids: [] });
  files.push({ path: "assets/basecoat-vega.css", content: await readFile(join(SITE_ROOT, "..", "node_modules/basecoat-css/dist/basecoat-vega.cdn.min.css"), "utf8"), source_ids: [] });
  files.push({ path: "assets/reader.js", content: await readFile(join(SITE_ROOT, "assets", "reader.js"), "utf8"), source_ids: [] });
  files.push({ path: "assets/search.js", content: await readFile(join(SITE_ROOT, "assets", "search.js"), "utf8"), source_ids: [] });
  files.push({ path: "robots.txt", content: `User-agent: *\nAllow: ${urlIndex.base_path}\n`, source_ids: [] });

  for (const redirect of redirects) {
    files.push({
      path: outputPathFromInternal(redirect.internal_from),
      content: redirect.html,
      source_ids: [redirect.target_id],
      redirect: true,
    });
  }

  const paths = new Set();
  const diagnostics = publicRecords.filter((record) => record.type === "page" && record.data?.template && record.data.template !== "default").map((record) => ({
    level: "error", code: "STATIC_TEMPLATE_UNSUPPORTED", message: "지원하지 않는 페이지 템플릿입니다. 현재 허용 이름은 default입니다.", details: { id: record.id, template: record.data.template },
  }));
  for (const file of files) {
    if (paths.has(file.path)) {
      diagnostics.push({ level: "error", code: "STATIC_OUTPUT_COLLISION", message: "정적 출력 경로가 중복되었습니다.", details: { path: file.path } });
    }
    paths.add(file.path);
  }
  return {
    ok: diagnostics.length === 0,
    files: files.sort((left, right) => left.path.localeCompare(right.path, "en")),
    pages,
    search,
    sitemap_urls: sitemapUrls,
    diagnostics,
  };
}

export { outputPathFromInternal, plainText };
