import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { evaluatePublication } from "./visibility.js";

function referenceDefinitions(record) {
  const definitions = [];
  if (record.type === "text") {
    for (const targetId of record.data.related_texts ?? []) {
      definitions.push({ field: "related_texts", targetId, targetType: "text" });
    }
  }
  if (record.type === "text_document") {
    for (const targetId of record.data.related_documents ?? []) {
      definitions.push({
        field: "related_documents",
        targetId,
        targetType: "text_document",
      });
    }
  }
  if (record.type === "story" && record.data.featured_media_id) {
    definitions.push({
      field: "featured_media_id",
      targetId: record.data.featured_media_id,
      targetType: "media_asset",
    });
  }
  return definitions;
}

export function validateContentReferences(index, publicationOptions = {}) {
  const diagnostics = [];
  const recordsById = new Map(index.records.map((record) => [record.id, record]));
  const assetsById = new Map(index.assets.map((asset) => [asset.id, asset]));
  const publication = evaluatePublication(index.records, publicationOptions);
  const publicationById = new Map(
    publication.records.map((evaluation) => [evaluation.id, evaluation]),
  );

  for (const record of index.records) {
    for (const reference of referenceDefinitions(record)) {
      const target = reference.targetType === "media_asset"
        ? assetsById.get(reference.targetId)
        : recordsById.get(reference.targetId);
      if (!target) {
        diagnostics.push(
          diagnostic({
            code: "REFERENCE_TARGET_MISSING",
            path: record.path,
            recordId: record.id,
            field: reference.field,
            message: "참조 대상이 프로젝트에 없습니다.",
            details: {
              target_id: reference.targetId,
              expected_type: reference.targetType,
            },
          }),
        );
        continue;
      }
      if (
        reference.targetType !== "media_asset" &&
        target.type !== reference.targetType
      ) {
        diagnostics.push(
          diagnostic({
            code: "REFERENCE_TARGET_TYPE_INVALID",
            path: record.path,
            recordId: record.id,
            field: reference.field,
            message: "참조 대상의 콘텐츠 유형이 올바르지 않습니다.",
            details: {
              target_id: reference.targetId,
              expected_type: reference.targetType,
              actual_type: target.type,
            },
          }),
        );
        continue;
      }
      if (publicationById.get(record.id)?.included !== true) continue;
      const targetPublished = reference.targetType === "media_asset"
        ? target.status === "published"
        : publicationById.get(reference.targetId)?.included === true;
      if (!targetPublished) {
        diagnostics.push(
          diagnostic({
            level: "warning",
            code: "REFERENCE_TARGET_NOT_PUBLIC",
            path: record.path,
            recordId: record.id,
            field: reference.field,
            message: "선택 참조 대상이 공개되지 않아 공개 출력에서 제외합니다.",
            details: { target_id: reference.targetId },
          }),
        );
      }
    }
  }
  return sortDiagnostics(diagnostics);
}

export function findIncomingReferences(index, targetIds) {
  const targets = targetIds instanceof Set ? targetIds : new Set(targetIds);
  const references = [];
  for (const record of index.records) {
    for (const reference of referenceDefinitions(record)) {
      if (!targets.has(reference.targetId)) continue;
      references.push({
        source_id: record.id,
        source_type: record.type,
        source_path: record.path,
        field: reference.field,
        target_id: reference.targetId,
      });
    }
  }
  return references.sort(
    (left, right) =>
      left.source_path.localeCompare(right.source_path, "en") ||
      left.field.localeCompare(right.field, "en") ||
      left.target_id.localeCompare(right.target_id, "en"),
  );
}
