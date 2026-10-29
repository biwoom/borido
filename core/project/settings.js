import { createHash } from "node:crypto";

import { ProjectError } from "./errors.js";

export const SITE_SCHEMA_VERSION = 1;

const SITE_FIELDS = new Set([
  "schema_version",
  "site_name",
  "description",
  "default_language",
  "author_name",
  "license",
  "timezone",
  "base_url",
  "base_path",
  "source_repository",
  "deployment",
]);

const FORBIDDEN_SECRET_FIELD = /(password|passphrase|token|secret|github_pat|private_key)/i;

function invalid(field, message) {
  throw new ProjectError("INVALID_SITE_SETTINGS", message, { field });
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(field, `${field}에는 비어 있지 않은 문자열이 필요합니다.`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (typeof value !== "string") {
    invalid(field, `${field}에는 문자열이 필요합니다.`);
  }
  return value;
}

function validateLanguage(value) {
  const language = requiredString(value, "default_language");
  try {
    return new Intl.Locale(language).toString();
  } catch {
    invalid("default_language", "default_language는 유효한 언어 태그여야 합니다.");
  }
}

function validateTimezone(value) {
  const timezone = requiredString(value, "timezone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return timezone;
  } catch {
    invalid("timezone", "timezone은 유효한 IANA 시간대여야 합니다.");
  }
}

export function normalizeBasePath(value) {
  if (value === undefined || value === null || value === "" || value === "/") {
    return "/";
  }
  if (typeof value !== "string") {
    invalid("base_path", "base_path에는 문자열이 필요합니다.");
  }
  if (/[?#\\]/.test(value) || /%2f|%5c|%2e/i.test(value)) {
    invalid("base_path", "base_path에는 쿼리, 해시 또는 우회 경로를 넣을 수 없습니다.");
  }

  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  if (withLeadingSlash.includes("//")) {
    invalid("base_path", "base_path에는 빈 경로 구간을 넣을 수 없습니다.");
  }
  const segments = withLeadingSlash.split("/").filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._~-]+$/.test(segment),
    )
  ) {
    invalid("base_path", "base_path는 안전한 URL 경로 구간으로 구성해야 합니다.");
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

function validateBaseUrl(value) {
  if (value === null) return null;
  const input = requiredString(value, "base_url");
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    invalid("base_url", "base_url은 유효한 공개 origin이어야 합니다.");
  }
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== input
  ) {
    invalid("base_url", "base_url에는 origin만 저장해야 합니다.");
  }
  return parsed.origin;
}

export function parsePublicUrl(value) {
  if (value === undefined || value === null || value === "") {
    return { base_url: null, base_path: "/" };
  }
  const input = requiredString(value, "public_url");
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    invalid("public_url", "공개 URL이 유효하지 않습니다.");
  }
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    invalid("public_url", "공개 URL에는 HTTP(S) 주소와 경로만 사용할 수 있습니다.");
  }
  return {
    base_url: parsed.origin,
    base_path: normalizeBasePath(parsed.pathname),
  };
}

function validateRepository(value, field, includePublicLinks) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(field, `${field}에는 객체 또는 null이 필요합니다.`);
  }
  const allowed = new Set([
    "repository_url",
    "branch",
    ...(includePublicLinks ? ["public_links"] : []),
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    invalid(field, `${field}에 지원하지 않는 필드가 있습니다.`);
  }
  const repositoryUrl = requiredString(
    value.repository_url,
    `${field}.repository_url`,
  );
  if (/\s|[\u0000-\u001f\u007f]/.test(repositoryUrl)) {
    invalid(`${field}.repository_url`, "저장소 URL에 공백이나 제어 문자를 넣을 수 없습니다.");
  }
  if (!/^[\w.-]+@[\w.-]+:[^\s]+$/.test(repositoryUrl)) {
    let parsed;
    try {
      parsed = new URL(repositoryUrl);
    } catch {
      invalid(`${field}.repository_url`, "저장소 URL 형식이 유효하지 않습니다.");
    }
    if (
      !["https:", "http:", "ssh:"].includes(parsed.protocol) ||
      parsed.password ||
      (["https:", "http:"].includes(parsed.protocol) && parsed.username) ||
      parsed.search ||
      parsed.hash
    ) {
      invalid(
        `${field}.repository_url`,
        "저장소 URL에 인증 비밀·쿼리·해시를 넣을 수 없습니다.",
      );
    }
  }
  const result = {
    repository_url: repositoryUrl,
    branch: requiredString(value.branch, `${field}.branch`),
  };
  if (includePublicLinks) {
    if (typeof value.public_links !== "boolean") {
      invalid(`${field}.public_links`, `${field}.public_links에는 boolean이 필요합니다.`);
    }
    result.public_links = value.public_links;
  }
  return result;
}

