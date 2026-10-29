import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { lstat, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { openProject, ProjectError } from "../project/index.js";

const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
});

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...headers,
  });
  response.end(body);
}

function requestPath(target) {
  if (typeof target !== "string" || !target.startsWith("/") || /%2f|%5c|\\/iu.test(target)) {
    throw new ProjectError("PREVIEW_PATH_INVALID", "미리보기 요청 경로가 유효하지 않습니다.");
  }
  let url;
  try {
    url = new URL(target, "http://preview.local");
  } catch {
    throw new ProjectError("PREVIEW_PATH_INVALID", "미리보기 요청 경로가 유효하지 않습니다.");
  }
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw new ProjectError("PREVIEW_PATH_INVALID", "미리보기 요청 경로 인코딩이 유효하지 않습니다.");
  }
  if (path.split("/").some((part) => part === "." || part === "..")) {
    throw new ProjectError("PREVIEW_PATH_INVALID", "미리보기 상위 경로 접근은 허용하지 않습니다.");
  }
  return path;
}

function inside(root, target) {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

async function previewFile(distRoot, relativePath) {
  const candidate = resolve(distRoot, relativePath || "index.html");
  if (!inside(distRoot, candidate)) return null;
  let information;
  try {
    information = await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const path = information.isDirectory() ? join(candidate, "index.html") : candidate;
  let canonical;
  try {
    canonical = await realpath(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!inside(distRoot, canonical)) return null;
  const finalInfo = await lstat(canonical);
  return finalInfo.isFile() ? { path: canonical, size: finalInfo.size } : null;
}

export async function startPreviewServer({ root, port = 0 }) {
  const opened = await openProject({ root });
  const projectRoot = opened.project.root;
  const distPath = join(projectRoot, "dist");
  let distRoot;
  try {
    distRoot = await realpath(distPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ProjectError("PREVIEW_DIST_MISSING", "정적 결과가 없습니다. 먼저 npm run build를 실행하세요.");
    }
    throw error;
  }
  if (!(await lstat(distRoot)).isDirectory()) {
    throw new ProjectError("PREVIEW_DIST_INVALID", "project/dist가 폴더가 아닙니다.");
  }
  const basePath = opened.project.settings.base_path;
  const context = { host: null };
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== context.host) {
        send(response, 400, "Invalid Host");
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        send(response, 405, "Method Not Allowed", { allow: "GET, HEAD" });
        return;
      }
      const path = requestPath(request.url);
      if (basePath !== "/" && path === "/") {
        send(response, 302, "", { location: basePath });
        return;
      }
      if (basePath !== "/" && !path.startsWith(basePath)) {
        send(response, 404, "Not Found");
        return;
      }
      const relativePath = (basePath === "/" ? path : path.slice(basePath.length - 1)).replace(/^\//u, "");
      const file = await previewFile(distRoot, relativePath);
      if (!file) {
        send(response, 404, "Not Found");
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": file.size,
        "content-type": CONTENT_TYPES[extname(file.path).toLowerCase()] ?? "application/octet-stream",
        "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(file.path).pipe(response);
    } catch {
      send(response, 400, "Bad Request");
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  context.host = `127.0.0.1:${address.port}`;
  const url = `http://${context.host}${basePath}`;
  return {
    root: projectRoot,
    dist: distRoot,
    base_path: basePath,
    url,
    server,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}
