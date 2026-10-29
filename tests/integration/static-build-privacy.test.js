import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildProject, snapshotBuildInputs } from "../../core/content/index.js";
import { createSiteSettings, initializeProject } from "../../core/project/index.js";

const ids = {
  publicStory: "10000000-0000-4000-8000-000000000011",
  privatePage: "10000000-0000-4000-8000-000000000012",
  publicImage: "20000000-0000-4000-8000-000000000011",
  privateImage: "20000000-0000-4000-8000-000000000012",
};

async function missing(path) {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

describe("W16 privacy and stale-output regression", () => {
  const roots = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("excludes private source/media and removes formerly public files on rebuild", async () => {
    const parent = await mkdtemp(join(tmpdir(), "borido-w16-parent-"));
    roots.push(parent);
    const root = join(parent, "site");
    await initializeProject({
      root,
      settings: createSiteSettings({ siteName: "공개 경계", defaultLanguage: "ko", timezone: "Asia/Seoul" }),
    });
    const storyDirectory = join(root, "content", "stories", "public-story");
    const privateDirectory = join(root, "content", "pages", "private-page");
    await mkdir(storyDirectory, { recursive: true });
    await mkdir(privateDirectory, { recursive: true });
    const storyMeta = {
      schema_version: 1, id: ids.publicStory, type: "story", title: "공개 이야기", slug: "public-story",
      status: "published", created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z", body_file: "story.md",
    };
    await writeFile(join(storyDirectory, "meta.json"), `${JSON.stringify(storyMeta, null, 2)}\n`);
    await writeFile(join(storyDirectory, "story.md"), `![공개 그림](asset:${ids.publicImage})\n\nPUBLIC-CONTENT-MARKER\n`);
    await writeFile(join(privateDirectory, "meta.json"), `${JSON.stringify({
      schema_version: 1, id: ids.privatePage, type: "page", title: "비공개 문서", slug: "private-page",
      status: "private", created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z", body_file: "page.md",
    }, null, 2)}\n`);
    await writeFile(join(privateDirectory, "page.md"), `PRIVATE-LEAK-MARKER-NEVER-PUBLISH\n\n![비공개](asset:${ids.privateImage})\n`);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    await writeFile(join(root, "media", "images", "public.png"), png);
    await writeFile(join(root, "media", "images", "private.png"), png);
    await writeFile(join(root, "media", "assets.json"), `${JSON.stringify({
      schema_version: 1,
      assets: [
        { id: ids.publicImage, file_path: "media/images/public.png", media_type: "image/png", status: "published" },
        { id: ids.privateImage, file_path: "media/images/private.png", media_type: "image/png", status: "published" },
      ],
    }, null, 2)}\n`);

    const first = await buildProject({ root });
    expect(first.ok).toBe(true);
    const allPublicText = [
      await readFile(join(root, "dist", "stories", "public-story", "index.html"), "utf8"),
      await readFile(join(root, "dist", "search-index.json"), "utf8"),
      await readFile(join(root, "dist", "sitemap.xml"), "utf8"),
    ].join("\n");
    expect(allPublicText).not.toContain("PRIVATE-LEAK-MARKER-NEVER-PUBLISH");
    expect(allPublicText).not.toContain(ids.privatePage);
    expect(await missing(join(root, "dist", `assets/media/${ids.privateImage}.png`))).toBe(true);
    expect(await missing(join(root, "dist", `assets/media/${ids.publicImage}.png`))).toBe(false);

    await writeFile(join(storyDirectory, "meta.json"), `${JSON.stringify({ ...storyMeta, status: "private" }, null, 2)}\n`);
    const beforeSecondBuild = await snapshotBuildInputs(root);
    const second = await buildProject({ root });
    const afterSecondBuild = await snapshotBuildInputs(root);
    expect(second.ok).toBe(true);
    expect(afterSecondBuild).toEqual(beforeSecondBuild);
    expect(await missing(join(root, "dist", "stories", "public-story", "index.html"))).toBe(true);
    expect(await missing(join(root, "dist", `assets/media/${ids.publicImage}.png`))).toBe(true);
    const search = await readFile(join(root, "dist", "search-index.json"), "utf8");
    expect(search).not.toContain(ids.publicStory);
    expect(search).not.toContain("PUBLIC-CONTENT-MARKER");
  });
});
