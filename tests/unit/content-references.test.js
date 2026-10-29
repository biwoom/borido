import { describe, expect, it } from "vitest";

import {
  findIncomingReferences,
  validateContentReferences,
} from "../../core/content/index.js";

function record({ id, type, status, path, parentId = null, data = {} }) {
  return {
    id,
    type,
    status,
    path,
    parent_id: parentId,
    data: { id, type, status, ...data },
  };
}

describe("W08 content references", () => {
  it("does not report a public-output warning for an effectively hidden source", () => {
    const textId = "10000000-0000-4000-8000-000000000001";
    const sourceId = "10000000-0000-4000-8000-000000000002";
    const targetId = "10000000-0000-4000-8000-000000000003";
    const index = {
      records: [
        record({
          id: textId,
          type: "text",
          status: "draft",
          path: "content/texts/hidden/meta.json",
        }),
        record({
          id: sourceId,
          type: "text_document",
          status: "published",
          parentId: textId,
          path: "content/texts/hidden/translation/source/_node.json",
          data: { related_documents: [targetId] },
        }),
        record({
          id: targetId,
          type: "text_document",
          status: "draft",
          parentId: textId,
          path: "content/texts/hidden/original/target/_node.json",
        }),
      ],
      assets: [],
    };

    expect(validateContentReferences(index)).toEqual([]);
  });

  it("distinguishes missing targets from non-public optional media", () => {
    const storyId = "20000000-0000-4000-8000-000000000001";
    const assetId = "20000000-0000-4000-8000-000000000002";
    const base = record({
      id: storyId,
      type: "story",
      status: "published",
      path: "content/stories/source/meta.json",
      data: { featured_media_id: assetId },
    });

    expect(
      validateContentReferences({
        records: [base],
        assets: [{ id: assetId, status: "private" }],
      }),
    ).toContainEqual(
      expect.objectContaining({
        level: "warning",
        code: "REFERENCE_TARGET_NOT_PUBLIC",
      }),
    );
    expect(
      validateContentReferences({ records: [base], assets: [] }),
    ).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "REFERENCE_TARGET_MISSING",
      }),
    );
  });

  it("returns incoming reference locations for deletion impact", () => {
    const targetId = "30000000-0000-4000-8000-000000000001";
    const source = record({
      id: "30000000-0000-4000-8000-000000000002",
      type: "text",
      status: "draft",
      path: "content/texts/source/meta.json",
      data: { related_texts: [targetId] },
    });
    expect(
      findIncomingReferences({ records: [source], assets: [] }, [targetId]),
    ).toEqual([
      {
        source_id: source.id,
        source_type: "text",
        source_path: source.path,
        field: "related_texts",
        target_id: targetId,
      },
    ]);
  });
});
