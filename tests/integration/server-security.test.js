import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_JSON_BODY_BYTES,
  resolveProjectPath,
  startLocalServer,
} from "../../app/server/index.js";
import {
  initializeProject,
  newProjectSettings,
} from "../../core/project/index.js";

const programRoot = fileURLToPath(new URL("../../", import.meta.url));

function request(origin, { method = "GET", path = "/", headers = {}, body } = {}) {
  const url = new URL(origin);
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        method,
        path,
        headers,
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolveRequest({
            status: incoming.statusCode,
            headers: incoming.headers,
            text,
            json: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    outgoing.on("error", rejectRequest);
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}

function readStartupJson(child) {
  return new Promise((resolveStartup, rejectStartup) => {
    let output = "";
    const timeout = setTimeout(
      () => rejectStartup(new Error("개발 서버 시작 JSON 시간 초과")),
      5_000,
    );
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      try {
        const parsed = JSON.parse(output);
        clearTimeout(timeout);
        resolveStartup(parsed);
      } catch {
        // Pretty-printed JSON is expected to arrive in more than one chunk.
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectStartup(error);
    });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        rejectStartup(new Error(`개발 서버가 ${code}로 종료됨`));
      }
    });
  });
}

describe("W03 local server boundary", () => {
  let sandbox;
  let root;
  let local;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "borido-w03-"));
    root = join(sandbox, "project");
    await initializeProject({
      root,
      programRoot,
      settings: newProjectSettings({
        siteName: "W03 격리 프로젝트",
        defaultLanguage: "ko",
        timezone: "Asia/Seoul",
      }),
    });
    local = await startLocalServer({ projectRoot: root });
  });

  afterEach(async () => {
    if (local?.server.listening) await local.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  function sessionHeaders(extra = {}) {
    return { "x-borido-session": local.sessionToken, ...extra };
  }

  it("binds to loopback and opens only the fixed project", async () => {
    expect(local.server.address().address).toBe("127.0.0.1");
    expect(local.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const health = await request(local.origin, { path: "/health" });
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ ok: true });

    const project = await request(local.origin, {
      path: "/api/v1/project",
      headers: sessionHeaders(),
    });
    expect(project.status).toBe(200);
    expect(project.json.project.settings.site_name).toBe("W03 격리 프로젝트");
    expect(project.headers["cache-control"]).toBe("no-store");
    expect(project.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("requires the exact Host, Origin, and session at their boundaries", async () => {
    const wrongHost = await request(local.origin, {
      path: "/api/v1/project",
      headers: sessionHeaders({ host: "attacker.example" }),
    });
    expect(wrongHost.status).toBe(403);
    expect(wrongHost.json.error.code).toBe("INVALID_HOST");

    const missingSession = await request(local.origin, {
      path: "/api/v1/project",
    });
    expect(missingSession.status).toBe(401);
    expect(missingSession.json.error.code).toBe("INVALID_SESSION");

    const wrongOrigin = await request(local.origin, {
      path: "/api/v1/project",
      headers: sessionHeaders({ origin: "https://attacker.example" }),
    });
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.json.error.code).toBe("INVALID_ORIGIN");
    expect(wrongOrigin.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("updates settings only with JSON, exact Origin, session, and revision", async () => {
    const current = await request(local.origin, {
      path: "/api/v1/project",
      headers: sessionHeaders(),
    });
    const body = JSON.stringify({
      settings: { ...current.json.project.settings, site_name: "변경된 사이트" },
      expected_revision: current.json.project.settings_revision,
    });

    const missingOrigin = await request(local.origin, {
      method: "PUT",
      path: "/api/v1/project/settings",
      headers: sessionHeaders({ "content-type": "application/json" }),
      body,
    });
    expect(missingOrigin.status).toBe(403);
    expect(missingOrigin.json.error.code).toBe("INVALID_ORIGIN");

    const updated = await request(local.origin, {
      method: "PUT",
      path: "/api/v1/project/settings",
      headers: sessionHeaders({
        origin: local.origin,
        "content-type": "application/json; charset=utf-8",
      }),
      body,
    });
    expect(updated.status).toBe(200);
    expect(updated.json.project.settings.site_name).toBe("변경된 사이트");

    const stale = await request(local.origin, {
      method: "PUT",
      path: "/api/v1/project/settings",
      headers: sessionHeaders({
        origin: local.origin,
        "content-type": "application/json",
      }),
      body,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("PROJECT_REVISION_CONFLICT");
  });

  it("rejects traversal, encoded separators, absolute targets, and file exposure", async () => {
    for (const path of [
      "/../config/site.json",
      "/%2e%2e/config/site.json",
      "/api%2f..%2fconfig/site.json",
      "//attacker.example/health",
    ]) {
      const response = await request(local.origin, {
        path,
        headers: sessionHeaders(),
      });
      expect(response.status).toBe(400);
      expect(response.json.error.code).toBe("INVALID_REQUEST_PATH");
    }

    const config = await request(local.origin, {
      path: "/config/site.json",
      headers: sessionHeaders(),
    });
    expect(config.status).toBe(404);
    expect(config.text).not.toContain("W03 격리 프로젝트");
  });

  it("rejects unsupported methods, media types, malformed and oversized JSON", async () => {
    const options = await request(local.origin, {
      method: "OPTIONS",
      path: "/api/v1/project/settings",
      headers: sessionHeaders({ origin: local.origin }),
    });
    expect(options.status).toBe(405);
    expect(options.headers["access-control-allow-origin"]).toBeUndefined();

    const wrongType = await request(local.origin, {
      method: "PUT",
      path: "/api/v1/project/settings",
      headers: sessionHeaders({ origin: local.origin, "content-type": "text/plain" }),
      body: "{}",
    });
    expect(wrongType.status).toBe(415);

    const malformed = await request(local.origin, {
      method: "PUT",
      path: "/api/v1/project/settings",
      headers: sessionHeaders({
        origin: local.origin,
        "content-type": "application/json",
      }),
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.json.error.code).toBe("INVALID_JSON");

    const oversizedBody = JSON.stringify({ value: "x".repeat(MAX_JSON_BODY_BYTES) });
    const oversized = await request(local.origin, {
      method: "PUT",
      path: "/api/v1/project/settings",
      headers: sessionHeaders({
        origin: local.origin,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(oversizedBody),
      }),
      body: oversizedBody,
    });
    expect(oversized.status).toBe(413);
    expect(oversized.json.error).toMatchObject({
      code: "REQUEST_TOO_LARGE",
      details: { limit: MAX_JSON_BODY_BYTES },
    });
  });

  it("resolves project paths without following symlinks outside the root", async () => {
    const safe = await resolveProjectPath(root, "config/site.json");
    expect(await readFile(safe.path, "utf8")).toContain("W03 격리 프로젝트");

    await expect(resolveProjectPath(root, "../outside.txt")).rejects.toMatchObject({
      code: "INVALID_PROJECT_PATH",
    });
    await expect(resolveProjectPath(root, "/etc/passwd")).rejects.toMatchObject({
      code: "INVALID_PROJECT_PATH",
    });

    const outside = join(sandbox, "outside.txt");
    await writeFile(outside, "외부 비밀", "utf8");
    await symlink(outside, join(root, "media", "outside-link"));
    await expect(
      resolveProjectPath(root, "media/outside-link"),
    ).rejects.toMatchObject({ code: "PROJECT_PATH_SYMLINK_ESCAPE" });
  });

  it("refuses non-loopback binding", async () => {
    await expect(
      startLocalServer({ projectRoot: root, host: "0.0.0.0" }),
    ).rejects.toMatchObject({ code: "SERVER_HOST_NOT_ALLOWED" });
  });

  it("starts and stops through the documented dev CLI", async () => {
    const child = spawn(
      process.execPath,
      ["scripts/dev.mjs", "--project", root],
      { cwd: programRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      const startup = await readStartupJson(child);
      expect(startup).toMatchObject({ ok: true, project_root: local.projectRoot });
      expect(startup.session_token).toHaveLength(43);
      const health = await request(startup.origin, { path: "/health" });
      expect(health.json).toEqual({ ok: true });
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    }
  });

  it("uses the reserved integrated project when dev has no project argument", async () => {
    const child = spawn(process.execPath, ["scripts/dev.mjs"], {
      cwd: programRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const startup = await readStartupJson(child);
      expect(startup).toMatchObject({
        ok: true,
        project_root: join(programRoot, "project"),
        mode: "existing",
      });
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    }
  });
});
