import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  errorResponse,
  initializeProject,
  newProjectSettings,
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

const ADMIN_ASSETS = new Map([
  [
    "/",
    {
      path: fileURLToPath(new URL("../admin/index.html", import.meta.url)),
      type: "text/html; charset=utf-8",
    },
  ],
  [
    "/index.html",
    {
      path: fileURLToPath(new URL("../admin/index.html", import.meta.url)),
      type: "text/html; charset=utf-8",
    },
  ],
  [
    "/assets/tokens.css",
    {
      path: fileURLToPath(new URL("../admin/styles/tokens.css", import.meta.url)),
      type: "text/css; charset=utf-8",
    },
  ],
  [
    "/assets/admin.css",
    {
      path: fileURLToPath(new URL("../admin/styles/admin.css", import.meta.url)),
      type: "text/css; charset=utf-8",
    },
  ],
  [
    "/assets/admin.js",
    {
      path: fileURLToPath(new URL("../admin/scripts/admin.js", import.meta.url)),
      type: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/assets/basecoat.css",
    {
      path: fileURLToPath(import.meta.resolve("basecoat-css")),
      type: "text/css; charset=utf-8",
    },
  ],
]);

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const STATUS_BY_CODE = new Map([
  ["INVALID_PROJECT_ROOT", 400],
  ["INVALID_REQUEST_PATH", 400],
  ["INVALID_REQUEST_QUERY", 400],
  ["INVALID_JSON", 400],
  ["INVALID_SITE_SETTINGS", 400],
  ["SITE_SETTINGS_FORBIDDEN_SECRET", 400],
  ["UNSUPPORTED_SITE_SCHEMA", 400],
  ["PROJECT_PARENT_NOT_FOUND", 400],
  ["PROJECT_PARENT_NOT_DIRECTORY", 400],
  ["PROJECT_INSIDE_PROGRAM_ROOT", 400],
  ["INVALID_SESSION", 401],
  ["INVALID_HOST", 403],
  ["INVALID_ORIGIN", 403],
  ["PROJECT_PERMISSION_DENIED", 403],
  ["NOT_FOUND", 404],
  ["METHOD_NOT_ALLOWED", 405],
  ["PROJECT_REVISION_CONFLICT", 409],
  ["PROJECT_NOT_READY", 409],
  ["PROJECT_TARGET_EXISTS", 409],
  ["PROJECT_NOT_DIRECTORY", 409],
  ["PROJECT_NOT_INITIALIZED", 409],
  ["PROJECT_STRUCTURE_INCOMPLETE", 409],
  ["PROJECT_INITIALIZATION_INCOMPLETE", 409],
  ["INVALID_SITE_JSON", 409],
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

async function sendAdminAsset(response, asset) {
  const content = await readFile(asset.path);
  response.writeHead(200, {
    "content-type": asset.type,
    "content-length": content.length,
    "cache-control": "no-store",
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
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
  const unknown = Object.keys(value).filter((key) =>
    !["settings", "input", "expected_revision"].includes(key),
  );
  if (
    unknown.length > 0 ||
    (!value.settings && !value.input) ||
    (value.settings && value.input) ||
    (value.settings && typeof value.settings !== "object") ||
    (value.input && typeof value.input !== "object") ||
    typeof value.expected_revision !== "string"
  ) {
    throw new ProjectError(
      "INVALID_JSON",
      "settings 또는 input과 expected_revision만 포함한 요청이 필요합니다.",
    );
  }
  return value;
}

function assertInitializationBody(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !value.input ||
    typeof value.input !== "object" ||
    Array.isArray(value.input)
  ) {
    throw new ProjectError(
      "INVALID_JSON",
      "input만 포함한 프로젝트 초기화 요청이 필요합니다.",
    );
  }
  return value.input;
}

function siteSettingsFromInput(input, existing = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProjectError("INVALID_JSON", "사이트 설정 input 객체가 필요합니다.");
  }
  const allowed = new Set([
    "site_name",
    "description",
    "default_language",
    "author_name",
    "license",
    "timezone",
    "public_url",
  ]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ProjectError("INVALID_JSON", "지원하지 않는 사이트 입력 필드입니다.", {
      fields: unknown,
    });
  }
  return newProjectSettings({
    siteName: input.site_name,
    description: input.description ?? "",
    defaultLanguage: input.default_language,
    authorName: input.author_name ?? "",
    license: input.license ?? "",
    timezone: input.timezone,
    publicUrl: input.public_url || null,
    sourceRepository: existing?.source_repository ?? null,
    deployment: existing?.deployment ?? null,
  });
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

  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    throw new ProjectError("INVALID_PROJECT_ROOT", "프로젝트 루트를 명시해야 합니다.");
  }
  let fixedProjectRoot = resolve(projectRoot);
  let projectState;
  try {
    const opened = await openProject({ root: fixedProjectRoot });
    fixedProjectRoot = opened.project.root;
    projectState = { mode: "existing", project: opened.project };
  } catch (error) {
    if (error instanceof ProjectError && error.code === "PROJECT_NOT_FOUND") {
      projectState = { mode: "new", project: null };
    } else if (error instanceof ProjectError) {
      projectState = { mode: "blocked", project: null, error: error.toJSON() };
    } else {
      throw error;
    }
  }
  const context = { expectedHost: null, origin: null };

  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    try {
      validateHost(request, context.expectedHost);
      const path = parseRequestTarget(request.url);

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      const adminAsset = ADMIN_ASSETS.get(path);
      if (request.method === "GET" && adminAsset) {
        await sendAdminAsset(response, adminAsset);
        return;
      }

      validateSession(request, sessionToken);
      validateOrigin(request, context.origin, { required: request.method !== "GET" });

      if (request.method === "GET" && path === "/api/v1/bootstrap") {
        sendJson(response, 200, {
          ok: true,
          bootstrap: {
            mode: projectState.mode,
            root: fixedProjectRoot,
            project: projectState.project,
            error: projectState.error ?? null,
          },
        });
        return;
      }

      if (request.method === "POST" && path === "/api/v1/project") {
        if (projectState.mode !== "new") {
          throw new ProjectError(
            "PROJECT_NOT_READY",
            "이 서버 시작 경로에서는 새 프로젝트를 초기화할 수 없습니다.",
          );
        }
        const input = assertInitializationBody(
          await readJsonBody(request, MAX_JSON_BODY_BYTES),
        );
        const initialized = await initializeProject({
          root: fixedProjectRoot,
          settings: siteSettingsFromInput(input),
        });
        fixedProjectRoot = initialized.project.root;
        projectState = { mode: "existing", project: initialized.project };
        sendJson(response, 201, initialized);
        return;
      }

      if (request.method === "GET" && path === "/api/v1/project") {
        if (projectState.mode !== "existing") {
          throw new ProjectError(
            "PROJECT_NOT_READY",
            "프로젝트가 아직 열리지 않았습니다.",
          );
        }
        const opened = await openProject({ root: fixedProjectRoot });
        projectState.project = opened.project;
        sendJson(response, 200, opened);
        return;
      }

      if (request.method === "PUT" && path === "/api/v1/project/settings") {
        const body = assertSettingsBody(
          await readJsonBody(request, MAX_JSON_BODY_BYTES),
        );
        if (projectState.mode !== "existing") {
          throw new ProjectError(
            "PROJECT_NOT_READY",
            "프로젝트가 아직 열리지 않았습니다.",
          );
        }
        const settings = body.input
          ? siteSettingsFromInput(body.input, projectState.project.settings)
          : body.settings;
        const updated = await writeProjectSettings({
          root: fixedProjectRoot,
          settings,
          expectedRevision: body.expected_revision,
        });
        projectState.project = updated.project;
        sendJson(
          response,
          200,
          updated,
        );
        return;
      }

      const knownPath = [
        "/api/v1/bootstrap",
        "/api/v1/project",
        "/api/v1/project/settings",
      ].includes(path);
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
    mode: projectState.mode,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}
