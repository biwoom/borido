import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { openProject } from "../project/index.js";
import {
  diagnostic,
  diagnosticsFromSchema,
  sortDiagnostics,
} from "./diagnostics.js";
import { CONTENT_RECORD_TYPES, schemaValidators } from "./schemas.js";
import { validateTextBibliography } from "./taxonomy.js";

const AREA_CODES = new Set(["translation", "original", "research"]);
const INTERNAL_TYPES = new Set(["text_area", "tree_node", "text_document"]);

function portablePath(path) {
  return path.split(sep).join("/");
}

function relativePath(root, path) {
  return portablePath(relative(root, path));
}

async function walk(root, start, diagnostics) {
  const files = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      diagnostics.push(
        diagnostic({
          code: "PROJECT_PATH_UNREADABLE",
          path: relativePath(root, directory),
          message: "프로젝트 경로를 읽을 수 없습니다.",
          details: { reason: error.code ?? "UNKNOWN" },
        }),
      );
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        diagnostics.push(
          diagnostic({
            code: "PROJECT_PATH_SYMLINK_NOT_ALLOWED",
            path: relativePath(root, path),
            message: "콘텐츠 인덱싱은 심볼릭 링크를 따라가지 않습니다.",
          }),
        );
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }

  await visit(start);
  return files;
}

async function readJson(root, path, diagnostics) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    diagnostics.push(
      diagnostic({
        code: "PROJECT_FILE_UNREADABLE",
        path: relativePath(root, path),
        message: "JSON 파일을 읽을 수 없습니다.",
        details: { reason: error.code ?? "UNKNOWN" },
      }),
    );
    return null;
  }
  try {
    return JSON.parse(source);
  } catch {
    diagnostics.push(
      diagnostic({
        code: "INVALID_JSON",
        path: relativePath(root, path),
        message: "유효한 JSON 파일이 아닙니다.",
      }),
    );
    return null;
  }
}

function expectedTopLevelType(parts) {
  if (parts[0] !== "content") return null;
  const filename = parts.at(-1);
  if (parts[1] === "texts" && parts.length === 4 && filename === "meta.json") {
    return "text";
  }
  if (parts[1] === "stories" && parts.length === 4 && filename === "meta.json") {
    return "story";
  }
  if (parts[1] === "pages" && parts.length === 4 && filename === "meta.json") {
    return "page";
  }
  if (parts[1] === "blog" && parts.length >= 4 && filename === "meta.json") {
    return "blog";
  }
  if (parts[1] === "texts" && filename === "_node.json") return "internal";
  return null;
}

function validateRecordDirectory(parts, path, value, diagnostics) {
  const directories = parts.slice(2, -1);
  for (const directory of directories) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(directory)) {
      diagnostics.push(
        diagnostic({
          code: "CONTENT_DIRECTORY_NAME_INVALID",
          path,
          recordId: value.id ?? null,
          message: "콘텐츠 폴더명은 소문자 영문·숫자·하이픈을 사용해야 합니다.",
          details: { directory },
        }),
      );
    }
  }
}

function recordSummary(record, path, directory) {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    slug: record.slug,
    status: record.status,
    order: record.order ?? null,
    path,
    directory,
    parent_id: null,
    text_id: record.type === "text" ? record.id : null,
    area: record.type === "text_area" ? record.area : null,
    data: record,
  };
}

function validateTimestampOrder(record, path, diagnostics) {
  if (
    typeof record.created_at === "string" &&
    typeof record.updated_at === "string" &&
    Number.isFinite(Date.parse(record.created_at)) &&
    Number.isFinite(Date.parse(record.updated_at)) &&
    Date.parse(record.created_at) > Date.parse(record.updated_at)
  ) {
    diagnostics.push(
      diagnostic({
        code: "UPDATED_BEFORE_CREATED",
        path,
        recordId: record.id ?? null,
        field: "updated_at",
        message: "updated_at은 created_at보다 이를 수 없습니다.",
      }),
    );
  }
}

