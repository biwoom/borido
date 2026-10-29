import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startLocalServer } from "../../app/server/index.js";

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
          const type = incoming.headers["content-type"] ?? "";
          resolveRequest({
            status: incoming.statusCode,
            headers: incoming.headers,
            text,
            json: type.startsWith("application/json") ? JSON.parse(text) : null,
          });
        });
      },
    );
    outgoing.on("error", rejectRequest);
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}

describe("W04 admin bootstrap and first run", () => {
  const sandboxes = [];
  const servers = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((local) =>
        local.server.listening ? local.close() : Promise.resolve(),
      ),
    );
    await Promise.all(
      sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function sandbox() {
    const path = await mkdtemp(join(tmpdir(), "borido-w04-"));
    sandboxes.push(path);
    return path;
  }

  async function start(projectRoot) {
    const local = await startLocalServer({ projectRoot });
    servers.push(local);
    return local;
  }

  function apiHeaders(local, extra = {}) {
    return { "x-borido-session": local.sessionToken, ...extra };
  }

  function mutationHeaders(local) {
    return apiHeaders(local, {
      origin: local.origin,
      "content-type": "application/json",
    });
  }

  const input = {
    site_name: "보리도 첫 사이트",
    description: "오프라인으로 시작한 사이트",
    default_language: "ko",
    author_name: "담진",
    license: "CC BY 4.0",
    timezone: "Asia/Seoul",
    public_url: "https://example.github.io/library/",
  };

  it("serves only fixed admin assets with browser security headers", async () => {
    const root = join(await sandbox(), "new-project");
    const local = await start(root);

    const page = await request(local.origin);
    expect(page.status).toBe(200);
    expect(page.text).toContain("보리도 로컬 편집기");
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(page.headers["x-frame-options"]).toBe("DENY");

    const stylesheet = await request(local.origin, { path: "/assets/admin.css" });
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers["content-type"]).toContain("text/css");

    const tokens = await request(local.origin, { path: "/assets/tokens.css" });
    expect(tokens.status).toBe(200);
    expect(tokens.text).toContain("--borido-accent: #f0b100");
    expect(tokens.text).toContain("--borido-secondary: #00c951");

    const projectFile = await request(local.origin, { path: "/config/site.json" });
    expect(projectFile.status).toBe(401);
  });

  it("initializes the fixed missing root, then reopens it without GitHub", async () => {
    const root = join(await sandbox(), "new-project");
    const local = await start(root);

    const before = await request(local.origin, {
      path: "/api/v1/bootstrap",
      headers: apiHeaders(local),
    });
    expect(before.json.bootstrap).toMatchObject({ mode: "new", root, project: null });

    const created = await request(local.origin, {
      method: "POST",
      path: "/api/v1/project",
      headers: mutationHeaders(local),
      body: JSON.stringify({ input }),
    });
    expect(created.status).toBe(201);
    expect(created.json.project.settings).toMatchObject({
      site_name: input.site_name,
      base_url: "https://example.github.io",
      base_path: "/library/",
      source_repository: null,
      deployment: null,
    });

    const saved = JSON.parse(await readFile(join(root, "config", "site.json"), "utf8"));
    expect(saved).toEqual(created.json.project.settings);

    await local.close();
    servers.splice(servers.indexOf(local), 1);
    const reopened = await start(root);
    const after = await request(reopened.origin, {
      path: "/api/v1/bootstrap",
      headers: apiHeaders(reopened),
    });
    expect(after.json.bootstrap).toMatchObject({
      mode: "existing",
      project: { settings: { site_name: input.site_name } },
    });
  });

  it("preserves repository fields when the simple settings form is saved", async () => {
    const root = join(await sandbox(), "new-project");
    const local = await start(root);
    const created = await request(local.origin, {
      method: "POST",
      path: "/api/v1/project",
      headers: mutationHeaders(local),
      body: JSON.stringify({ input }),
    });

    const updated = await request(local.origin, {
      method: "PUT",
      path: "/api/v1/project/settings",
      headers: mutationHeaders(local),
      body: JSON.stringify({
        input: { ...input, description: "다시 연 뒤 바꾼 설명", public_url: "" },
        expected_revision: created.json.project.settings_revision,
      }),
    });
    expect(updated.status).toBe(200);
    expect(updated.json.project.settings).toMatchObject({
      description: "다시 연 뒤 바꾼 설명",
      base_url: null,
      base_path: "/",
      source_repository: null,
      deployment: null,
    });
  });

  it("blocks an existing non-project directory and never overwrites it", async () => {
    const parent = await sandbox();
    const root = join(parent, "occupied");
    await mkdir(root);
    await writeFile(join(root, "keep.txt"), "보존해야 하는 자료", "utf8");
    const local = await start(root);

    const bootstrap = await request(local.origin, {
      path: "/api/v1/bootstrap",
      headers: apiHeaders(local),
    });
    expect(bootstrap.json.bootstrap).toMatchObject({
      mode: "blocked",
      error: { code: "PROJECT_STRUCTURE_INCOMPLETE" },
    });

    const attempted = await request(local.origin, {
      method: "POST",
      path: "/api/v1/project",
      headers: mutationHeaders(local),
      body: JSON.stringify({ input }),
    });
    expect(attempted.status).toBe(409);
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("보존해야 하는 자료");
  });

  it("returns a client error when the fixed new root cannot be initialized", async () => {
    const parent = await sandbox();
    const root = join(parent, "missing-parent", "project");
    const local = await start(root);

    const attempted = await request(local.origin, {
      method: "POST",
      path: "/api/v1/project",
      headers: mutationHeaders(local),
      body: JSON.stringify({ input }),
    });
    expect(attempted.status).toBe(400);
    expect(attempted.json.error.code).toBe("PROJECT_PARENT_NOT_FOUND");
  });
});
