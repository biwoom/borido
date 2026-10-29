import { normalizeBasePath } from "../project/index.js";

const PAGE_TYPES = new Set([
  "text", "text_area", "tree_node", "text_document", "story", "blog", "page",
]);

function issue({ level = "error", code, message, recordId = null, details = {} }) {
  return { level, code, message, record_id: recordId, details };
}

export function internalRecordPath(index, record) {
  if (!record || !PAGE_TYPES.has(record.type)) return null;
  if (record.type === "text") return `/texts/${record.slug}/`;
  if (record.type === "story") return `/stories/${record.slug}/`;
  if (record.type === "blog") return `/blog/${record.slug}/`;
  if (record.type === "page") return `/pages/${record.slug}/`;
  const text = index.records.find((item) => item.id === record.text_id);
  if (!text || !record.area) return null;
  if (record.type === "text_area") return `/texts/${text.slug}/${record.area}/`;
  if (record.type === "tree_node") {
    return `/texts/${text.slug}/${record.area}/nodes/${record.slug}/`;
  }
  return `/texts/${text.slug}/${record.area}/${record.slug}/`;
}

export function withBasePath(internalPath, basePath = "/") {
  const normalized = normalizeBasePath(basePath);
  if (typeof internalPath !== "string" || !internalPath.startsWith("/")) {
    throw new TypeError("Internal URL path must start with /");
  }
  return normalized === "/"
    ? internalPath
    : `${normalized.slice(0, -1)}${internalPath}`;
}

function addUniquePath(entries, diagnostics, entry) {
  const conflict = entries.find((item) => item.internal_path === entry.internal_path);
  if (conflict) {
    diagnostics.push(issue({
      code: "PUBLIC_URL_COLLISION",
      message: "둘 이상의 공개 대상이 같은 URL을 사용합니다.",
      recordId: entry.id,
      details: { path: entry.internal_path, ids: [conflict.id, entry.id] },
    }));
    return;
  }
  entries.push(entry);
}

