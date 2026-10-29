import Ajv from "ajv";

export const CONTENT_SCHEMA_VERSION = 1;

const UUID_V4 =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const UTC_TIMESTAMP =
  /^([0-9]{4})-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(\.[0-9]+)?Z$/u;
const SLUG = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const STABLE_ID = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

const nonEmptyString = { type: "string", minLength: 1 };
const stringArray = {
  type: "array",
  items: nonEmptyString,
  uniqueItems: true,
};
const uuid = { type: "string", pattern: UUID_V4 };
const timestamp = { type: "string", format: "utc-timestamp" };
const status = { enum: ["draft", "published", "private"] };

const sourceReferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "locator", "checked_at"],
  properties: {
    title: nonEmptyString,
    url: nonEmptyString,
    locator: nonEmptyString,
    checked_at: timestamp,
  },
};

const commonProperties = {
  schema_version: { const: CONTENT_SCHEMA_VERSION },
  id: uuid,
  type: { type: "string" },
  title: nonEmptyString,
  slug: { type: "string", pattern: SLUG },
  status,
  created_at: timestamp,
  updated_at: timestamp,
  description: { type: "string" },
  order: { type: "integer" },
  body_file: { type: "string" },
};

const commonRequired = [
  "schema_version",
  "id",
  "type",
  "title",
  "slug",
  "status",
  "created_at",
  "updated_at",
];

function recordSchema(
  type,
  { properties = {}, required = [], allOf = undefined } = {},
) {
  return {
    $id: `https://borido.local/schemas/${type}.json`,
    type: "object",
    additionalProperties: false,
    required: [...commonRequired, ...required],
    properties: {
      ...commonProperties,
      type: { const: type },
      ...properties,
    },
    ...(allOf ? { allOf } : {}),
  };
}

const canonReferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "canon_id",
    "section_id",
    "catalog_number",
    "verification_status",
    "source_references",
  ],
  properties: {
    canon_id: {
      anyOf: [{ type: "string", pattern: STABLE_ID }, { type: "null" }],
    },
    section_id: {
      anyOf: [{ type: "string", pattern: STABLE_ID }, { type: "null" }],
    },
    catalog_number: { anyOf: [nonEmptyString, { type: "null" }] },
    verification_status: { enum: ["unverified", "verified"] },
    source_references: { type: "array", items: sourceReferenceSchema },
  },
};

const editionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: nonEmptyString, source_url: nonEmptyString },
};

const sourceEditionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "provider_id",
    "source_id",
    "language",
    "script",
    "format",
    "version",
    "source_url",
    "verification_status",
    "rights_status",
    "source_references",
  ],
  properties: {
    provider_id: { type: "string", pattern: STABLE_ID },
    source_id: nonEmptyString,
    language: nonEmptyString,
    script: nonEmptyString,
    format: nonEmptyString,
    version: nonEmptyString,
    source_url: nonEmptyString,
    verification_status: { enum: ["unverified", "verified"] },
    rights_status: {
      enum: ["unverified", "conditional", "open", "restricted"],
    },
    rights_url: nonEmptyString,
    usage_note: { type: "string" },
    source_references: { type: "array", items: sourceReferenceSchema },
  },
};

const bibliographyEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["citation"],
  properties: { citation: nonEmptyString, url: nonEmptyString },
};

export const contentRecordSchemas = Object.freeze({
  text: recordSchema("text", {
    required: ["canon"],
    properties: {
      body_file: { const: "_index.md" },
      canon: canonReferenceSchema,
      authors: stringArray,
      translators: stringArray,
      source_languages: stringArray,
      edition: editionSchema,
      source_edition: sourceEditionSchema,
      bibliography: { type: "array", items: bibliographyEntrySchema },
      related_texts: { type: "array", items: uuid, uniqueItems: true },
    },
  }),
  text_area: recordSchema("text_area", {
    required: ["order", "area"],
    properties: {
      body_file: { const: "_index.md" },
      area: { enum: ["translation", "original", "research"] },
    },
  }),
  tree_node: recordSchema("tree_node", {
    required: ["order", "node_kind"],
    properties: {
      body_file: { const: "_index.md" },
      node_kind: {
        enum: ["volume", "chapter", "section", "topic", "group", "custom"],
      },
    },
  }),
  text_document: recordSchema("text_document", {
    required: ["order", "body_file"],
    properties: {
      body_file: { const: "body.md" },
      related_documents: { type: "array", items: uuid, uniqueItems: true },
    },
  }),
  story: recordSchema("story", {
    required: ["body_file"],
    properties: {
      body_file: { const: "story.md" },
      sources: { type: "array", items: sourceReferenceSchema },
      source_text: { type: "string" },
      adapted: { type: "boolean" },
      adaptation_note: { type: "string" },
      featured_media_id: uuid,
    },
  }),
  blog: recordSchema("blog", {
    required: ["body_file"],
    properties: {
      body_file: { const: "post.md" },
      author: { type: "string" },
      tags: stringArray,
      published_at: timestamp,
    },
    allOf: [
      {
        if: {
          required: ["status"],
          properties: { status: { const: "published" } },
        },
        then: {
          required: ["published_at"],
          properties: { published_at: timestamp },
        },
      },
    ],
  }),
  page: recordSchema("page", {
    required: ["body_file"],
    properties: {
      body_file: { const: "page.md" },
      menu_visible: { type: "boolean" },
      menu_order: { type: "integer" },
      template: { type: "string", pattern: SLUG },
    },
  }),
});

