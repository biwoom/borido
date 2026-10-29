import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAssetResolver,
  renderMarkdown,
  selectPublicMedia,
} from "../../core/content/index.js";

const ids = {
  image: "20000000-0000-4000-8000-000000000001",
  pdf: "20000000-0000-4000-8000-000000000002",
  privateImage: "20000000-0000-4000-8000-000000000003",
  unused: "20000000-0000-4000-8000-000000000004",
  missing: "20000000-0000-4000-8000-000000000005",
  document: "10000000-0000-4000-8000-000000000001",
  privateDocument: "10000000-0000-4000-8000-000000000002",
  story: "10000000-0000-4000-8000-000000000003",
};

function asset(id, filePath, mediaType, status = "published") {
  return { id, file_path: filePath, media_type: mediaType, status };
}

describe("W13 public media resolution and selection", () => {
  const sandboxes = [];

  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function project() {
    const root = await mkdtemp(join(tmpdir(), "borido-w13-"));
    sandboxes.push(root);
    await mkdir(join(root, "media", "images"), { recursive: true });
    await mkdir(join(root, "media", "documents"), { recursive: true });
    await mkdir(join(root, "media", "icons"), { recursive: true });
    await writeFile(join(root, "media", "images", "cover.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    await writeFile(join(root, "media", "images", "private.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    await writeFile(join(root, "media", "images", "unused.jpg"), Buffer.from([255, 216, 255, 0]));
    await writeFile(join(root, "media", "documents", "source.pdf"), Buffer.from("%PDF-1.7\n"));
    await writeFile(join(root, "media", "images", "unregistered.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const assets = [
      asset(ids.image, "media/images/cover.png", "image/png"),
      asset(ids.pdf, "media/documents/source.pdf", "application/pdf"),
      asset(ids.privateImage, "media/images/private.png", "image/png", "private"),
      asset(ids.unused, "media/images/unused.jpg", "image/jpeg"),
    ];
    return { root, index: { assets } };
  }

  it("resolves only registered published assets to stable prefixed URLs", async () => {
    const { index } = await project();
    const resolver = createAssetResolver(index, { basePath: "/borido/" });

    expect(resolver({ id: ids.image })).toEqual({
      ok: true,
      url: `/borido/assets/media/${ids.image}.png`,
    });
    expect(resolver({ id: ids.privateImage })).toMatchObject({ code: "ASSET_REFERENCE_NOT_PUBLIC" });
    expect(resolver({ id: ids.missing })).toMatchObject({ code: "ASSET_REFERENCE_MISSING" });

    const moved = { assets: [{ ...index.assets[0], file_path: "media/images/moved.png" }] };
    expect(createAssetResolver(moved, { basePath: "/borido/" })({ id: ids.image }).url).toBe(
      `/borido/assets/media/${ids.image}.png`,
    );
  });

  it("selects shared public references, featured media, and common assets once", async () => {
    const { root, index } = await project();
    const resolveAsset = createAssetResolver(index, { basePath: "/borido/" });
    const publicMarkdown = renderMarkdown(
      `![표지](asset:${ids.image})\n\n[PDF](asset:${ids.pdf})`,
      { resolveAsset },
    );
    const privateMarkdown = renderMarkdown(`![비공개](asset:${ids.privateImage})`, {
      resolveAsset,
    });
    const publicRecords = [
      { id: ids.document, type: "text_document", data: {} },
      { id: ids.story, type: "story", data: { featured_media_id: ids.image } },
    ];
    const result = await selectPublicMedia({
      root,
      index,
      publicRecords,
      markdownResults: new Map([
        [ids.document, publicMarkdown],
        [ids.privateDocument, privateMarkdown],
      ]),
      commonAssetIds: [ids.image],
      basePath: "/borido/",
    });

    expect(result.ok).toBe(true);
    expect(result.used_asset_ids).toEqual([ids.image, ids.pdf]);
    expect(result.copy_plan).toEqual([
      expect.objectContaining({
        id: ids.image,
        output_path: `assets/media/${ids.image}.png`,
        url: `/borido/assets/media/${ids.image}.png`,
      }),
      expect.objectContaining({
        id: ids.pdf,
        output_path: `assets/media/${ids.pdf}.pdf`,
      }),
    ]);
    expect(result.copy_plan[0].usages).toHaveLength(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MEDIA_ASSET_UNUSED", asset_id: ids.privateImage }),
      expect.objectContaining({ code: "MEDIA_ASSET_UNUSED", asset_id: ids.unused }),
      expect.objectContaining({ code: "MEDIA_FILE_UNREGISTERED" }),
    ]));
  });

  it("blocks missing/private assets and documents used as images", async () => {
    const { root, index } = await project();
    const publicRecords = [{ id: ids.document, type: "text_document", data: {} }];
    const references = {
      references: [
        { kind: "asset", id: ids.privateImage, context: "image" },
        { kind: "asset", id: ids.missing, context: "link" },
        { kind: "asset", id: ids.pdf, context: "image" },
      ],
    };
    const result = await selectPublicMedia({
      root,
      index,
      publicRecords,
      markdownResults: { [ids.document]: references },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "ASSET_REFERENCE_NOT_PUBLIC",
      "ASSET_REFERENCE_MISSING",
      "MEDIA_CONTEXT_TYPE_INVALID",
    ]));
    expect(result.copy_plan).toEqual([]);
  });

  it("checks extensions, signatures, supported types, and size limits", async () => {
    const { root } = await project();
    await writeFile(join(root, "media", "images", "wrong.png"), Buffer.from("not png"));
    await writeFile(join(root, "media", "images", "vector.svg"), "<svg></svg>");
    await writeFile(join(root, "media", "images", "huge.jpg"), Buffer.from([255, 216, 255]));
    await truncate(join(root, "media", "images", "huge.jpg"), 20 * 1024 * 1024 + 1);
    const wrong = asset(ids.image, "media/images/wrong.png", "image/png");
    const unsupported = asset(ids.pdf, "media/images/vector.svg", "image/svg+xml");
    const huge = asset(ids.unused, "media/images/huge.jpg", "image/jpeg");
    const index = { assets: [wrong, unsupported, huge] };
    const publicRecords = [{ id: ids.document, type: "text_document", data: {} }];
    const result = await selectPublicMedia({
      root,
      index,
      publicRecords,
      markdownResults: {
        [ids.document]: {
          references: [wrong, unsupported, huge].map((item) => ({
            kind: "asset", id: item.id, context: "link",
          })),
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "MEDIA_SIGNATURE_MISMATCH",
      "MEDIA_TYPE_UNSUPPORTED",
      "MEDIA_FILE_TOO_LARGE",
    ]));
  });
});