function validateBodyFile(record, absoluteDirectory, allFiles, path, diagnostics) {
  if (!record.body_file) return;
  const bodyPath = portablePath(join(absoluteDirectory, record.body_file));
  if (!allFiles.has(bodyPath)) {
    diagnostics.push(
      diagnostic({
        code: "BODY_FILE_MISSING",
        path,
        recordId: record.id ?? null,
        field: "body_file",
        message: "메타데이터가 가리키는 본문 파일이 없습니다.",
        details: { body_file: record.body_file },
      }),
    );
  }
}

function addDuplicateDiagnostics(items, key, code, diagnostics, message) {
  const groups = new Map();
  for (const item of items) {
    const value = key(item);
    if (value === null || value === undefined) continue;
    const group = groups.get(value) ?? [];
    group.push(item);
    groups.set(value, group);
  }
  for (const [value, group] of groups) {
    if (group.length < 2) continue;
    for (const item of group) {
      diagnostics.push(
        diagnostic({
          code,
          path: item.path,
          recordId: item.id ?? null,
          message,
          details: { value, paths: group.map((entry) => entry.path) },
        }),
      );
    }
  }
}

function resolveHierarchy(records, diagnostics) {
  const byDirectory = new Map(records.map((record) => [record.directory, record]));
  for (const record of records.filter((item) => INTERNAL_TYPES.has(item.type))) {
    const parent = byDirectory.get(portablePath(dirname(record.directory)));
    if (!parent) {
      diagnostics.push(
        diagnostic({
          code: "CONTENT_PARENT_MISSING",
          path: record.path,
          recordId: record.id,
          message: "폴더 구조에서 콘텐츠 부모를 찾을 수 없습니다.",
        }),
      );
      continue;
    }
    record.parent_id = parent.id;
    record.text_id = parent.type === "text" ? parent.id : parent.text_id;
    record.area = record.type === "text_area" ? record.data.area : parent.area;

    const allowedParent =
      (record.type === "text_area" && parent.type === "text") ||
      (["tree_node", "text_document"].includes(record.type) &&
        ["text_area", "tree_node"].includes(parent.type));
    if (!allowedParent) {
      diagnostics.push(
        diagnostic({
          code: "CONTENT_PARENT_INVALID",
          path: record.path,
          recordId: record.id,
          message: "레코드 유형과 폴더 부모의 관계가 올바르지 않습니다.",
          details: { parent_type: parent.type, record_type: record.type },
        }),
      );
    }
  }
}

function validateAreas(records, diagnostics) {
  const areasByText = new Map();
  for (const record of records.filter((item) => item.type === "text_area")) {
    const folder = record.directory.split("/").at(-1);
    if (record.data.area !== folder || record.slug !== record.data.area) {
      diagnostics.push(
        diagnostic({
          code: "TEXT_AREA_CODE_MISMATCH",
          path: record.path,
          recordId: record.id,
          field: "area",
          message: "영역 폴더명, area, slug가 같은 영역 코드여야 합니다.",
          details: { folder, area: record.data.area, slug: record.slug },
        }),
      );
    }
    if (record.text_id) {
      const found = areasByText.get(record.text_id) ?? new Set();
      found.add(record.data.area);
      areasByText.set(record.text_id, found);
    }
  }
  for (const text of records.filter((item) => item.type === "text")) {
    const found = areasByText.get(text.id) ?? new Set();
    for (const area of AREA_CODES) {
      if (!found.has(area)) {
        diagnostics.push(
          diagnostic({
            code: "TEXT_AREA_MISSING",
            path: text.path,
            recordId: text.id,
            field: "area",
            message: "경론에는 translation, original, research 영역이 모두 필요합니다.",
            details: { area },
          }),
        );
      }
    }
  }
}

