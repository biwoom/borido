function compareNullable(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), "en");
}

export function diagnostic({
  level = "error",
  code,
  path,
  message,
  recordId = null,
  field = null,
  details = {},
}) {
  return {
    level,
    code,
    path,
    record_id: recordId,
    field,
    message,
    details,
  };
}

export function sortDiagnostics(diagnostics) {
  return diagnostics.sort(
    (left, right) =>
      compareNullable(left.path, right.path) ||
      compareNullable(left.code, right.code) ||
      compareNullable(left.field, right.field) ||
      compareNullable(left.record_id, right.record_id),
  );
}

function fieldFromAjvError(error) {
  if (error.keyword === "additionalProperties") {
    return error.params.additionalProperty;
  }
  if (error.keyword === "required") return error.params.missingProperty;
  return error.instancePath.replace(/^\//, "").replaceAll("/", ".") || null;
}

export function diagnosticsFromSchema(errors, { path, recordId = null } = {}) {
  return (errors ?? []).map((error) => {
    const field = fieldFromAjvError(error);
    const unsupportedVersion =
      error.keyword === "const" && field === "schema_version";
    const unsupportedField = error.keyword === "additionalProperties";
    return diagnostic({
      code: unsupportedVersion
        ? "UNSUPPORTED_SCHEMA_VERSION"
        : unsupportedField
          ? "UNSUPPORTED_FIELD"
          : "SCHEMA_VALIDATION_FAILED",
      path,
      recordId,
      field,
      message: unsupportedVersion
        ? "지원하지 않는 스키마 버전입니다."
        : unsupportedField
          ? "지원하지 않는 필드가 있습니다."
          : "필드 값이 콘텐츠 스키마와 맞지 않습니다.",
      details: { keyword: error.keyword, message: error.message },
    });
  });
}