const repositorySchema = {
  type: "object",
  additionalProperties: false,
  required: ["repository_url", "branch"],
  properties: { repository_url: nonEmptyString, branch: nonEmptyString },
};

export const siteSettingsSchema = {
  $id: "https://borido.local/schemas/site-settings.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "site_name",
    "description",
    "default_language",
    "author_name",
    "license",
    "timezone",
    "base_url",
    "base_path",
    "source_repository",
    "deployment",
  ],
  properties: {
    schema_version: { const: 1 },
    site_name: nonEmptyString,
    description: { type: "string" },
    default_language: nonEmptyString,
    author_name: { type: "string" },
    license: { type: "string" },
    timezone: nonEmptyString,
    base_url: { anyOf: [nonEmptyString, { type: "null" }] },
    base_path: nonEmptyString,
    source_repository: {
      anyOf: [
        {
          ...repositorySchema,
          required: [...repositorySchema.required, "public_links"],
          properties: {
            ...repositorySchema.properties,
            public_links: { type: "boolean" },
          },
        },
        { type: "null" },
      ],
    },
    deployment: { anyOf: [repositorySchema, { type: "null" }] },
  },
};

export const mediaAssetsSchema = {
  $id: "https://borido.local/schemas/media-assets.json",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "assets"],
  properties: {
    schema_version: { const: CONTENT_SCHEMA_VERSION },
    assets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "file_path", "media_type", "status"],
        properties: {
          id: uuid,
          file_path: {
            type: "string",
            pattern:
              "^media/(images|documents|icons)/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$",
          },
          media_type: nonEmptyString,
          status: { enum: ["private", "published"] },
          alt: { type: "string" },
          caption: { type: "string" },
          imported_at: timestamp,
        },
      },
    },
  },
};

const taxonomySectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "canon_id",
    "name",
    "slug",
    "order",
    "verification_status",
    "source_references",
  ],
  properties: {
    id: { type: "string", pattern: STABLE_ID },
    canon_id: { type: "string", pattern: STABLE_ID },
    name: nonEmptyString,
    slug: { type: "string", pattern: SLUG },
    order: { type: "integer" },
    description: { type: "string" },
    verification_status: { enum: ["unverified", "verified"] },
    source_references: { type: "array", items: sourceReferenceSchema },
  },
};

export const taxonomySchema = {
  $id: "https://borido.local/schemas/taxonomy.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "canon_id",
    "name",
    "tradition",
    "verification_status",
    "source_references",
    "sections",
  ],
  properties: {
    schema_version: { const: CONTENT_SCHEMA_VERSION },
    canon_id: { type: "string", pattern: STABLE_ID },
    name: nonEmptyString,
    tradition: nonEmptyString,
    language: nonEmptyString,
    script: nonEmptyString,
    verification_status: { enum: ["unverified", "verified"] },
    source_references: { type: "array", items: sourceReferenceSchema },
    sections: { type: "array", items: taxonomySectionSchema },
  },
};

export const sourceRegistrySchema = {
  $id: "https://borido.local/schemas/source-registry.json",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "providers"],
  properties: {
    schema_version: { const: CONTENT_SCHEMA_VERSION },
    providers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "name",
          "kind",
          "official_url",
          "formats",
          "verification_status",
          "rights_status",
          "source_references",
        ],
        properties: {
          id: { type: "string", pattern: STABLE_ID },
          name: nonEmptyString,
          kind: { enum: ["digital-canon", "text-repository"] },
          official_url: nonEmptyString,
          formats: stringArray,
          verification_status: { enum: ["unverified", "verified"] },
          rights_status: {
            enum: ["unverified", "conditional", "open", "restricted"],
          },
          rights_url: nonEmptyString,
          usage_note: { type: "string" },
          source_references: { type: "array", items: sourceReferenceSchema },
        },
      },
    },
  },
};

export const urlHistorySchema = {
  $id: "https://borido.local/schemas/url-history.json",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "entries"],
  properties: {
    schema_version: { const: CONTENT_SCHEMA_VERSION },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "target_id", "changed_at"],
        properties: {
          from: { type: "string", pattern: "^/(?:[A-Za-z0-9._~-]+/)+$" },
          target_id: uuid,
          changed_at: timestamp,
        },
      },
    },
  },
};

function isUtcTimestamp(value) {
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day) &&
    parsed.getUTCHours() === Number(hour) &&
    parsed.getUTCMinutes() === Number(minute) &&
    parsed.getUTCSeconds() === Number(second)
  );
}

const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addFormat("utc-timestamp", { type: "string", validate: isUtcTimestamp });

export const schemaValidators = Object.freeze({
  records: Object.fromEntries(
    Object.entries(contentRecordSchemas).map(([type, schema]) => [
      type,
      ajv.compile(schema),
    ]),
  ),
  site: ajv.compile(siteSettingsSchema),
  media: ajv.compile(mediaAssetsSchema),
  taxonomy: ajv.compile(taxonomySchema),
  sources: ajv.compile(sourceRegistrySchema),
  urlHistory: ajv.compile(urlHistorySchema),
});

export const CONTENT_RECORD_TYPES = Object.freeze(
  Object.keys(contentRecordSchemas),
);