function validateOrderTies(records, diagnostics) {
  const siblings = new Map();
  for (const record of records.filter((item) => Number.isInteger(item.order))) {
    const key = `${record.parent_id ?? record.type}:${record.order}`;
    const group = siblings.get(key) ?? [];
    group.push(record);
    siblings.set(key, group);
  }
  for (const group of siblings.values()) {
    if (group.length < 2) continue;
    for (const record of group) {
      diagnostics.push(
        diagnostic({
          level: "warning",
          code: "ORDER_TIE",
          path: record.path,
          recordId: record.id,
          field: "order",
          message: "형제 레코드의 order가 같아 ID 순서로 안정 정렬합니다.",
          details: { order: record.order, ids: group.map((item) => item.id).sort() },
        }),
      );
    }
  }
}

async function loadContent(root, diagnostics) {
  const files = await walk(root, join(root, "content"), diagnostics);
  const fileSet = new Set(files.map((path) => portablePath(path)));
  const records = [];

  for (const file of files) {
    const path = relativePath(root, file);
    const parts = path.split("/");
    const filename = parts.at(-1);
    if (!["meta.json", "_node.json"].includes(filename)) continue;
    const expected = expectedTopLevelType(parts);
    if (!expected) {
      diagnostics.push(
        diagnostic({
          code: "CONTENT_RECORD_PATH_INVALID",
          path,
          message: "콘텐츠 레코드 파일이 허용된 폴더 역할과 맞지 않습니다.",
        }),
      );
      continue;
    }
    const value = await readJson(root, file, diagnostics);
    if (!value) continue;
    validateRecordDirectory(parts, path, value, diagnostics);
    const validator = schemaValidators.records[value.type];
    if (!validator || !CONTENT_RECORD_TYPES.includes(value.type)) {
      diagnostics.push(
        diagnostic({
          code: "CONTENT_TYPE_UNSUPPORTED",
          path,
          recordId: value.id ?? null,
          field: "type",
          message: "지원하지 않는 콘텐츠 레코드 유형입니다.",
          details: { type: value.type ?? null },
        }),
      );
      continue;
    }
    if (
      (expected !== "internal" && expected !== value.type) ||
      (expected === "internal" && !INTERNAL_TYPES.has(value.type))
    ) {
      diagnostics.push(
        diagnostic({
          code: "CONTENT_FILE_ROLE_MISMATCH",
          path,
          recordId: value.id ?? null,
          field: "type",
          message: "파일 위치와 콘텐츠 유형이 일치하지 않습니다.",
          details: { expected, actual: value.type },
        }),
      );
    }
    if (!validator(value)) {
      diagnostics.push(
        ...diagnosticsFromSchema(validator.errors, {
          path,
          recordId: value.id ?? null,
        }),
      );
    }
    validateTimestampOrder(value, path, diagnostics);
    validateBodyFile(value, dirname(file), fileSet, path, diagnostics);
    records.push(
      recordSummary(value, path, portablePath(relative(root, dirname(file)))),
    );
  }

  resolveHierarchy(records, diagnostics);
  validateAreas(records, diagnostics);
  validateOrderTies(records, diagnostics);
  addDuplicateDiagnostics(
    records,
    (item) => item.id,
    "DUPLICATE_RECORD_ID",
    diagnostics,
    "프로젝트 안에서 콘텐츠 ID가 중복되었습니다.",
  );
  addDuplicateDiagnostics(
    records.filter((item) => ["text", "story", "blog", "page"].includes(item.type)),
    (item) => `${item.type}:${item.slug}`,
    "DUPLICATE_CONTENT_SLUG",
    diagnostics,
    "같은 콘텐츠 유형 안에서 slug가 중복되었습니다.",
  );
  return records;
}

