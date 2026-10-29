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
import { basename, dirname, join, sep } from "node:path";

import {
  applyProjectFileChanges,
  fileRevision,
  openProject,
  ProjectError,
  readProjectTextFile,
  resolveProjectPath,
  withProjectWriteLock,
} from "../project/index.js";
import { indexProjectContent } from "./indexer.js";
import { findIncomingReferences, validateContentReferences } from "./references.js";
import { CONTENT_SCHEMA_VERSION, schemaValidators } from "./schemas.js";

const MUTABLE_TREE_TYPES = new Set(["tree_node", "text_document"]);

function assertOperationId(operationId) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      operationId,
    )
  ) {
    throw new ProjectError("TREE_OPERATION_ID_INVALID", "트리 작업 ID가 유효하지 않습니다.");
  }
}

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

async function pathExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path, content) {
  const temporary = join(dirname(path), `.borido-tree-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function assertHealthy(report) {
  if (!report.ok) {
    throw new ProjectError(
      "CONTENT_PROJECT_INVALID",
      "트리 변경 전에 프로젝트 콘텐츠 오류를 수정해야 합니다.",
      { diagnostics: report.diagnostics },
    );
  }
}

function recordById(index, id, message = "트리 레코드를 찾을 수 없습니다.") {
  const record = index.records.find((item) => item.id === id);
  if (!record) throw new ProjectError("TREE_RECORD_NOT_FOUND", message, { id });
  return record;
}

function assertMutable(record) {
  if (!MUTABLE_TREE_TYPES.has(record.type)) {
    throw new ProjectError(
      "TREE_RECORD_TYPE_UNSUPPORTED",
      "W10 변경 대상은 구조 노드와 본문 문서입니다.",
      { id: record.id, type: record.type },
    );
  }
}

function assertParent(parent) {
  if (!["text_area", "tree_node"].includes(parent.type)) {
    throw new ProjectError(
      "TREE_PARENT_INVALID",
      "트리 부모는 자료 영역 또는 구조 노드여야 합니다.",
      { id: parent.id, type: parent.type },
    );
  }
}

function descendants(index, record) {
  const result = [];
  const queue = [record.id];
  while (queue.length > 0) {
    const parentId = queue.shift();
    for (const child of index.records.filter((item) => item.parent_id === parentId)) {
      result.push(child);
      queue.push(child.id);
    }
  }
  return result;
}

function textFor(index, record) {
  return record.type === "text"
    ? record
    : index.records.find((item) => item.id === record.text_id);
}

export function treeRecordUrl(index, record, overrides = {}) {
  const text = overrides.text ?? textFor(index, record);
  const area = overrides.area ?? record.area;
  if (!text || !area) return null;
  if (record.type === "text_area") return `/texts/${text.slug}/${area}/`;
  if (record.type === "tree_node") {
    return `/texts/${text.slug}/${area}/nodes/${record.slug}/`;
  }
  if (record.type === "text_document") {
    return `/texts/${text.slug}/${area}/${record.slug}/`;
  }
  return null;
}

function moveImpact(index, record, newParent) {
  assertMutable(record);
  assertParent(newParent);
  const moved = [record, ...descendants(index, record)];
  if (moved.some((item) => item.id === newParent.id)) {
    throw new ProjectError(
      "TREE_MOVE_INTO_DESCENDANT",
      "구조를 자기 자신이나 자기 하위로 이동할 수 없습니다.",
      { id: record.id, parent_id: newParent.id },
    );
  }
  if (record.type === "text_document" && descendants(index, record).length > 0) {
    throw new ProjectError(
      "TREE_DOCUMENT_HAS_CHILDREN",
      "본문 문서는 자식을 가진 채 이동할 수 없습니다.",
      { id: record.id },
    );
  }
  const newText = textFor(index, newParent);
  const newArea = newParent.area;
  const movedIds = new Set(moved.map((item) => item.id));
  const conflicts = [];
  for (const movedItem of moved) {
    if (!MUTABLE_TREE_TYPES.has(movedItem.type)) continue;
    for (const candidate of index.records) {
      if (
        !movedIds.has(candidate.id) &&
        candidate.type === movedItem.type &&
        candidate.text_id === newText?.id &&
        candidate.area === newArea &&
        candidate.slug === movedItem.slug
      ) {
        conflicts.push({ moved_id: movedItem.id, conflict_id: candidate.id });
      }
    }
  }
  if (conflicts.length > 0) {
    throw new ProjectError(
      "TREE_SLUG_CONFLICT",
      "대상 경론·영역에 같은 유형의 slug가 이미 있습니다.",
      { id: record.id, conflicts },
    );
  }
  return moved.map((item) => {
    const oldUrl = treeRecordUrl(index, item);
    const newUrl = treeRecordUrl(index, item, { text: newText, area: newArea });
    return {
      id: item.id,
      type: item.type,
      old_url: oldUrl,
      new_url: newUrl,
      url_changed: oldUrl !== newUrl,
    };
  });
}

function impactHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function inspectTreeMove({ root, id, newParentId, programRoot }) {
  const report = await indexProjectContent({ root });
  assertHealthy(report);
  const record = recordById(report.index, id);
  const parent = recordById(report.index, newParentId, "이동할 새 부모가 없습니다.");
  const metadata = await readProjectTextFile({
    root: report.project.root,
    path: record.path,
    programRoot,
  });
  const targetDirectory = portablePath(join(parent.directory, basename(record.directory)));
  const summary = {
    operation: "move",
    target_id: id,
    source_directory: record.directory,
    target_directory: targetDirectory,
    old_parent_id: record.parent_id,
    new_parent_id: newParentId,
    metadata_revision: metadata.revision,
    affected: moveImpact(report.index, record, parent),
  };
  return { ...summary, impact_revision: impactHash(summary) };
}

async function readUrlHistory(root) {
  const path = join(root, "config", "url-history.json");
  try {
    const content = await readFile(path, "utf8");
    return { exists: true, path, content, revision: fileRevision(content), value: JSON.parse(content) };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        exists: false,
        path,
        content: null,
        revision: null,
        value: { schema_version: 1, entries: [] },
      };
    }
    throw error;
  }
}

function updatedHistory(history, affected, changedAt) {
  const changed = affected.filter((entry) => entry.url_changed);
  if (changed.length === 0) return history.content;
  const entries = [...history.value.entries];
  for (const item of changed) {
    if (entries.some((entry) => entry.from === item.old_url)) {
      throw new ProjectError(
        "URL_HISTORY_CONFLICT",
        "이전 URL이 이미 URL 이력에 있습니다.",
        { from: item.old_url },
      );
    }
    entries.push({ from: item.old_url, target_id: item.id, changed_at: changedAt });
  }
  return `${JSON.stringify({ schema_version: 1, entries }, null, 2)}\n`;
}

async function writeOperationManifest(root, operationId, manifest) {
  const operationRoot = join(root, ".borido", "tree-operations", operationId);
  await mkdir(operationRoot, { recursive: true });
  await atomicWrite(
    join(operationRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return operationRoot;
}

async function assertNewOperation(root, operationId) {
  assertOperationId(operationId);
  const path = join(root, ".borido", "tree-operations", operationId);
  if (await pathExists(path)) {
    throw new ProjectError(
      "TREE_OPERATION_ID_CONFLICT",
      "같은 트리 작업 ID가 이미 있습니다.",
      { operation_id: operationId },
    );
  }
}

async function moveTreeRecordUnlocked({
  root,
  id,
  newParentId,
  expectedMetadataRevision,
  expectedImpactRevision,
  operationId = randomUUID(),
  now = () => new Date(),
  programRoot,
  _afterMove = null,
}) {
  const opened = await openProject({ root, programRoot });
  await assertNewOperation(opened.project.root, operationId);
  const impact = await inspectTreeMove({
    root: opened.project.root,
    id,
    newParentId,
    programRoot,
  });
  if (
    impact.metadata_revision !== expectedMetadataRevision ||
    impact.impact_revision !== expectedImpactRevision
  ) {
    throw new ProjectError(
      "TREE_IMPACT_CHANGED",
      "트리 이동 영향이나 원본이 바뀌어 이동하지 않았습니다.",
    );
  }
  const source = (await resolveProjectPath(opened.project.root, impact.source_directory)).path;
  const target = (
    await resolveProjectPath(opened.project.root, impact.target_directory, {
      mustExist: false,
    })
  ).path;
  if (source === target) {
    throw new ProjectError("TREE_MOVE_NOOP", "현재 부모와 같은 위치로는 이동할 필요가 없습니다.");
  }
  if (await pathExists(target)) {
    throw new ProjectError("TREE_PATH_CONFLICT", "이동할 폴더 위치가 이미 사용 중입니다.", {
      path: impact.target_directory,
    });
  }
  const metadataPath = join(source, "_node.json");
  const metadataBefore = await readFile(metadataPath, "utf8");
  const metadata = JSON.parse(metadataBefore);
  metadata.updated_at = timestamp(now);
  const metadataAfter = `${JSON.stringify(metadata, null, 2)}\n`;
  const historyBefore = await readUrlHistory(opened.project.root);
  const changedAt = metadata.updated_at;
  const historyAfter = updatedHistory(historyBefore, impact.affected, changedAt);
  const manifest = {
    schema_version: 1,
    operation_id: operationId,
    type: "move",
    status: "prepared",
    impact,
    metadata_before: metadataBefore,
    metadata_after: metadataAfter,
    metadata_after_revision: fileRevision(metadataAfter),
    history_before_exists: historyBefore.exists,
    history_before: historyBefore.content,
    history_after: historyAfter,
    history_after_revision: historyAfter === null ? null : fileRevision(historyAfter),
  };
  await writeOperationManifest(opened.project.root, operationId, manifest);
  let moved = false;
  try {
    await rename(source, target);
    moved = true;
    await atomicWrite(join(target, "_node.json"), metadataAfter);
    if (historyAfter !== historyBefore.content && historyAfter !== null) {
      await atomicWrite(historyBefore.path, historyAfter);
    }
    if (_afterMove) await _afterMove();
    const result = await indexProjectContent({ root: opened.project.root });
    assertHealthy(result);
    manifest.status = "completed";
    await writeOperationManifest(opened.project.root, operationId, manifest);
    return { ok: true, operation_id: operationId, impact, record: recordById(result.index, id) };
  } catch (error) {
    if (moved) {
      await atomicWrite(join(target, "_node.json"), metadataBefore).catch(() => {});
      await rename(target, source).catch(() => {});
    }
    if (historyBefore.exists) {
      await atomicWrite(historyBefore.path, historyBefore.content).catch(() => {});
    } else {
      await rm(historyBefore.path, { force: true }).catch(() => {});
    }
    manifest.status = "rolled_back";
    await writeOperationManifest(opened.project.root, operationId, manifest).catch(() => {});
    throw error;
  }
}

export async function moveTreeRecord(options) {
  return withProjectWriteLock(options, ({ root }) =>
    moveTreeRecordUnlocked({ ...options, root }),
  );
}

async function reservedTreeState(root) {
  const operationsRoot = join(root, ".borido", "tree-operations");
  let entries;
  try {
    entries = await readdir(operationsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { ids: new Set(), urls: new Set() };
    throw error;
  }
  const ids = new Set();
  const urls = new Set();
  for (const entry of entries.filter((item) => item.isDirectory())) {
    try {
      const manifest = JSON.parse(
        await readFile(join(operationsRoot, entry.name, "manifest.json"), "utf8"),
      );
      for (const id of manifest.affected_ids ?? []) ids.add(id);
      if (manifest.impact?.target_id) ids.add(manifest.impact.target_id);
      for (const url of manifest.impact?.affected_urls ?? []) {
        if (typeof url === "string") urls.add(url);
      }
    } catch {
      throw new ProjectError(
        "TREE_OPERATION_MANIFEST_INVALID",
        "트리 작업 기록이 손상되어 ID를 안전하게 발급할 수 없습니다.",
        { operation_id: entry.name },
      );
    }
  }
  return { ids, urls };
}

async function createTreeRecordUnlocked({
  root,
  parentId,
  type,
  title,
  slug,
  order,
  nodeKind,
  content = "",
  overview = null,
  relatedDocuments = [],
  idFactory = randomUUID,
  now = () => new Date(),
  programRoot,
}) {
  if (!MUTABLE_TREE_TYPES.has(type)) {
    throw new ProjectError("TREE_RECORD_TYPE_UNSUPPORTED", "구조 노드 또는 본문 유형이 필요합니다.");
  }
  const opened = await openProject({ root, programRoot });
  const report = await indexProjectContent({ root: opened.project.root });
  assertHealthy(report);
  const parent = recordById(report.index, parentId, "트리 부모가 없습니다.");
  assertParent(parent);
  if (type === "tree_node" && typeof nodeKind !== "string") {
    throw new ProjectError("TREE_NODE_KIND_REQUIRED", "구조 노드에는 nodeKind가 필요합니다.");
  }
  if (type === "text_document" && typeof content !== "string") {
    throw new ProjectError("CONTENT_BODY_INVALID", "본문은 문자열이어야 합니다.");
  }
  if (overview !== null && typeof overview !== "string") {
    throw new ProjectError("CONTENT_BODY_INVALID", "개요는 문자열이어야 합니다.");
  }
  const id = idFactory();
  const reserved = await reservedTreeState(opened.project.root);
  if (
    reserved.ids.has(id) ||
    report.index.records.some((record) => record.id === id) ||
    report.index.assets.some((asset) => asset.id === id)
  ) {
    throw new ProjectError("CONTENT_ID_CONFLICT", "새 트리 ID가 기존/삭제 ID와 충돌합니다.", { id });
  }
  const createdAt = timestamp(now);
  const record = {
    schema_version: CONTENT_SCHEMA_VERSION,
    id,
    type,
    title,
    slug,
    status: "draft",
    created_at: createdAt,
    updated_at: createdAt,
    order,
    ...(type === "tree_node"
      ? { node_kind: nodeKind, ...(overview !== null ? { body_file: "_index.md" } : {}) }
      : { body_file: "body.md", related_documents: relatedDocuments }),
  };
  const validator = schemaValidators.records[type];
  if (!validator(record)) {
    throw new ProjectError("CONTENT_SCHEMA_INVALID", "트리 레코드 값이 스키마와 맞지 않습니다.", {
      errors: validator.errors,
    });
  }
  const conflict = report.index.records.find(
    (item) =>
      item.type === type &&
      item.text_id === parent.text_id &&
      item.area === parent.area &&
      item.slug === slug,
  );
  if (conflict) {
    throw new ProjectError("TREE_SLUG_CONFLICT", "같은 경론·영역에 slug가 이미 있습니다.", {
      conflict_id: conflict.id,
    });
  }
  const proposed = {
    id,
    type,
    title,
    slug,
    status: "draft",
    order,
    path: "(proposed)",
    parent_id: parent.id,
    text_id: parent.text_id,
    area: parent.area,
    data: record,
  };
  const proposedUrl = treeRecordUrl(report.index, proposed);
  if (reserved.urls.has(proposedUrl)) {
    throw new ProjectError(
      "TREE_URL_TOMBSTONE_CONFLICT",
      "삭제된 트리의 공개 URL은 자동 재사용하지 않습니다.",
      { url: proposedUrl },
    );
  }
  const referenceErrors = validateContentReferences({
    ...report.index,
    records: [...report.index.records, proposed],
  }).filter((item) => item.level === "error");
  if (referenceErrors.length > 0) {
    throw new ProjectError("CONTENT_REFERENCE_INVALID", "관련 본문 참조가 유효하지 않습니다.", {
      diagnostics: referenceErrors,
    });
  }
  const targetRelative = portablePath(join(parent.directory, slug));
  const target = (
    await resolveProjectPath(opened.project.root, targetRelative, { mustExist: false })
  ).path;
  if (await pathExists(target)) {
    throw new ProjectError("TREE_PATH_CONFLICT", "새 트리 폴더가 이미 있습니다.", {
      path: targetRelative,
    });
  }
  const staging = join(dirname(target), `.borido-tree-create-${randomUUID()}`);
  let created = false;
  try {
    await mkdir(staging);
    await writeFile(join(staging, "_node.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    if (type === "tree_node" && overview !== null) {
      await writeFile(join(staging, "_index.md"), overview, "utf8");
    }
    if (type === "text_document") {
      await writeFile(join(staging, "body.md"), content, "utf8");
    }
    await rename(staging, target);
    created = true;
    const result = await indexProjectContent({ root: opened.project.root });
    assertHealthy(result);
    return recordById(result.index, id);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (created) await rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function createTreeRecord(options) {
  return withProjectWriteLock(options, ({ root }) =>
    createTreeRecordUnlocked({ ...options, root }),
  );
}

export async function reorderTreeRecord({
  root,
  id,
  order,
  expectedMetadataRevision,
  now = () => new Date(),
  programRoot,
}) {
  const report = await indexProjectContent({ root });
  assertHealthy(report);
  const record = recordById(report.index, id);
  assertMutable(record);
  if (!Number.isInteger(order)) {
    throw new ProjectError("TREE_ORDER_INVALID", "order는 정수여야 합니다.");
  }
  const current = await readProjectTextFile({ root, path: record.path, programRoot });
  if (current.revision !== expectedMetadataRevision) {
    throw new ProjectError("PROJECT_FILE_REVISION_CONFLICT", "트리 메타데이터가 변경되었습니다.");
  }
  const value = { ...record.data, order, updated_at: timestamp(now) };
  const validator = schemaValidators.records[record.type];
  if (!validator(value)) {
    throw new ProjectError("CONTENT_SCHEMA_INVALID", "정렬 변경 결과가 유효하지 않습니다.", {
      errors: validator.errors,
    });
  }
  await applyProjectFileChanges({
    root,
    programRoot,
    changes: [{ path: record.path, content: `${JSON.stringify(value, null, 2)}\n`, expectedRevision: current.revision }],
  });
  const updated = await indexProjectContent({ root });
  assertHealthy(updated);
  return recordById(updated.index, id);
}

export async function inspectTreeDeletion({ root, id, programRoot }) {
  const report = await indexProjectContent({ root });
  assertHealthy(report);
  const record = recordById(report.index, id);
  assertMutable(record);
  const children = descendants(report.index, record);
  const affectedIds = new Set([id, ...children.map((item) => item.id)]);
  const references = findIncomingReferences(report.index, affectedIds).filter(
    (item) => !affectedIds.has(item.source_id),
  );
  const metadata = await readProjectTextFile({ root, path: record.path, programRoot });
  const summary = {
    operation: "delete",
    target_id: id,
    directory: record.directory,
    metadata_revision: metadata.revision,
    affected_ids: [...affectedIds].sort(),
    affected_urls: [record, ...children].map((item) => treeRecordUrl(report.index, item)),
    references,
  };
  return { ...summary, impact_revision: impactHash(summary) };
}

async function deleteTreeRecordUnlocked({
  root,
  id,
  expectedMetadataRevision,
  expectedImpactRevision,
  operationId = randomUUID(),
  now = () => new Date(),
  programRoot,
  _afterDelete = null,
}) {
  const opened = await openProject({ root, programRoot });
  await assertNewOperation(opened.project.root, operationId);
  const impact = await inspectTreeDeletion({ root: opened.project.root, id, programRoot });
  if (
    impact.metadata_revision !== expectedMetadataRevision ||
    impact.impact_revision !== expectedImpactRevision
  ) {
    throw new ProjectError("TREE_IMPACT_CHANGED", "삭제 영향이나 원본이 바뀌어 삭제하지 않았습니다.");
  }
  if (impact.references.length > 0) {
    throw new ProjectError("TREE_DELETE_REFERENCED", "외부 본문 참조를 먼저 수정해야 합니다.", {
      references: impact.references,
    });
  }
  const source = (await resolveProjectPath(opened.project.root, impact.directory)).path;
  const operationRoot = join(opened.project.root, ".borido", "tree-operations", operationId);
  const stored = join(operationRoot, "content");
  const manifest = {
    schema_version: 1,
    operation_id: operationId,
    type: "delete",
    status: "prepared",
    deleted_at: timestamp(now),
    impact,
    affected_ids: impact.affected_ids,
  };
  await mkdir(operationRoot, { recursive: true });
  await writeOperationManifest(opened.project.root, operationId, manifest);
  try {
    await rename(source, stored);
    if (_afterDelete) await _afterDelete();
    const result = await indexProjectContent({ root: opened.project.root });
    assertHealthy(result);
    manifest.status = "completed";
    await writeOperationManifest(opened.project.root, operationId, manifest);
    return { ok: true, operation_id: operationId, impact };
  } catch (error) {
    if (await pathExists(stored)) await rename(stored, source).catch(() => {});
    manifest.status = "rolled_back";
    await writeOperationManifest(opened.project.root, operationId, manifest).catch(() => {});
    throw error;
  }
}

export async function deleteTreeRecord(options) {
  return withProjectWriteLock(options, ({ root }) =>
    deleteTreeRecordUnlocked({ ...options, root }),
  );
}

function assertManagedTreeDirectory(path) {
  if (typeof path !== "string" || !path.startsWith("content/texts/")) {
    throw new ProjectError(
      "TREE_OPERATION_MANIFEST_INVALID",
      "트리 작업 기록의 콘텐츠 경로가 유효하지 않습니다.",
      { path },
    );
  }
}

async function restoreTreeOperationUnlocked({
  root,
  operationId,
  programRoot,
  _beforeRecoveryCommit = null,
}) {
  assertOperationId(operationId);
  const opened = await openProject({ root, programRoot });
  const operationRoot = join(opened.project.root, ".borido", "tree-operations", operationId);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(operationRoot, "manifest.json"), "utf8"));
  } catch {
    throw new ProjectError("TREE_OPERATION_NOT_FOUND", "트리 작업 복구 기록이 없습니다.");
  }
  if (manifest.status !== "completed") {
    throw new ProjectError("TREE_OPERATION_NOT_RESTORABLE", "완료 상태의 트리 작업만 복구할 수 있습니다.");
  }
  let rollbackRecovery;
  if (manifest.type === "delete") {
    assertManagedTreeDirectory(manifest.impact?.directory);
    const target = (
      await resolveProjectPath(opened.project.root, manifest.impact.directory, { mustExist: false })
    ).path;
    if (await pathExists(target)) {
      throw new ProjectError("TREE_RESTORE_PATH_CONFLICT", "삭제 전 위치가 사용 중입니다.");
    }
    const stored = join(operationRoot, "content");
    await rename(stored, target);
    rollbackRecovery = () => rename(target, stored);
  } else if (manifest.type === "move") {
    assertManagedTreeDirectory(manifest.impact?.target_directory);
    assertManagedTreeDirectory(manifest.impact?.source_directory);
    const current = (
      await resolveProjectPath(opened.project.root, manifest.impact.target_directory)
    ).path;
    const original = (
      await resolveProjectPath(opened.project.root, manifest.impact.source_directory, {
        mustExist: false,
      })
    ).path;
    if (await pathExists(original)) {
      throw new ProjectError("TREE_RESTORE_PATH_CONFLICT", "이동 전 위치가 사용 중입니다.");
    }
    const currentMetadata = await readFile(join(current, "_node.json"), "utf8");
    if (fileRevision(currentMetadata) !== manifest.metadata_after_revision) {
      throw new ProjectError("TREE_RESTORE_REVISION_CONFLICT", "이동 후 메타데이터가 다시 변경되었습니다.");
    }
    const history = await readUrlHistory(opened.project.root);
    if (history.revision !== manifest.history_after_revision) {
      throw new ProjectError("TREE_RESTORE_REVISION_CONFLICT", "이동 후 URL 이력이 다시 변경되었습니다.");
    }
    if (
      typeof manifest.metadata_after !== "string" ||
      (manifest.history_after !== null && typeof manifest.history_after !== "string")
    ) {
      throw new ProjectError(
        "TREE_OPERATION_MANIFEST_INVALID",
        "트리 이동 복구 기록에 완료 상태 사본이 없습니다.",
      );
    }
    await atomicWrite(join(current, "_node.json"), manifest.metadata_before);
    await rename(current, original);
    if (manifest.history_before_exists) {
      await atomicWrite(history.path, manifest.history_before);
    } else {
      await rm(history.path, { force: true });
    }
    rollbackRecovery = async () => {
      await atomicWrite(join(original, "_node.json"), manifest.metadata_after);
      await rename(original, current);
      if (manifest.history_after !== null) {
        await atomicWrite(history.path, manifest.history_after);
      } else {
        await rm(history.path, { force: true });
      }
    };
  } else {
    throw new ProjectError("TREE_OPERATION_NOT_RESTORABLE", "지원하지 않는 트리 작업 기록입니다.");
  }
  try {
    const result = await indexProjectContent({ root: opened.project.root });
    assertHealthy(result);
    if (_beforeRecoveryCommit) await _beforeRecoveryCommit();
    manifest.status = "recovered";
    await writeOperationManifest(opened.project.root, operationId, manifest);
    return { ok: true, operation_id: operationId, status: "recovered" };
  } catch (error) {
    manifest.status = "completed";
    await rollbackRecovery().catch(() => {});
    throw error;
  }
}

export async function restoreTreeOperation(options) {
  return withProjectWriteLock(options, ({ root }) =>
    restoreTreeOperationUnlocked({ ...options, root }),
  );
}
