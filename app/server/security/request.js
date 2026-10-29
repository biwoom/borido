import { timingSafeEqual } from "node:crypto";

import { ProjectError } from "../../../core/project/index.js";

export const MAX_REQUEST_TARGET_BYTES = 4096;
export const MAX_JSON_BODY_BYTES = 64 * 1024;

function requestError(code, message, details = {}) {
  return new ProjectError(code, message, details);
}

export function parseRequestTarget(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    Buffer.byteLength(value) > MAX_REQUEST_TARGET_BYTES ||
    value.includes("\\") ||
    value.includes("\0") ||
    /%(?![0-9a-f]{2})/i.test(value) ||
    /%2f|%5c|%00/i.test(value)
  ) {
    throw requestError("INVALID_REQUEST_PATH", "요청 경로가 유효하지 않습니다.");
  }
  const rawPath = value.split("?", 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw requestError("INVALID_REQUEST_PATH", "요청 경로 인코딩이 유효하지 않습니다.");
  }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw requestError("INVALID_REQUEST_PATH", "상위 경로 요청은 허용하지 않습니다.");
  }

  const parsed = new URL(value, "http://127.0.0.1");
  if (parsed.search) {
    throw requestError("INVALID_REQUEST_QUERY", "이 API는 쿼리 문자열을 받지 않습니다.");
  }
  return parsed.pathname;
}

export function validateHost(request, expectedHost) {
  if (request.headers.host !== expectedHost) {
    throw requestError("INVALID_HOST", "허용하지 않은 Host 요청입니다.");
  }
}

export function validateOrigin(request, expectedOrigin, { required = false } = {}) {
  const origin = request.headers.origin;
  if ((required && !origin) || (origin && origin !== expectedOrigin)) {
    throw requestError("INVALID_ORIGIN", "허용하지 않은 Origin 요청입니다.");
  }
}

export function validateSession(request, expectedToken) {
  const provided = request.headers["x-borido-session"];
  if (typeof provided !== "string") {
    throw requestError("INVALID_SESSION", "유효한 로컬 세션이 필요합니다.");
  }
  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = Buffer.from(provided);
  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    throw requestError("INVALID_SESSION", "유효한 로컬 세션이 필요합니다.");
  }
}

export async function readJsonBody(request, limit = MAX_JSON_BODY_BYTES) {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    throw requestError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type application/json이 필요합니다.",
    );
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    request.resume();
    throw requestError("REQUEST_TOO_LARGE", "JSON 요청 크기 제한을 초과했습니다.", {
      limit,
    });
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw requestError("REQUEST_TOO_LARGE", "JSON 요청 크기 제한을 초과했습니다.", {
        limit,
      });
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    throw requestError("INVALID_JSON", "JSON 요청 본문이 필요합니다.");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw requestError("INVALID_JSON", "요청 본문이 유효한 JSON이 아닙니다.");
  }
}
