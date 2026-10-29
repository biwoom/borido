import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSiteSettings, initializeProject } from "../../core/project/index.js";
import { startPreviewServer } from "../../core/preview/server.js";

describe("read-only public preview server", () => {
  const resources = [];
  afterEach(async () => {
    await Promise.all(resources.splice(0).map(async (item) => {
      if (item.close) await item.close().catch(() => {});
      else await rm(item.root, { recursive: true, force: true });
    }));
  });

  async function fixture({ withDist = true } = {}) {
    const parent = await mkdtemp(join(tmpdir(), "borido-preview-"));
    resources.push({ root: parent });
    const root = join(parent, "site");
    await initializeProject({
      root,
      settings: createSiteSettings({ siteName: "미리보기", defaultLanguage: "ko", timezone: "Asia/Seoul", publicUrl: "https://example.test/borido/" }),
    });
    if (withDist) {
      await writeFile(join(root, "dist", "index.html"), "<h1>홈</h1>");
      await mkdir(join(root, "dist", "pages", "about"), { recursive: true });
      await writeFile(join(root, "dist", "pages", "about", "index.html"), "<h1>소개</h1>");
    } else {
      await rm(join(root, "dist"), { recursive: true });
    }
    return root;
  }

  it("serves only dist below the configured base path", async () => {
    const root = await fixture();
    const preview = await startPreviewServer({ root });
    resources.push(preview);
    const origin = new URL(preview.url).origin;
    expect((await fetch(`${origin}/`, { redirect: "manual" })).headers.get("location")).toBe("/borido/");
    const page = await fetch(`${origin}/borido/pages/about/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("소개");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${origin}/borido/../config/site.json`)).status).toBe(404);
    expect((await fetch(`${origin}/borido/.borido/builds/latest.json`)).status).toBe(404);
    expect((await fetch(`${origin}/borido/pages/about/`, { method: "POST" })).status).toBe(405);
  });

  it("rejects a forged Host header", async () => {
    const root = await fixture();
    const preview = await startPreviewServer({ root });
    resources.push(preview);
    const status = await new Promise((resolve, reject) => {
      const call = request(preview.url, { headers: { host: "evil.example" } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      call.on("error", reject);
      call.end();
    });
    expect(status).toBe(400);
  });

  it("requires a completed build directory", async () => {
    const root = await fixture({ withDist: false });
    await expect(startPreviewServer({ root })).rejects.toMatchObject({ code: "PREVIEW_DIST_MISSING" });
  });
});