export function createSiteSettings({
  siteName,
  description = "",
  defaultLanguage,
  authorName = "",
  license = "",
  timezone,
  publicUrl = null,
  sourceRepository = null,
  deployment = null,
}) {
  const publicLocation = parsePublicUrl(publicUrl);
  return {
    schema_version: SITE_SCHEMA_VERSION,
    site_name: requiredString(siteName, "site_name"),
    description: optionalString(description, "description"),
    default_language: validateLanguage(defaultLanguage),
    author_name: optionalString(authorName, "author_name"),
    license: optionalString(license, "license"),
    timezone: validateTimezone(timezone),
    ...publicLocation,
    source_repository: validateRepository(
      sourceRepository,
      "source_repository",
      true,
    ),
    deployment: validateRepository(deployment, "deployment", false),
  };
}

export function validateSiteSettings(value, { allowUnknown = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("site", "site.json의 최상위 값은 객체여야 합니다.");
  }

  const fields = Object.keys(value);
  const secretFields = fields.filter((field) => FORBIDDEN_SECRET_FIELD.test(field));
  if (secretFields.length > 0) {
    throw new ProjectError(
      "SITE_SETTINGS_FORBIDDEN_SECRET",
      "인증 비밀은 site.json에 저장할 수 없습니다.",
      { fields: secretFields },
    );
  }
  if (value.schema_version !== SITE_SCHEMA_VERSION) {
    throw new ProjectError(
      "UNSUPPORTED_SITE_SCHEMA",
      "지원하지 않는 site.json 스키마 버전입니다.",
      { supported: SITE_SCHEMA_VERSION, actual: value.schema_version ?? null },
    );
  }

  const unknownFields = fields.filter((field) => !SITE_FIELDS.has(field));
  if (!allowUnknown && unknownFields.length > 0) {
    invalid("site", "site.json에 지원하지 않는 필드가 있습니다.");
  }

  const settings = {
    ...value,
    site_name: requiredString(value.site_name, "site_name"),
    description: optionalString(value.description, "description"),
    default_language: validateLanguage(value.default_language),
    author_name: optionalString(value.author_name, "author_name"),
    license: optionalString(value.license, "license"),
    timezone: validateTimezone(value.timezone),
    base_url: validateBaseUrl(value.base_url),
    base_path: normalizeBasePath(value.base_path),
    source_repository: validateRepository(
      value.source_repository,
      "source_repository",
      true,
    ),
    deployment: validateRepository(value.deployment, "deployment", false),
  };

  if (settings.base_path !== value.base_path) {
    invalid("base_path", "저장된 base_path가 정규화된 형식이 아닙니다.");
  }

  const diagnostics = unknownFields.map((field) => ({
    level: "warning",
    code: "UNKNOWN_SITE_FIELD",
    field,
    message: "지원하지 않는 설정 필드를 보존했으며 편집 저장을 차단합니다.",
  }));

  return {
    settings,
    diagnostics,
    editable: diagnostics.length === 0,
  };
}

export function settingsRevision(content) {
  return createHash("sha256").update(content).digest("hex");
}
