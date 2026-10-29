import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import {
  errorResponse,
  openProject,
  ProjectError,
  writeProjectSettings,
} from "../../core/project/index.js";
import {
  MAX_JSON_BODY_BYTES,
  parseRequestTarget,
  readJsonBody,
  validateHost,
  validateOrigin,
  validateSession,
} from "./security/request.js";

export const LOOPBACK_HOST = "127.0.0.1";

const STATUS_BY_CODE = new Map([
  ["INVALID_REQUEST_PATH", 400],
  ["INVALID_REQUEST_QUERY", 400],
  ["INVALID_JSON", 400],
  ["INVALID_SITE_SETTINGS", 400],
  ["SITE_SETTINGS_FORBIDDEN_SECRET", 400],
  ["UNSUPPORTED_SITE_SCHEMA", 400],
  ["INVALID_SESSION", 401],
  ["INVALID_HOST", 403],
  ["INVALID_ORIGIN", 403],
  ["PROJECT_PERMISSION_DENIED", 403],
  ["NOT_FOUND", 404],
  ["METHOD_NOT_ALLOWED", 405],
  ["PROJECT_REVISION_CONFLICT", 409],
  ["SITE_SETTINGS_NOT_EDITABLE", 409],
  ["REQUEST_TOO_LARGE", 413],
  ["UNSUPPORTED_MEDIA_TYPE", 415],
]);

function sendJson(response, status, value, extraHeaders = {}) {
  const content = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(content),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(content);
}

function sanitizedError(error) {
  if (error instanceof ProjectError) return errorResponse(error);
  return {
    ok: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "로컬 서버가 요청을 완료하지 못했습니다.",
      details: {},
    },
  };
}

function assertSettingsBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectError("INVALID_JSON", "설정 요청은 JSON 객체여야 합니다.");
  }
  const unknown = Object.keys(value).filter(
    (key) => !["settings", "expected_revision"].includes(key),
  );
  if (
    unknown.length > 0 ||
    !value.settings ||
    typeof value.settings !== "object" ||
    typeof value.expected_revision !== "string"
  ) {
    throw new ProjectError(
      "INVALID_JSON",
      "settings와 expected_revision만 포함한 요청이 필요합니다.",
    );
  }
  return value;
}

export async function startLocalServer({
  projectRoot,
  host = LOOPBACK_HOST,
  port = 0,
  sessionToken = randomBytes(32).toString("base64url"),
} = {}) {
  if (host !== LOOPBACK_HOST) {
    throw new ProjectError(
      "SERVER_HOST_NOT_ALLOWED",
      "로컬 서버는 127.0.0.1에만 바인딩할 수 있습니다.",
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ProjectError("INVALID_SERVER_PORT", "서버 포트가 유효하지 않습니다.");
  }
  if (typeof sessionToken !== "string" || sessionToken.length < 32) {
    throw new ProjectError(
      "INVALID_SESSION_TOKEN",
      "로컬 세션 토큰은 충분한 길이의 문자열이어야 합니다.",
    );
  }

  const opened = await openProject({ root: projectRoot });
  const fixedProjectRoot = opened.project.root;
  const context = { expectedHost: null, origin: null };

  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    try {
      validateHost(request, context.expectedHost);
      const path = parseRequestTarget(request.url);

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      validateSession(request, sessionToken);
      validateOrigin(request, context.origin, { required: request.method !== "GET" });

      if (request.method === "GET" && path === "/api/v1/project") {
        sendJson(response, 200, await openProject({ root: fixedProjectRoot }));
        return;
      }

      if (request.method === "PUT" && path === "/api/v1/project/settings") {
        const body = assertSettingsBody(
          await readJsonBody(request, MAX_JSON_BODY_BYTES),
        );
        sendJson(
          response,
          200,
          await writeProjectSettings({
            root: fixedProjectRoot,
            settings: body.settings,
            expectedRevision: body.expected_revision,
          }),
        );
        return;
      }

      const knownPath = ["/api/v1/project", "/api/v1/project/settings"].includes(path);
      if (knownPath) {
        throw new ProjectError(
          "METHOD_NOT_ALLOWED",
          "이 경로에서 허용하지 않는 HTTP 메서드입니다.",
        );
      }
      throw new ProjectError("NOT_FOUND", "요청한 로컬 API가 없습니다.");
    } catch (error) {
      const payload = sanitizedError(error);
      const status = STATUS_BY_CODE.get(payload.error.code) ?? 500;
      const headers =
        payload.error.code === "METHOD_NOT_ALLOWED"
          ? { allow: "GET, PUT" }
          : {};
      sendJson(response, status, payload, headers);
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  context.expectedHost = `${host}:${address.port}`;
  context.origin = `http://${context.expectedHost}`;

  return {
    server,
    origin: context.origin,
    sessionToken,
    projectRoot: fixedProjectRoot,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}
