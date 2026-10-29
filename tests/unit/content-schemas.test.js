import { describe, expect, it } from "vitest";

import {
  CONTENT_RECORD_TYPES,
  schemaValidators,
} from "../../core/content/index.js";

const common = {
  schema_version: 1,
  id: "10000000-0000-4000-8000-000000000001",
  title: "합성 레코드",
  slug: "synthetic-record",
  status: "draft",
  created_at: "2026-10-29T00:00:00Z",
  updated_at: "2026-10-29T00:00:00Z",
};

describe("W05 content schemas", () => {
  it("exposes only the seven specified content record types", () => {
    expect(CONTENT_RECORD_TYPES).toEqual([
      "text",
      "text_area",
      "tree_node",
      "text_document",
      "story",
      "blog",
      "page",
    ]);
  });

  it("accepts a specified text document and rejects unknown fields", () => {
    const valid = {
      ...common,
      type: "text_document",
      order: 10,
      body_file: "body.md",
      related_documents: [],
    };
    expect(schemaValidators.records.text_document(valid)).toBe(true);

    const unknown = { ...valid, invented: true };
    expect(schemaValidators.records.text_document(unknown)).toBe(false);
    expect(schemaValidators.records.text_document.errors).toContainEqual(
      expect.objectContaining({ keyword: "additionalProperties" }),
    );
  });

  it("rejects wrong UUID versions, local timestamps, and unnormalized slugs", () => {
    const invalid = {
      ...common,
      id: "10000000-0000-3000-8000-000000000001",
      type: "page",
      slug: "한글 Slug",
      created_at: "2026-10-29T09:00:00+09:00",
      body_file: "page.md",
    };
    expect(schemaValidators.records.page(invalid)).toBe(false);
    expect(schemaValidators.records.page.errors?.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects impossible calendar dates and published blogs without a publication date", () => {
    const invalid = {
      ...common,
      type: "blog",
      status: "published",
      created_at: "2026-02-31T00:00:00Z",
      body_file: "post.md",
    };
    expect(schemaValidators.records.blog(invalid)).toBe(false);
    expect(schemaValidators.records.blog.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "format", instancePath: "/created_at" }),
        expect.objectContaining({ keyword: "required" }),
      ]),
    );
  });

  it("keeps media types open while enforcing the confirmed media path contract", () => {
    const media = {
      schema_version: 1,
      assets: [
        {
          id: "10000000-0000-4000-8000-000000000009",
          file_path: "../secret.png",
          media_type: "application/x-future-format",
          status: "private",
        },
      ],
    };
    expect(schemaValidators.media(media)).toBe(false);
    expect(schemaValidators.media.errors).toContainEqual(
      expect.objectContaining({ instancePath: "/assets/0/file_path" }),
    );
  });
});