export function buildUrlIndex({
  index,
  publicRecords,
  basePath = "/",
  baseUrl = null,
}) {
  const diagnostics = [];
  const normalizedBasePath = normalizeBasePath(basePath);
  const records = [...(publicRecords ?? [])];
  const entries = [];

  for (const record of records) {
    if (record.type === "text" && record.slug === "categories") {
      diagnostics.push(issue({
        code: "RESERVED_TEXT_SLUG",
        message: "경론 slug categories는 분류 경로로 예약되어 있습니다.",
        recordId: record.id,
      }));
    }
    if (record.type === "text_document" && record.slug === "nodes") {
      diagnostics.push(issue({
        code: "RESERVED_DOCUMENT_SLUG",
        message: "본문 slug nodes는 구조 노드 경로로 예약되어 있습니다.",
        recordId: record.id,
      }));
    }
    const internalPath = internalRecordPath(index, record);
    if (!internalPath) {
      diagnostics.push(issue({
        code: "PUBLIC_URL_UNRESOLVED",
        message: "공개 레코드의 URL을 계산할 수 없습니다.",
        recordId: record.id,
      }));
      continue;
    }
    addUniquePath(entries, diagnostics, {
      id: record.id,
      type: record.type,
      internal_path: internalPath,
      path: withBasePath(internalPath, normalizedBasePath),
    });
  }

  const referencedSections = new Set(
    records
      .filter((record) => record.type === "text")
      .map((record) => record.data?.canon?.section_id)
      .filter(Boolean),
  );
  for (const taxonomy of index.taxonomies ?? []) {
    for (const section of taxonomy.sections ?? []) {
      if (!referencedSections.has(section.id)) continue;
      const internalPath = `/texts/categories/${section.slug}/`;
      addUniquePath(entries, diagnostics, {
        id: `taxonomy:${taxonomy.canon_id}:${section.id}`,
        type: "taxonomy_section",
        internal_path: internalPath,
        path: withBasePath(internalPath, normalizedBasePath),
      });
    }
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const byInternalPath = new Map(entries.map((entry) => [entry.internal_path, entry]));
  const origin = baseUrl === null ? null : new URL(baseUrl).origin;
  return {
    ok: diagnostics.every((item) => item.level !== "error"),
    base_path: normalizedBasePath,
    base_url: origin,
    entries,
    by_id: byId,
    by_internal_path: byInternalPath,
    diagnostics,
  };
}

function anchorSet(anchorsById, id) {
  const value = anchorsById instanceof Map ? anchorsById.get(id) : anchorsById?.[id];
  return new Set(value ?? []);
}

export function createDocumentResolver(urlIndex, { allRecords = [], anchorsById = {} } = {}) {
  const records = new Map(allRecords.map((record) => [record.id, record]));
  return ({ id, anchor = null }) => {
    const target = records.get(id);
    if (!target) {
      return {
        ok: false,
        code: "DOCUMENT_REFERENCE_MISSING",
        message: "참조한 문서가 없습니다.",
        details: { target_id: id },
      };
    }
    const entry = urlIndex.by_id.get(id);
    if (!entry) {
      return {
        ok: false,
        code: "DOCUMENT_REFERENCE_NOT_PUBLIC",
        message: "참조한 문서는 공개 대상이 아닙니다.",
        details: { target_id: id },
      };
    }
    if (anchor && !anchorSet(anchorsById, id).has(anchor)) {
      return {
        ok: false,
        code: "DOCUMENT_ANCHOR_MISSING",
        message: "참조한 문서에 해당 앵커가 없습니다.",
        details: { target_id: id, anchor },
      };
    }
    return {
      ok: true,
      url: `${entry.path}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`,
    };
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function staticRedirectHtml(targetUrl) {
  const target = escapeHtml(targetUrl);
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="refresh" content="0; url=${target}">`,
    `<link rel="canonical" href="${target}">`,
    '<meta name="robots" content="noindex">',
    "<title>페이지가 이동했습니다</title>",
    "</head>",
    `<body><p>페이지가 이동했습니다. <a href="${target}">새 주소로 이동</a></p></body>`,
    "</html>",
    "",
  ].join("\n");
}

export function buildUrlRedirects(index, urlIndex) {
  const diagnostics = [];
  const redirects = [];
  const seen = new Set();
  const allRecords = new Map(index.records.map((record) => [record.id, record]));

  for (const history of index.url_history ?? []) {
    if (seen.has(history.from)) {
      diagnostics.push(issue({
        code: "URL_HISTORY_DUPLICATE",
        message: "같은 과거 URL이 둘 이상 기록되어 있습니다.",
        details: { from: history.from },
      }));
      continue;
    }
    seen.add(history.from);
    const target = urlIndex.by_id.get(history.target_id);
    if (target && history.from === target.internal_path) {
      diagnostics.push(issue({
        code: "URL_HISTORY_SELF_REDIRECT",
        message: "과거 URL과 현재 URL이 같아 순환합니다.",
        details: { from: history.from, target_id: history.target_id },
      }));
      continue;
    }
    if (urlIndex.by_internal_path.has(history.from)) {
      diagnostics.push(issue({
        code: "URL_HISTORY_CURRENT_COLLISION",
        message: "과거 URL이 현재 공개 URL과 충돌합니다.",
        details: { from: history.from, target_id: history.target_id },
      }));
      continue;
    }
    if (!allRecords.has(history.target_id)) {
      diagnostics.push(issue({
        level: "warning",
        code: "URL_HISTORY_TARGET_MISSING",
        message: "URL 이력 대상이 삭제되었거나 없습니다. 리디렉션을 만들지 않습니다.",
        details: { from: history.from, target_id: history.target_id },
      }));
      continue;
    }
    if (!target) {
      diagnostics.push(issue({
        level: "warning",
        code: "URL_HISTORY_TARGET_NOT_PUBLIC",
        message: "URL 이력 대상이 공개되지 않아 리디렉션을 만들지 않습니다.",
        details: { from: history.from, target_id: history.target_id },
      }));
      continue;
    }
    const from = withBasePath(history.from, urlIndex.base_path);
    redirects.push({
      from,
      internal_from: history.from,
      target_id: history.target_id,
      to: target.path,
      html: staticRedirectHtml(target.path),
    });
  }
  return {
    ok: diagnostics.every((item) => item.level !== "error"),
    redirects,
    diagnostics,
  };
}

export function absolutePublicUrl(urlIndex, path) {
  return urlIndex.base_url ? `${urlIndex.base_url}${path}` : path;
}
