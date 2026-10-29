const AREA_CODES = Object.freeze(["translation", "original", "research"]);

function overviewLookup(value) {
  if (value instanceof Map) return value;
  return new Map(Object.entries(value ?? {}));
}

function compareRecords(left, right) {
  const leftOrder = Number.isInteger(left.order) ? left.order : 0;
  const rightOrder = Number.isInteger(right.order) ? right.order : 0;
  return leftOrder - rightOrder || left.id.localeCompare(right.id, "en");
}

export function buildTextTrees(records, overviewTextById = {}) {
  const overview = overviewLookup(overviewTextById);
  const byParent = new Map();
  for (const record of records) {
    if (!record.parent_id) continue;
    const children = byParent.get(record.parent_id) ?? [];
    children.push(record);
    byParent.set(record.parent_id, children);
  }
  for (const children of byParent.values()) children.sort(compareRecords);

  function node(record, ancestors = new Set()) {
    if (ancestors.has(record.id)) {
      return {
        id: record.id,
        type: record.type,
        title: record.title,
        cycle: true,
        children: [],
      };
    }
    const nextAncestors = new Set(ancestors).add(record.id);
    return {
      id: record.id,
      type: record.type,
      title: record.title,
      slug: record.slug,
      status: record.status,
      order: record.order,
      parent_id: record.parent_id,
      text_id: record.text_id,
      area: record.area,
      path: record.path,
      body_file: record.data.body_file ?? null,
      overview: overview.get(record.id) ?? null,
      children: (byParent.get(record.id) ?? []).map((child) =>
        node(child, nextAncestors),
      ),
    };
  }

  return records
    .filter((record) => record.type === "text")
    .sort(compareRecords)
    .map((text) => {
      const areas = Object.fromEntries(
        AREA_CODES.map((areaCode) => {
          const area = (byParent.get(text.id) ?? []).find(
            (record) =>
              record.type === "text_area" && record.area === areaCode,
          );
          return [areaCode, area ? node(area) : null];
        }),
      );
      return {
        text_id: text.id,
        title: text.title,
        slug: text.slug,
        status: text.status,
        path: text.path,
        overview: overview.get(text.id) ?? null,
        areas,
      };
    });
}
