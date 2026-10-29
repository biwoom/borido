import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildProject, snapshotBuildInputs } from "../../core/content/index.js";
import { createSiteSettings, initializeProject } from "../../core/project/index.js";

const ids = {
  story: "10000000-0000-4000-8000-000000000001",
  page: "10000000-0000-4000-8000-000000000002",
};

describe("W15 static build activation", () => {
  const roots = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  async function fixture() {
    const parent = await mkdtemp(join(tmpdir(), "borido-w15-parent-"));
    roots.push(parent);
    const root = join(parent, "site");
    await initializeProject({
      root,
      settings: createSiteSettings({
        siteName: "빌드 자료실",
        defaultLanguage: "ko",
        timezone: "Asia/Seoul",
        publicUrl: "https://example.test/borido/",
      }),
    });
    await mkdir(join(root, "content", "stories", "public-story"), { recursive: true });
    await writeFile(join(root, "content", "stories", "public-story", "meta.json"), `${JSON.stringify({
      schema_version: 1, id: ids.story, type: "story", title: "공개 이야기", slug: "public-story",
      status: "published", created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z", body_file: "story.md",
    }, null, 2)}\n`);
    await writeFile(join(root, "content", "stories", "public-story", "story.md"), "## 공개 본문\n\n안전한 내용입니다.\n");
    await mkdir(join(root, "content", "pages", "about"), { recursive: true });
    await writeFile(join(root, "content", "pages", "about", "meta.json"), `${JSON.stringify({
      schema_version: 1, id: ids.page, type: "page", title: "소개", slug: "about",
      status: "published", created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z", body_file: "page.md", menu_visible: true,
    }, null, 2)}\n`);
    await writeFile(join(root, "content", "pages", "about", "page.md"), "소개입니다.\n");
    return root;
  }

  it("builds a complete staged site and keeps source bytes unchanged", async () => {
    const root = await fixture();
    const before = await snapshotBuildInputs(root);
    const result = await buildProject({ root });
    const after = await snapshotBuildInputs(root);

    expect(result.ok).toBe(true);
    expect(after).toEqual(before);
    expect(await readFile(join(root, "dist", "stories", "public-story", "index.html"), "utf8")).toContain("안전한 내용입니다.");
    expect(JSON.parse(await readFile(join(root, "dist", "search-index.json"), "utf8"))).toHaveLength(2);
    expect(JSON.parse(await readFile(join(root, ".borido", "builds", "latest.json"), "utf8"))).toMatchObject({ schema_version: 1 });
  });

  it("preserves the last successful dist when generation fails", async () => {
    const root = await fixture();
    await buildProject({ root });
    const oldHome = await readFile(join(root, "dist", "index.html"), "utf8");
    await writeFile(join(root, "content", "pages", "about", "page.md"), "[없는 문서](doc:10000000-0000-4000-8000-000000000099)\n");

    const failed = await buildProject({ root });
    expect(failed.ok).toBe(false);
    expect(failed.phase).toBe("generation");
    expect(await readFile(join(root, "dist", "index.html"), "utf8")).toBe(oldHome);
  });

  it("rejects a stale build if an input changes before activation", async () => {
    const root = await fixture();
    await writeFile(join(root, "dist", "previous.txt"), "previous");
    await expect(buildProject({
      root,
      hooks: { beforeInputCheck: () => writeFile(join(root, "content", "pages", "about", "page.md"), "changed\n") },
    })).rejects.toMatchObject({ code: "BUILD_INPUT_CHANGED" });
    expect(await readFile(join(root, "dist", "previous.txt"), "utf8")).toBe("previous");
  });

  it("restores the previous dist if activation fails after backup", async () => {
    const root = await fixture();
    await writeFile(join(root, "dist", "previous.txt"), "previous");
    await expect(buildProject({
      root,
      hooks: { afterBackup: () => { throw new Error("injected"); } },
    })).rejects.toMatchObject({ code: "BUILD_ACTIVATION_FAILED" });
    expect(await readFile(join(root, "dist", "previous.txt"), "utf8")).toBe("previous");
  });
});
