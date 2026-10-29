import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import {
  applyProjectFileChanges,
  openProject,
  ProjectError,
  readProjectTextFile,
  resolveProjectPath,
  withProjectWriteLock,
} from "../project/index.js";
import { indexProjectContent } from "./indexer.js";
import { sortDiagnostics } from "./diagnostics.js";
import { findIncomingReferences, validateContentReferences } from "./references.js";
import { CONTENT_SCHEMA_VERSION, schemaValidators } from "./schemas.js";

const TOP_LEVEL_TYPES = new Set(["text", "story", "blog", "page"]);
const IMMUTABLE_UPDATE_FIELDS = new Set([
  "schema_version",
  "id",
  "type",
  "slug",
  "created_at",
  "updated_at",
  "body_file",
]);
const AREA_DEFAULTS = Object.freeze([
  { area: "translation", title: "번역", order: 10 },
  { area: "original", title: "원문", order: 20 },
  { area: "research", title: "연구", order: 30 },
]);

function portablePath(path) {
  return path.split(sep).join("/");
}

function timestamp(now) {
  const value = typeof now === "function" ? now() : now ?? new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ProjectError("CONTENT_TIMESTAMP_INVALID", "콘텐츠 시각이 유효하지 않습니다.");
  }
  return date.toISOString();
}

function assertTopLevelType(type) {
  if (!TOP_LEVEL_TYPES.has(type)) {
    throw new ProjectError(
      "CONTENT_TYPE_UNSUPPORTED",
      "기본 CRUD는 text, story, blog, page 유형만 지원합니다.",
      { type: type ?? null },
    );
  }
}

function assertSchema(record) {
  const validator = schemaValidators.records[record.type];
  if (!validator?.(record)) {
    throw new ProjectError(
      "CONTENT_SCHEMA_INVALID",
      "콘텐츠 값이 코드 스키마와 맞지 않습니다.",
      { errors: validator?.errors ?? [] },
    );
  }
}

function defaultCanon() {
  return {
    canon_id: "taisho",
    section_id: null,
    catalog_number: null,
    verification_status: "unverified",
    source_references: [],
  };
}

function textAreaRecords(createdAt, idFactory) {
  return AREA_DEFAULTS.map((areaDefault) => ({
    schema_version: CONTENT_SCHEMA_VERSION,
    id: idFactory(),
    type: "text_area",
    title: areaDefault.title,
    slug: areaDefault.area,
    status: "draft",
    created_at: createdAt,
    updated_at: createdAt,
    order: areaDefault.order,
    area: areaDefault.area,
  }));
}

function assertNewIdsAvailable(index, records, deletedIds = new Set()) {
  const existing = new Set([
    ...index.records.map((record) => record.id),
    ...index.assets.map((asset) => asset.id),
  ]);
  const proposed = new Set();
  for (const record of records) {
    assertSchema(record);
    if (
      existing.has(record.id) ||
      deletedIds.has(record.id) ||
      proposed.has(record.id)
    ) {
      throw new ProjectError(
        "CONTENT_ID_CONFLICT",
        "새 콘텐츠 ID가 프로젝트의 기존 ID와 충돌합니다.",
        { id: record.id },
      );
    }
    proposed.add(record.id);
  }
}

