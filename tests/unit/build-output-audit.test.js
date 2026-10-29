import { describe, expect, it } from "vitest";

import { auditStaticOutput, privateOutputTokens } from "../../core/content/index.js";

const privateId = "10000000-0000-4000-8000-000000000009";
const privateAssetId = "20000000-0000-4000-8000-000000000009";

describe("W16 public output audit", () => {
  const index = {
    records: [{ id: privateId, slug: "secret-page" }],
    assets: [{ id: privateAssetId, file_path: "media/images/private.png" }],
  };
  const tokens = privateOutputTokens({
    index,
    publicRecordIds: [],
    publicAssetIds: [],
    bodiesById: new Map([[privateId, "PRIVATE-LEAK-MARKER-DO-NOT-PUBLISH"]]),
  });

  it("accepts a closed, public-only output set", () => {
    const result = auditStaticOutput({
      files: [{ path: "index.html", content: "<h1>공개</h1>", source_ids: [] }],
      mediaPlan: [],
      allowedSourceIds: [],
      privateTokens: tokens,
    });
    expect(result.ok).toBe(true);
    expect(result.expected_paths).toEqual(["index.html"]);
  });

  it.each([
    ["private marker", "PRIVATE-LEAK-MARKER-DO-NOT-PUBLISH", "BUILD_PRIVATE_CONTENT_LEAK"],
    ["private id", privateId, "BUILD_PRIVATE_CONTENT_LEAK"],
    ["internal document scheme", `doc:${privateId}`, "BUILD_INTERNAL_SCHEME_LEAK"],
    ["raw index path", "media/assets.json", "BUILD_PRIVATE_PATH_LEAK"],
  ])("rejects %s", (_name, content, code) => {
    const result = auditStaticOutput({
      files: [{ path: "index.html", content, source_ids: [] }],
      mediaPlan: [],
      allowedSourceIds: [],
      privateTokens: tokens,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
  });

  it("rejects private provenance and page/media path collisions", () => {
    const result = auditStaticOutput({
      files: [{ path: "assets/same.png", content: "public", source_ids: [privateId] }],
      mediaPlan: [{ output_path: "assets/same.png" }],
      allowedSourceIds: [],
      privateTokens: [],
    });
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "BUILD_PRIVATE_PROVENANCE", "BUILD_OUTPUT_DUPLICATE",
    ]));
  });
});
