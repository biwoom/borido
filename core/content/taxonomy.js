import { diagnostic, sortDiagnostics } from "./diagnostics.js";

function publicationBlocker(record, code, field, message, details = {}) {
  return {
    diagnostic: diagnostic({
      code,
      path: record.path,
      recordId: record.id,
      field,
      message,
      details,
    }),
    blocker: { record_id: record.id, code, field },
  };
}

export function validateTextBibliography(index) {
  const diagnostics = [];
  const blockers = [];
  const taxonomies = new Map(
    (index.taxonomies ?? []).map((taxonomy) => [taxonomy.canon_id, taxonomy]),
  );
  const providers = new Map(
    (index.sources ?? []).map((provider) => [provider.id, provider]),
  );

  function addBlocker(record, code, field, message, details) {
    const result = publicationBlocker(record, code, field, message, details);
    diagnostics.push(result.diagnostic);
    blockers.push(result.blocker);
  }

  for (const record of index.records.filter((item) => item.type === "text")) {
    const canon = record.data.canon;
    const canonId = canon?.canon_id ?? null;
    if (canonId !== null) {
      const taxonomy = taxonomies.get(canonId);
      if (!taxonomy) {
        diagnostics.push(
          diagnostic({
            code: "CANON_REFERENCE_MISSING",
            path: record.path,
            recordId: record.id,
            field: "canon.canon_id",
            message: "경론이 참조하는 문헌 체계가 등록되어 있지 않습니다.",
            details: { canon_id: canonId },
          }),
        );
      } else if (canon.section_id !== null) {
        const section = taxonomy.sections.find(
          (item) => item.id === canon.section_id,
        );
        if (!section) {
          diagnostics.push(
            diagnostic({
              code: "CANON_SECTION_REFERENCE_MISSING",
              path: record.path,
              recordId: record.id,
              field: "canon.section_id",
              message: "경론이 참조하는 분류 항목이 문헌 체계에 없습니다.",
              details: { canon_id: canonId, section_id: canon.section_id },
            }),
          );
        }
      }
    }

    const edition = record.data.source_edition;
    if (edition && !providers.has(edition.provider_id)) {
      diagnostics.push(
        diagnostic({
          code: "SOURCE_PROVIDER_REFERENCE_MISSING",
          path: record.path,
          recordId: record.id,
          field: "source_edition.provider_id",
          message: "디지털 판본 제공처가 sources.json에 없습니다.",
          details: { provider_id: edition.provider_id },
        }),
      );
    }

    if (record.status !== "published") continue;
    const taxonomy = canonId === null ? null : taxonomies.get(canonId);
    const section = taxonomy?.sections.find(
      (item) => item.id === canon.section_id,
    );
    if (canonId !== null) {
      if (canon.verification_status !== "verified") {
        addBlocker(
          record,
          "CANON_REFERENCE_UNVERIFIED",
          "canon.verification_status",
          "공개 경론의 문헌 분류 참조가 검증되지 않았습니다.",
        );
      }
      if (!taxonomy || taxonomy.verification_status !== "verified") {
        addBlocker(
          record,
          "CANON_UNVERIFIED",
          "canon.canon_id",
          "공개 경론의 문헌 체계가 없거나 검증되지 않았습니다.",
          { canon_id: canonId },
        );
      }
      if (!canon.section_id || !section || section.verification_status !== "verified") {
        addBlocker(
          record,
          "CANON_SECTION_UNVERIFIED",
          "canon.section_id",
          "공개 경론에는 검증된 대표 분류가 필요합니다.",
          { canon_id: canonId, section_id: canon.section_id ?? null },
        );
      }
    }
    if (!edition) {
      addBlocker(
        record,
        "SOURCE_EDITION_REQUIRED",
        "source_edition",
        "공개 경론에는 검증 가능한 디지털 판본 출처가 필요합니다.",
      );
      continue;
    }
    const provider = providers.get(edition.provider_id);
    if (
      edition.verification_status !== "verified" ||
      !provider ||
      provider.verification_status !== "verified"
    ) {
      addBlocker(
        record,
        "SOURCE_EDITION_UNVERIFIED",
        "source_edition.verification_status",
        "공개 경론의 디지털 판본 또는 제공처가 검증되지 않았습니다.",
        { provider_id: edition.provider_id },
      );
    }
    if (["unverified", "restricted"].includes(edition.rights_status)) {
      addBlocker(
        record,
        "SOURCE_RIGHTS_UNVERIFIED",
        "source_edition.rights_status",
        "공개 경론 원문의 이용 가능 상태를 확인해야 합니다.",
        { rights_status: edition.rights_status },
      );
    }
  }

  return { diagnostics: sortDiagnostics(diagnostics), blockers };
}