async function deletedContentIds(projectRoot) {
  const trashRoot = join(projectRoot, ".borido", "trash");
  let entries;
  try {
    entries = await readdir(trashRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
  const ids = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(join(trashRoot, entry.name, "manifest.json"), "utf8"),
      );
    } catch {
      throw new ProjectError(
        "CONTENT_DELETE_MANIFEST_INVALID",
        "삭제 기록이 손상되어 새 ID를 안전하게 발급할 수 없습니다.",
        { operation_id: entry.name },
      );
    }
    for (const id of [manifest.target_id, ...(manifest.descendant_ids ?? [])]) {
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

function bodyFileFor(type) {
  return { story: "story.md", blog: "post.md", page: "page.md" }[type] ?? null;
}

function baseRecord({ type, title, slug, fields, createdAt, id }) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new ProjectError(
      "CONTENT_CREATE_FIELDS_INVALID",
      "생성 필드는 객체여야 합니다.",
    );
  }
  const forbidden = Object.keys(fields).filter((field) =>
    ["schema_version", "id", "type", "title", "slug", "status", "created_at", "updated_at", "body_file"].includes(field),
  );
  if (forbidden.length > 0) {
    throw new ProjectError(
      "CONTENT_CREATE_FIELD_FORBIDDEN",
      "생성 시 Core가 관리하는 필드를 직접 지정할 수 없습니다.",
      { fields: forbidden },
    );
  }
  const record = {
    schema_version: CONTENT_SCHEMA_VERSION,
    id,
    type,
    title,
    slug,
    status: "draft",
    created_at: createdAt,
    updated_at: createdAt,
    ...fields,
  };
  const bodyFile = bodyFileFor(type);
  if (bodyFile) record.body_file = bodyFile;
  if (type === "text" && !record.canon) record.canon = defaultCanon();
  return record;
}

function topLevelRelativeDirectory(type, slug, createdAt) {
  if (type === "text") return `content/texts/${slug}`;
  if (type === "story") return `content/stories/${slug}`;
  if (type === "page") return `content/pages/${slug}`;
  return `content/blog/${createdAt.slice(0, 4)}/${slug}`;
}

async function pathExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function assertReferenceDiagnostics(diagnostics) {
  const errors = diagnostics.filter((item) => item.level === "error");
  if (errors.length > 0) {
    throw new ProjectError(
      "CONTENT_REFERENCE_INVALID",
      "콘텐츠 참조가 유효하지 않습니다.",
      { diagnostics: errors },
    );
  }
}

async function assertProposedReferences(index, record) {
  assertReferenceDiagnostics(
    validateContentReferences({
      ...index,
      records: [...index.records, {
        id: record.id,
        type: record.type,
        status: record.status,
        path: "(new)",
        parent_id: null,
        data: record,
      }],
    }),
  );
}

function assertHealthyReport(report) {
  if (!report.ok) {
    throw new ProjectError(
      "CONTENT_PROJECT_INVALID",
      "프로젝트 콘텐츠 오류를 먼저 수정해야 합니다.",
      { diagnostics: report.diagnostics },
    );
  }
}