async function loadMedia(root, projectFiles, diagnostics) {
  const path = join(root, "media", "assets.json");
  if (!projectFiles.has(portablePath(path))) return [];
  const value = await readJson(root, path, diagnostics);
  if (!value) return [];
  if (!schemaValidators.media(value)) {
    diagnostics.push(
      ...diagnosticsFromSchema(schemaValidators.media.errors, {
        path: "media/assets.json",
      }),
    );
  }
  const assets = Array.isArray(value.assets)
    ? value.assets.map((asset, index) => ({
        ...asset,
        path: "media/assets.json",
        index,
      }))
    : [];
  addDuplicateDiagnostics(
    assets,
    (item) => item.id,
    "DUPLICATE_ASSET_ID",
    diagnostics,
    "미디어 자산 ID가 중복되었습니다.",
  );
  addDuplicateDiagnostics(
    assets,
    (item) => item.file_path,
    "DUPLICATE_ASSET_PATH",
    diagnostics,
    "둘 이상의 미디어 자산이 같은 파일을 가리킵니다.",
  );
  for (const asset of assets) {
    if (typeof asset.file_path !== "string") continue;
    const absoluteNative = resolve(root, asset.file_path);
    const mediaRelation = relative(resolve(root, "media"), absoluteNative);
    if (
      mediaRelation === "" ||
      mediaRelation.startsWith(`..${sep}`) ||
      mediaRelation === ".." ||
      isAbsolute(mediaRelation)
    ) {
      diagnostics.push(
        diagnostic({
          code: "ASSET_PATH_OUTSIDE_MEDIA",
          path: "media/assets.json",
          recordId: asset.id ?? null,
          field: `assets.${asset.index}.file_path`,
          message: "미디어 파일 경로는 media/ 폴더 안에 있어야 합니다.",
          details: { file_path: asset.file_path },
        }),
      );
      continue;
    }
    const absolute = portablePath(absoluteNative);
    if (!projectFiles.has(absolute)) {
      diagnostics.push(
        diagnostic({
          code: "ASSET_FILE_MISSING",
          path: "media/assets.json",
          recordId: asset.id ?? null,
          field: `assets.${asset.index}.file_path`,
          message: "등록한 미디어 파일이 없습니다.",
          details: { file_path: asset.file_path },
        }),
      );
    }
  }
  return assets;
}

async function loadTaxonomies(root, diagnostics) {
  const files = await walk(root, join(root, "config", "canons"), diagnostics);
  const taxonomies = [];
  for (const file of files.filter((path) => path.endsWith(".json"))) {
    const path = relativePath(root, file);
    const value = await readJson(root, file, diagnostics);
    if (!value) continue;
    if (!schemaValidators.taxonomy(value)) {
      diagnostics.push(
        ...diagnosticsFromSchema(schemaValidators.taxonomy.errors, { path }),
      );
    }
    const fileCode = file.split(sep).at(-1).replace(/\.json$/u, "");
    if (value.canon_id !== fileCode) {
      diagnostics.push(
        diagnostic({
          code: "CANON_FILE_CODE_MISMATCH",
          path,
          field: "canon_id",
          message: "분류 파일명과 canon_id가 일치해야 합니다.",
          details: { filename: fileCode, canon_id: value.canon_id ?? null },
        }),
      );
    }
    const sections = Array.isArray(value.sections)
      ? value.sections.map((section) => ({ ...section, path }))
      : [];
    for (const section of sections) {
      if (section.canon_id !== value.canon_id) {
        diagnostics.push(
          diagnostic({
            code: "CANON_SECTION_CODE_MISMATCH",
            path,
            field: "sections.canon_id",
            message: "분류 항목의 canon_id가 상위 체계와 일치하지 않습니다.",
            details: { section_id: section.id ?? null },
          }),
        );
      }
    }
    addDuplicateDiagnostics(
      sections,
      (item) => item.id,
      "DUPLICATE_CANON_SECTION_ID",
      diagnostics,
      "분류 항목 ID가 중복되었습니다.",
    );
    addDuplicateDiagnostics(
      sections,
      (item) => item.slug,
      "DUPLICATE_CANON_SECTION_SLUG",
      diagnostics,
      "분류 항목 slug가 중복되었습니다.",
    );
    taxonomies.push({ ...value, path });
  }
  return taxonomies;
}

async function loadSources(root, projectFiles, diagnostics) {
  const sourcePath = join(root, "config", "sources.json");
  if (!projectFiles.has(portablePath(sourcePath))) return [];
  const value = await readJson(root, sourcePath, diagnostics);
  if (!value) return [];
  if (!schemaValidators.sources(value)) {
    diagnostics.push(
      ...diagnosticsFromSchema(schemaValidators.sources.errors, {
        path: "config/sources.json",
      }),
    );
  }
  const providers = Array.isArray(value.providers)
    ? value.providers.map((provider) => ({
        ...provider,
        path: "config/sources.json",
      }))
    : [];
  addDuplicateDiagnostics(
    providers,
    (item) => item.id,
    "DUPLICATE_SOURCE_PROVIDER_ID",
    diagnostics,
    "디지털 판본 제공처 ID가 중복되었습니다.",
  );
  return providers;
}

