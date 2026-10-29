import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  schemaValidators,
  validateTextBibliography,
} from "../../core/content/index.js";

const commonText = {
  schema_version: 1,
  id: "90000000-0000-4000-8000-000000000001",
  type: "text",
  title: "합성 다중 문헌 경론",
  slug: "multi-corpus-text",
  status: "draft",
  created_at: "2026-10-29T00:00:00Z",
  updated_at: "2026-10-29T00:00:00Z",
  canon: {
    canon_id: "cst",
    section_id: "sutta-pitaka",
    catalog_number: "synthetic-1",
    verification_status: "verified",
    source_references: [],
  },
  source_edition: {
    provider_id: "vri-cst",
    source_id: "synthetic-1",
    language: "pi",
    script: "Latn",
    format: "xml",
    version: "synthetic",
    source_url: "https://example.invalid/synthetic-1",
    verification_status: "verified",
    rights_status: "conditional",
    source_references: [],
  },
};

function indexFor(text = commonText) {
  return {
    records: [{
      id: text.id,
      type: "text",
      status: text.status,
      path: "content/texts/multi-corpus-text/meta.json",
      parent_id: null,
      data: text,
    }],
    assets: [],
    taxonomies: [{
      canon_id: "cst",
      verification_status: "verified",
      sections: [{ id: "sutta-pitaka", verification_status: "verified" }],
    }],
    sources: [{ id: "vri-cst", verification_status: "verified" }],
  };
}

describe("W09-A multi-corpus bibliography", () => {
  it("accepts the source-verified CBETA T01n0002 metadata-only sample", async () => {
    const path = fileURLToPath(
      new URL("../fixtures/w09a-source-metadata/cbeta-t01n0002.json", import.meta.url),
    );
    const sample = JSON.parse(await readFile(path, "utf8"));
    expect(schemaValidators.records.text(sample)).toBe(true);
    expect(sample).toMatchObject({
      title: "七佛經",
      canon: { catalog_number: "T0002" },
      source_edition: { provider_id: "cbeta", source_id: "T01n0002" },
    });
  });

  it("accepts a non-Taisho canon and separates language from script", () => {
    expect(schemaValidators.records.text(commonText)).toBe(true);
  });

  it("accepts a repository witness without pretending it is a canon", () => {
    const gretil = {
      ...commonText,
      canon: {
        canon_id: null,
        section_id: null,
        catalog_number: null,
        verification_status: "unverified",
        source_references: [],
      },
      source_edition: {
        ...commonText.source_edition,
        provider_id: "gretil",
        language: "sa",
        script: "Latn",
      },
    };
    expect(schemaValidators.records.text(gretil)).toBe(true);
  });

  it("reports missing classification and source-provider references", () => {
    const result = validateTextBibliography({
      ...indexFor(),
      taxonomies: [],
      sources: [],
    });
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "CANON_REFERENCE_MISSING",
        "SOURCE_PROVIDER_REFERENCE_MISSING",
      ]),
    );
  });

  it("blocks publication until classification, edition, provider, and rights are verified", () => {
    const published = {
      ...commonText,
      status: "published",
      canon: { ...commonText.canon, verification_status: "unverified" },
      source_edition: {
        ...commonText.source_edition,
        verification_status: "unverified",
        rights_status: "unverified",
      },
    };
    const result = validateTextBibliography(indexFor(published));
    expect(result.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "CANON_REFERENCE_UNVERIFIED",
        "SOURCE_EDITION_UNVERIFIED",
        "SOURCE_RIGHTS_UNVERIFIED",
      ]),
    );
  });

  it("returns no blockers for a fully verified published record", () => {
    const result = validateTextBibliography(indexFor({
      ...commonText,
      status: "published",
    }));
    expect(result).toEqual({ diagnostics: [], blockers: [] });
  });
});