async function createContentUnlocked({
  root,
  type,
  title,
  slug,
  fields = {},
  body = "",
  overview = null,
  now = () => new Date(),
  idFactory = randomUUID,
  programRoot,
}) {
  assertTopLevelType(type);
  const opened = await openProject({ root, programRoot });
  const report = await indexProjectContent({ root: opened.project.root });
  assertHealthyReport(report);
  const createdAt = timestamp(now);
  const record = baseRecord({
    type,
    title,
    slug,
    fields,
    createdAt,
    id: idFactory(),
  });
  if (type === "text" && overview !== null) {
    if (typeof overview !== "string") {
      throw new ProjectError("CONTENT_BODY_INVALID", "경론 개요는 문자열이어야 합니다.");
    }
    record.body_file = "_index.md";
  }
  if (type !== "text" && typeof body !== "string") {
    throw new ProjectError("CONTENT_BODY_INVALID", "본문은 문자열이어야 합니다.");
  }
  const areaRecords = type === "text" ? textAreaRecords(createdAt, idFactory) : [];
  assertNewIdsAvailable(
    report.index,
    [record, ...areaRecords],
    await deletedContentIds(opened.project.root),
  );
  await assertProposedReferences(report.index, record);
  if (type === "text" && slug === "categories") {
    throw new ProjectError(
      "CONTENT_SLUG_RESERVED",
      "경론 slug로 예약된 categories를 사용할 수 없습니다.",
      { type, slug },
    );
  }
  if (
    report.index.records.some(
      (existing) => existing.type === type && existing.slug === slug,
    )
  ) {
    throw new ProjectError(
      "CONTENT_SLUG_CONFLICT",
      "같은 콘텐츠 유형에서 slug는 중복될 수 없습니다.",
      { type, slug },
    );
  }

  const relativeDirectory = topLevelRelativeDirectory(type, slug, createdAt);
  const targetDirectory = join(opened.project.root, relativeDirectory);
  if (await pathExists(targetDirectory)) {
    throw new ProjectError(
      "CONTENT_SLUG_CONFLICT",
      "같은 저장 위치를 사용하는 콘텐츠가 이미 있습니다.",
      { type, slug, path: relativeDirectory },
    );
  }
  const parent = dirname(targetDirectory);
  await mkdir(parent, { recursive: true });
  const staging = join(parent, `.borido-create-${randomUUID()}`);
  try {
    await mkdir(staging);
    await writeJson(join(staging, "meta.json"), record);
    if (type === "text") {
      if (overview !== null) await writeFile(join(staging, "_index.md"), overview, "utf8");
      for (const area of areaRecords) {
        const areaDirectory = join(staging, area.area);
        await mkdir(areaDirectory);
        await writeJson(join(areaDirectory, "_node.json"), area);
      }
    } else {
      await writeFile(join(staging, record.body_file), body, "utf8");
    }
    await rename(staging, targetDirectory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return readContent({ root: opened.project.root, id: record.id, programRoot });
}

export async function createContent(options) {
  return withProjectWriteLock(options, ({ root }) =>
    createContentUnlocked({ ...options, root }),
  );
}

export async function readContent({ root, id, programRoot }) {
  const report = await indexProjectContent({ root });
  assertHealthyReport(report);
  const found = report.index.records.find((record) => record.id === id);
  if (!found || !TOP_LEVEL_TYPES.has(found.type)) {
    throw new ProjectError("CONTENT_NOT_FOUND", "상위 콘텐츠를 찾을 수 없습니다.", {
      id,
    });
  }
  const metadata = await readProjectTextFile({
    root: report.project.root,
    path: found.path,
    programRoot,
  });
  let body = null;
  if (found.data.body_file) {
    body = await readProjectTextFile({
      root: report.project.root,
      path: portablePath(join(found.directory, found.data.body_file)),
      programRoot,
    });
  }
  return {
    id: found.id,
    type: found.type,
    path: found.path,
    directory: found.directory,
    record: found.data,
    revisions: {
      metadata: metadata.revision,
      body: body?.revision ?? null,
    },
    body: body?.content ?? null,
  };
}

export async function updateContent({
  root,
  id,
  changes = {},
  body,
  expectedRevisions,
  now = () => new Date(),
  programRoot,
}) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new ProjectError(
      "CONTENT_UPDATE_FIELDS_INVALID",
      "수정 필드는 객체여야 합니다.",
    );
  }
  const current = await readContent({ root, id, programRoot });
  if (!expectedRevisions || typeof expectedRevisions.metadata !== "string") {
    throw new ProjectError(
      "PROJECT_REVISION_REQUIRED",
      "콘텐츠 메타데이터 리비전이 필요합니다.",
    );
  }
  const immutable = Object.keys(changes).filter((field) =>
    IMMUTABLE_UPDATE_FIELDS.has(field),
  );
  if (immutable.length > 0) {
    throw new ProjectError(
      "CONTENT_IMMUTABLE_FIELD",
      "ID·유형·slug·생성 시각·본문 매핑은 기본 수정에서 바꿀 수 없습니다.",
      { fields: immutable },
    );
  }
  const record = {
    ...current.record,
    ...changes,
    updated_at: timestamp(now),
  };
  let bodyPath = current.record.body_file
    ? portablePath(join(current.directory, current.record.body_file))
    : null;
  if (body !== undefined && typeof body !== "string") {
    throw new ProjectError("CONTENT_BODY_INVALID", "본문은 문자열이어야 합니다.");
  }
  if (body !== undefined && !bodyPath) {
    if (current.type !== "text") {
      throw new ProjectError("CONTENT_BODY_INVALID", "본문 매핑이 없습니다.");
    }
    record.body_file = "_index.md";
    bodyPath = portablePath(join(current.directory, "_index.md"));
  }
  assertSchema(record);
  const report = await indexProjectContent({ root });
  assertHealthyReport(report);
  await assertProposedReferences(
    {
      ...report.index,
      records: report.index.records.filter((item) => item.id !== id),
    },
    record,
  );
  const fileChanges = [
    {
      path: current.path,
      content: `${JSON.stringify(record, null, 2)}\n`,
      expectedRevision: expectedRevisions.metadata,
    },
  ];
  if (body !== undefined) {
    if (!("body" in expectedRevisions)) {
      throw new ProjectError(
        "PROJECT_REVISION_REQUIRED",
        "본문 수정에는 본문 리비전이 필요합니다.",
      );
    }
    fileChanges.push({
      path: bodyPath,
      content: body,
      expectedRevision: expectedRevisions.body,
    });
  }
  await applyProjectFileChanges({
    root,
    programRoot,
    changes: fileChanges,
    _beforeApply: async ({ index }) => {
      if (index !== 0) return;
      const latest = await indexProjectContent({ root });
      assertHealthyReport(latest);
      await assertProposedReferences(
        {
          ...latest.index,
          records: latest.index.records.filter((item) => item.id !== id),
        },
        record,
      );
    },
  });
  return readContent({ root, id, programRoot });
}

