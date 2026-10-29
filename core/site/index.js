import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import nunjucks from "nunjucks";

import { absolutePublicUrl, withBasePath } from "../url/index.js";

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
    if (date) return date;
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
    .map((record) => ({ title: record.title, url: urlIndex.by_id.get(record.id)?.path }));
}

function fixedPages(basePath) {
  return [
    { title: "홈", url: withBasePath("/", basePath) },
    { title: "경론", url: withBasePath("/texts/", basePath) },
    { title: "이야기", url: withBasePath("/stories/", basePath) },
    { title: "블로그", url: withBasePath("/blog/", basePath) },
    { title: "페이지", url: withBasePath("/pages/", basePath) },
  ];
}

function pageRecord(record, entry, markdown, recordsById) {
  return {
    id: record.id,
    type: record.type,
    type_label: TYPE_LABELS[record.type] ?? record.type,
    title: record.title,
    description: record.data?.description ?? "",
    url: entry.path,
    internal_path: entry.internal_path,
    body_html: markdown?.html ?? "",
    toc: markdown?.toc ?? [],
    published_at: record.data?.published_at ?? null,
    author: record.data?.author ?? null,
    tags: record.data?.tags ?? [],
    ...parentContext(record, recordsById),
  };
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
      url: urlIndex.by_id.get(record.id)?.path,
    }));
  return {
    id: entry.id,
    type: "taxonomy_section",
    type_label: TYPE_LABELS.taxonomy_section,
    title: section?.name ?? sectionId,
    description: taxonomy?.name ?? "",
    url: entry.path,
    internal_path: entry.internal_path,
    items,
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
  const navigation = [...fixedPages(urlIndex.base_path), ...menuPages(publicRecords, urlIndex)];
  const common = {
    site: {
      name: site.site_name,
      description: site.description,
      language: site.default_language,
      author: site.author_name,
      license: site.license,
      base_path: urlIndex.base_path,
      stylesheet_url: withBasePath("/assets/site.css", urlIndex.base_path),
    },
    navigation,
  };
  const files = [];
  const pages = [];

  for (const entry of urlIndex.entries) {
    const record = publicById.get(entry.id);
    const page = record
      ? pageRecord(record, entry, markdownById.get(record.id), recordsById)
      : taxonomyPage(entry, index, publicRecords, urlIndex);
    pages.push(page);
    files.push({
      path: outputPathFromInternal(entry.internal_path),
      content: render(page.type === "taxonomy_section" ? "list.njk" : "content.njk", {
        ...common,
        page,
      }),
      source_ids: record ? [record.id] : page.items.map((item) =>
        publicRecords.find((candidate) => urlIndex.by_id.get(candidate.id)?.path === item.url)?.id,
      ).filter(Boolean),
    });
  }

  const collections = [
    { internal_path: "/texts/", title: "경론", types: ["text"] },
    { internal_path: "/stories/", title: "이야기", types: ["story"] },
    { internal_path: "/blog/", title: "블로그", types: ["blog"] },
    { internal_path: "/pages/", title: "페이지", types: ["page"] },
  ];
  for (const collection of collections) {
    const records = publicRecords.filter((record) => collection.types.includes(record.type)).sort(compareContent);
    const page = {
      title: collection.title,
      description: "",
      url: withBasePath(collection.internal_path, urlIndex.base_path),
      items: records.map((record) => ({
        title: record.title,
        description: record.data?.description ?? "",
        url: urlIndex.by_id.get(record.id)?.path,
      })),
    };
    files.push({
      path: outputPathFromInternal(collection.internal_path),
      content: render("list.njk", { ...common, page }),
      source_ids: records.map((record) => record.id),
    });
  }
  files.push({
    path: "index.html",
    content: render("home.njk", {
      ...common,
      page: { title: site.site_name, description: site.description },
      collections: collections.map((collection) => ({
        title: collection.title,
        url: withBasePath(collection.internal_path, urlIndex.base_path),
        count: publicRecords.filter((record) => collection.types.includes(record.type)).length,
      })),
    }),
    source_ids: [],
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

  const sitemapPaths = [
    ...fixedPages(urlIndex.base_path).map((item) => item.url),
    ...pages.map((page) => page.url),
  ];
  const sitemapUrls = [...new Set(sitemapPaths)]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((path) => absolutePublicUrl(urlIndex, path));
  files.push({ path: "sitemap.xml", content: sitemapXml(sitemapUrls), source_ids: pages.map((page) => page.id) });
  files.push({ path: "assets/site.css", content: await readFile(join(SITE_ROOT, "assets", "site.css"), "utf8"), source_ids: [] });

  for (const redirect of redirects) {
    files.push({
      path: outputPathFromInternal(redirect.internal_from),
      content: redirect.html,
      source_ids: [redirect.target_id],
      redirect: true,
    });
  }

  const paths = new Set();
  const diagnostics = [];
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