async function loadUrlHistory(root, projectFiles, diagnostics) {
  const path = join(root, "config", "url-history.json");
  if (!projectFiles.has(portablePath(path))) return [];
  const value = await readJson(root, path, diagnostics);
  if (!value) return [];
  if (!schemaValidators.urlHistory(value)) {
    diagnostics.push(
      ...diagnosticsFromSchema(schemaValidators.urlHistory.errors, {
        path: "config/url-history.json",
      }),
    );
  }
  const entries = Array.isArray(value.entries)
    ? value.entries.map((entry) => ({ ...entry, path: "config/url-history.json" }))
    : [];
  addDuplicateDiagnostics(
    entries,
    (item) => item.from,
    "DUPLICATE_URL_HISTORY_PATH",
    diagnostics,
    "URL 이력의 과거 경로가 중복되었습니다.",
  );
  return entries;
}

export async function indexProjectContent({ root }) {
  const opened = await openProject({ root });
  const projectRoot = opened.project.root;
  const diagnostics = [];

  const supportingFiles = [
    ...(await walk(projectRoot, join(projectRoot, "media"), diagnostics)),
    ...(await walk(projectRoot, join(projectRoot, "config"), diagnostics)),
  ];
  const projectFiles = new Set(supportingFiles.map((path) => portablePath(path)));

  const sitePath = join(projectRoot, "config", "site.json");
  const rawSite = await readJson(projectRoot, sitePath, diagnostics);
  if (rawSite && !schemaValidators.site(rawSite)) {
    diagnostics.push(
      ...diagnosticsFromSchema(schemaValidators.site.errors, {
        path: "config/site.json",
      }),
    );
  }

  if (projectFiles.has(portablePath(join(projectRoot, "config", "content-types.json")))) {
    diagnostics.push(
      diagnostic({
        level: "warning",
        code: "CONTENT_TYPES_POLICY_DEFERRED",
        path: "config/content-types.json",
        message:
          "content-types.json의 편집 정책 필드는 아직 확정되지 않아 W26 전에는 적용하지 않습니다.",
      }),
    );
  }

  const records = await loadContent(projectRoot, diagnostics);
  const assets = await loadMedia(projectRoot, projectFiles, diagnostics);
  const taxonomies = await loadTaxonomies(projectRoot, diagnostics);
  const sources = await loadSources(projectRoot, projectFiles, diagnostics);
  const urlHistory = await loadUrlHistory(projectRoot, projectFiles, diagnostics);

  addDuplicateDiagnostics(
    [
      ...records,
      ...assets.map((asset) => ({ id: asset.id, path: "media/assets.json" })),
    ],
    (item) => item.id,
    "DUPLICATE_PROJECT_UUID",
    diagnostics,
    "콘텐츠와 미디어를 포함한 프로젝트 UUID가 중복되었습니다.",
  );

  const index = { records, assets, taxonomies, sources, url_history: urlHistory };
  const bibliography = validateTextBibliography(index);
  diagnostics.push(...bibliography.diagnostics);

  sortDiagnostics(diagnostics);
  const errors = diagnostics.filter((item) => item.level === "error").length;
  const warnings = diagnostics.filter((item) => item.level === "warning").length;

  return {
    ok: errors === 0,
    project: {
      root: projectRoot,
      settings_revision: opened.project.settings_revision,
    },
    summary: {
      records: records.length,
      assets: assets.length,
      taxonomies: taxonomies.length,
      sources: sources.length,
      url_history_entries: urlHistory.length,
      errors,
      warnings,
    },
    diagnostics,
    publication_blockers: bibliography.blockers,
    index,
  };
}