export async function inspectContentDeletion({ root, id, programRoot }) {
  const report = await indexProjectContent({ root });
  assertHealthyReport(report);
  const target = report.index.records.find((record) => record.id === id);
  if (!target || !TOP_LEVEL_TYPES.has(target.type)) {
    throw new ProjectError("CONTENT_NOT_FOUND", "삭제할 상위 콘텐츠가 없습니다.", {
      id,
    });
  }
  const descendants = target.type === "text"
    ? report.index.records.filter((record) => record.text_id === target.id && record.id !== id)
    : [];
  const affectedIds = new Set([target.id, ...descendants.map((record) => record.id)]);
  const references = findIncomingReferences(report.index, affectedIds).filter(
    (reference) => !affectedIds.has(reference.source_id),
  );
  const metadata = await readProjectTextFile({ root, path: target.path, programRoot });
  const summary = {
    target_id: target.id,
    target_type: target.type,
    target_path: target.path,
    directory: target.directory,
    metadata_revision: metadata.revision,
    descendant_ids: descendants.map((record) => record.id).sort(),
    references,
  };
  return {
    ...summary,
    impact_revision: createHash("sha256")
      .update(JSON.stringify(summary))
      .digest("hex"),
  };
}

function assertOperationId(operationId) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      operationId,
    )
  ) {
    throw new ProjectError("CONTENT_DELETE_ID_INVALID", "삭제 작업 ID가 유효하지 않습니다.");
  }
}

