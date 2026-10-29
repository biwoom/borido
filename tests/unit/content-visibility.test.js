import { describe, expect, it } from "vitest";

import { evaluatePublication, selectPublicRecords } from "../../core/content/index.js";

function record(id, type, status, parentId = null, bodyFile = undefined) {
  return {
    id,
    type,
    status,
    parent_id: parentId,
    data: bodyFile ? { body_file: bodyFile } : {},
  };
}

const textId = "10000000-0000-4000-8000-000000000001";
const areaId = "10000000-0000-4000-8000-000000000002";
const nodeId = "10000000-0000-4000-8000-000000000003";
const documentId = "10000000-0000-4000-8000-000000000004";

function resultFor(result, id) {
  return result.records.find((item) => item.id === id);
}

describe("W07 effective publication", () => {
  it.each([
    ["draft", "SELF_DRAFT"],
    ["private", "SELF_PRIVATE"],
    ["invalid", "SELF_STATUS_INVALID"],
  ])("excludes a %s record with an explicit reason", (status, code) => {
    const result = evaluatePublication([record(textId, "text", status)]);
    expect(resultFor(result, textId)).toMatchObject({
      effective_published: false,
      included: false,
      reasons: [expect.objectContaining({ code })],
    });
  });

  it.each([
    ["draft", "ANCESTOR_DRAFT"],
    ["private", "ANCESTOR_PRIVATE"],
    ["invalid", "ANCESTOR_STATUS_INVALID"],
  ])("excludes a published child below a %s ancestor", (status, code) => {
    const records = [
      record(textId, "text", status),
      record(documentId, "text_document", "published", textId),
    ];
    const result = evaluatePublication(records);
    expect(resultFor(result, documentId)).toMatchObject({
      effective_published: false,
      included: false,
      reasons: expect.arrayContaining([expect.objectContaining({ code })]),
    });
  });

  it("keeps a published text overview page even without children", () => {
    const result = evaluatePublication([record(textId, "text", "published")]);
    expect(result.included_ids).toEqual([textId]);
  });

  it("hides empty structures but includes a non-empty overview", () => {
    const records = [
      record(textId, "text", "published"),
      record(areaId, "text_area", "published", textId, "_index.md"),
    ];
    const empty = evaluatePublication(records, {
      overviewTextById: { [areaId]: " \n\t" },
    });
    expect(resultFor(empty, areaId)).toMatchObject({
      effective_published: true,
      included: false,
      reasons: [expect.objectContaining({ code: "EMPTY_STRUCTURE" })],
    });

    const withOverview = evaluatePublication(records, {
      overviewTextById: { [areaId]: "영역 소개\n" },
    });
    expect(resultFor(withOverview, areaId).included).toBe(true);
  });

  it("includes structural ancestors only when a public descendant is included", () => {
    const records = [
      record(textId, "text", "published"),
      record(areaId, "text_area", "published", textId),
      record(nodeId, "tree_node", "published", areaId),
      record(documentId, "text_document", "published", nodeId, "body.md"),
    ];
    const result = selectPublicRecords(records);
    expect(result.included_ids).toEqual([textId, areaId, nodeId, documentId]);
    expect(result.public_records).toHaveLength(4);
  });

  it("does not lift a published descendant above a private structural ancestor", () => {
    const records = [
      record(textId, "text", "published"),
      record(areaId, "text_area", "published", textId),
      record(nodeId, "tree_node", "private", areaId),
      record(documentId, "text_document", "published", nodeId, "body.md"),
    ];
    const result = evaluatePublication(records);
    expect(result.included_ids).toEqual([textId]);
    expect(resultFor(result, documentId).reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "ANCESTOR_PRIVATE" })]),
    );
  });

  it("propagates required public-validation blockers to descendants", () => {
    const records = [
      record(textId, "text", "published"),
      record(documentId, "text_document", "published", textId, "body.md"),
    ];
    const result = evaluatePublication(records, {
      blockers: [{ record_id: textId, code: "CANON_UNVERIFIED", field: "canon" }],
    });
    expect(resultFor(result, textId).reasons).toContainEqual(
      expect.objectContaining({
        code: "PUBLICATION_BLOCKER",
        details: { code: "CANON_UNVERIFIED", field: "canon" },
      }),
    );
    expect(resultFor(result, documentId).reasons).toContainEqual(
      expect.objectContaining({ code: "ANCESTOR_PUBLICATION_BLOCKER" }),
    );
  });

  it("reports missing parents and cycles instead of recursing indefinitely", () => {
    const missing = record(documentId, "text_document", "published", "missing");
    const cycleA = record(areaId, "text_area", "published", nodeId);
    const cycleB = record(nodeId, "tree_node", "published", areaId);
    const result = evaluatePublication([missing, cycleA, cycleB]);
    expect(resultFor(result, documentId).reasons[0].code).toBe("ANCESTOR_MISSING");
    expect(
      result.records.some((item) =>
        item.reasons.some((itemReason) => itemReason.code === "ANCESTOR_CYCLE"),
      ),
    ).toBe(true);
  });
});
