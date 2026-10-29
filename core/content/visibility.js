const STRUCTURAL_TYPES = new Set(["text_area", "tree_node"]);
const DIRECT_PAGE_TYPES = new Set([
  "text",
  "text_document",
  "story",
  "blog",
  "page",
]);

function valuesById(value) {
  if (value instanceof Map) return value;
  return new Map(Object.entries(value ?? {}));
}

function reason(code, details = {}) {
  return { code, details };
}

function selfStatusReason(status) {
  if (status === "draft") return reason("SELF_DRAFT");
  if (status === "private") return reason("SELF_PRIVATE");
  if (status !== "published") return reason("SELF_STATUS_INVALID", { status });
  return null;
}

function ancestorStatusReason(ancestor) {
  if (ancestor.status === "draft") {
    return reason("ANCESTOR_DRAFT", { ancestor_id: ancestor.id });
  }
  if (ancestor.status === "private") {
    return reason("ANCESTOR_PRIVATE", { ancestor_id: ancestor.id });
  }
  if (ancestor.status !== "published") {
    return reason("ANCESTOR_STATUS_INVALID", {
      ancestor_id: ancestor.id,
      status: ancestor.status,
    });
  }
  return null;
}

function normalizeBlockers(blockers) {
  const result = new Map();
  for (const blocker of blockers ?? []) {
    if (!blocker || typeof blocker.record_id !== "string") continue;
    const found = result.get(blocker.record_id) ?? [];
    found.push({
      code: blocker.code ?? "PUBLICATION_BLOCKED",
      field: blocker.field ?? null,
    });
    result.set(blocker.record_id, found);
  }
  return result;
}

export function evaluatePublication(
  records,
  { overviewTextById = new Map(), blockers = [] } = {},
) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const children = new Map();
  for (const record of records) {
    if (!record.parent_id) continue;
    const found = children.get(record.parent_id) ?? [];
    found.push(record);
    children.set(record.parent_id, found);
  }
  const overview = valuesById(overviewTextById);
  const blockersById = normalizeBlockers(blockers);
  const eligibility = new Map();

  function eligibilityFor(record, stack = new Set()) {
    if (eligibility.has(record.id)) return eligibility.get(record.id);
    if (stack.has(record.id)) {
      const cyclic = {
        effective_published: false,
        reasons: [reason("ANCESTOR_CYCLE", { record_id: record.id })],
      };
      eligibility.set(record.id, cyclic);
      return cyclic;
    }
    const nextStack = new Set(stack).add(record.id);
    const reasons = [];
    const ownStatus = selfStatusReason(record.status);
    if (ownStatus) reasons.push(ownStatus);
    for (const blocker of blockersById.get(record.id) ?? []) {
      reasons.push(reason("PUBLICATION_BLOCKER", blocker));
    }
    if (record.parent_id) {
      const parent = byId.get(record.parent_id);
      if (!parent) {
        reasons.push(reason("ANCESTOR_MISSING", { parent_id: record.parent_id }));
      } else {
        const parentStatus = ancestorStatusReason(parent);
        if (parentStatus) reasons.push(parentStatus);
        const parentEligibility = eligibilityFor(parent, nextStack);
        for (const parentReason of parentEligibility.reasons) {
          if (parentReason.code === "PUBLICATION_BLOCKER") {
            reasons.push(
              reason("ANCESTOR_PUBLICATION_BLOCKER", {
                ancestor_id: parent.id,
                ...parentReason.details,
              }),
            );
          } else if (
            parentReason.code === "ANCESTOR_DRAFT" ||
            parentReason.code === "ANCESTOR_PRIVATE" ||
            parentReason.code === "ANCESTOR_STATUS_INVALID" ||
            parentReason.code === "ANCESTOR_PUBLICATION_BLOCKER" ||
            parentReason.code === "ANCESTOR_MISSING" ||
            parentReason.code === "ANCESTOR_CYCLE"
          ) {
            reasons.push(parentReason);
          }
        }
      }
    }
    const result = { effective_published: reasons.length === 0, reasons };
    eligibility.set(record.id, result);
    return result;
  }

  const included = new Map();
  const inclusionStack = new Set();
  function includedFor(record) {
    if (included.has(record.id)) return included.get(record.id);
    const base = eligibilityFor(record);
    if (!base.effective_published) {
      const result = { ...base, included: false };
      included.set(record.id, result);
      return result;
    }
    if (DIRECT_PAGE_TYPES.has(record.type)) {
      const result = { ...base, included: true };
      included.set(record.id, result);
      return result;
    }
    if (!STRUCTURAL_TYPES.has(record.type)) {
      const result = {
        effective_published: false,
        included: false,
        reasons: [reason("CONTENT_TYPE_UNSUPPORTED", { type: record.type })],
      };
      included.set(record.id, result);
      return result;
    }
    if (inclusionStack.has(record.id)) {
      const result = {
        effective_published: false,
        included: false,
        reasons: [reason("ANCESTOR_CYCLE", { record_id: record.id })],
      };
      included.set(record.id, result);
      return result;
    }
    inclusionStack.add(record.id);
    const text = overview.get(record.id);
    const hasOverview =
      typeof text === "string" && text.trim().length > 0 && record.data?.body_file;
    const hasIncludedChild = (children.get(record.id) ?? []).some(
      (child) => includedFor(child).included,
    );
    inclusionStack.delete(record.id);
    const result = hasOverview || hasIncludedChild
      ? { ...base, included: true }
      : {
          ...base,
          included: false,
          reasons: [...base.reasons, reason("EMPTY_STRUCTURE")],
        };
    included.set(record.id, result);
    return result;
  }

  const evaluations = records.map((record) => ({
    id: record.id,
    type: record.type,
    ...includedFor(record),
  }));
  return {
    records: evaluations,
    included_ids: evaluations
      .filter((evaluation) => evaluation.included)
      .map((evaluation) => evaluation.id),
    excluded_ids: evaluations
      .filter((evaluation) => !evaluation.included)
      .map((evaluation) => evaluation.id),
  };
}

export function selectPublicRecords(records, options) {
  const evaluation = evaluatePublication(records, options);
  const included = new Set(evaluation.included_ids);
  return {
    ...evaluation,
    public_records: records.filter((record) => included.has(record.id)),
  };
}