async function deleteContentUnlocked({
  root,
  id,
  expectedMetadataRevision,
  expectedImpactRevision,
  operationId = randomUUID(),
  now = () => new Date(),
  programRoot,
}) {
  const opened = await openProject({ root, programRoot });
  const impact = await inspectContentDeletion({ root: opened.project.root, id, programRoot });
  if (
    impact.metadata_revision !== expectedMetadataRevision ||
    impact.impact_revision !== expectedImpactRevision
  ) {
    throw new ProjectError(
      "CONTENT_DELETE_IMPACT_CHANGED",
      "삭제 영향이나 원본이 바뀌어 삭제하지 않았습니다.",
    );
  }
  if (impact.references.length > 0) {
    throw new ProjectError(
      "CONTENT_DELETE_REFERENCED",
      "다른 콘텐츠의 참조를 먼저 수정해야 삭제할 수 있습니다.",
      { references: impact.references },
    );
  }
  assertOperationId(operationId);
  const source = (
    await resolveProjectPath(opened.project.root, impact.directory)
  ).path;
  const trashRoot = join(opened.project.root, ".borido", "trash", operationId);
  const stored = join(trashRoot, "content");
  await mkdir(trashRoot, { recursive: true });
  try {
    await rename(source, stored);
    await writeFile(
      join(trashRoot, "manifest.json"),
      `${JSON.stringify({
        schema_version: 1,
        operation_id: operationId,
        status: "deleted",
        deleted_at: timestamp(now),
        ...impact,
      }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    if (await pathExists(stored)) await rename(stored, source).catch(() => {});
    await rm(trashRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { ok: true, operation_id: operationId, impact };
}

export async function deleteContent(options) {
  return withProjectWriteLock(options, ({ root }) =>
    deleteContentUnlocked({ ...options, root }),
  );
}

async function restoreDeletedContentUnlocked({ root, operationId, programRoot }) {
  assertOperationId(operationId);
  const opened = await openProject({ root, programRoot });
  const trashRoot = join(opened.project.root, ".borido", "trash", operationId);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(trashRoot, "manifest.json"), "utf8"));
  } catch {
    throw new ProjectError(
      "CONTENT_DELETE_NOT_FOUND",
      "삭제 복구 기록을 찾을 수 없습니다.",
      { operation_id: operationId },
    );
  }
  if (manifest.status !== "deleted") {
    throw new ProjectError(
      "CONTENT_DELETE_NOT_RESTORABLE",
      "이미 복구했거나 복구할 수 없는 삭제 작업입니다.",
      { status: manifest.status ?? null },
    );
  }
  if (
    typeof manifest.directory !== "string" ||
    !manifest.directory.startsWith("content/") ||
    typeof manifest.target_id !== "string"
  ) {
    throw new ProjectError(
      "CONTENT_DELETE_MANIFEST_INVALID",
      "삭제 복구 기록이 유효하지 않습니다.",
      { operation_id: operationId },
    );
  }
  const target = (
    await resolveProjectPath(opened.project.root, manifest.directory, {
      mustExist: false,
    })
  ).path;
  if (await pathExists(target)) {
    throw new ProjectError(
      "CONTENT_RESTORE_PATH_CONFLICT",
      "원래 콘텐츠 위치가 사용 중이라 덮어쓰지 않았습니다.",
      { path: manifest.directory },
    );
  }
  const stored = join(trashRoot, "content");
  await rename(stored, target);
  try {
    manifest.status = "restored";
    await writeFile(
      join(trashRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    await rename(target, stored).catch(() => {});
    throw error;
  }
  return readContent({ root: opened.project.root, id: manifest.target_id, programRoot });
}

export async function restoreDeletedContent(options) {
  return withProjectWriteLock(options, ({ root }) =>
    restoreDeletedContentUnlocked({ ...options, root }),
  );
}

export async function getContentProject({ root }) {
  const report = await indexProjectContent({ root });
  const referenceDiagnostics = report.ok
    ? validateContentReferences(report.index)
    : [];
  const diagnostics = sortDiagnostics([
    ...report.diagnostics,
    ...referenceDiagnostics,
  ]);
  const referenceErrors = referenceDiagnostics.filter(
    (item) => item.level === "error",
  ).length;
  const referenceWarnings = referenceDiagnostics.filter(
    (item) => item.level === "warning",
  ).length;
  return {
    ...report,
    ok: report.ok && referenceErrors === 0,
    summary: {
      ...report.summary,
      errors: report.summary.errors + referenceErrors,
      warnings: report.summary.warnings + referenceWarnings,
    },
    diagnostics,
    references_ok: referenceErrors === 0,
  };
}
