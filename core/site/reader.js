const AREA_LABELS = Object.freeze({
  translation: "번역",
  original: "원문",
  research: "연구",
});

function compareRecords(left, right) {
  const order = (left.order ?? 0) - (right.order ?? 0);
  return order || left.id.localeCompare(right.id, "en");
}

function githubSourceUrl(site, record) {
  const source = site.source_repository;
  if (!source?.public_links || typeof source.repository_url !== "string") return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(source.repository_url);
  if (!match || !record.data?.body_file) return null;
  const [, owner, repository] = match;
  const branch = encodeURIComponent(source.branch);
  const path = ["project", record.directory, record.data.body_file]
    .join("/")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `https://github.com/${owner}/${repository}/blob/${branch}/${path}`;
}

function ancestorIds(record, byId) {
  const result = new Set([record.id]);
  let current = record;
  while (current.parent_id) {
    if (result.has(current.parent_id)) break;
    result.add(current.parent_id);
    current = byId.get(current.parent_id);
    if (!current) break;
  }
  return result;
}

function treeForArea(area, records, urlIndex, currentId) {
  const byParent = new Map();
  for (const record of records) {
    if (!record.parent_id) continue;
    const children = byParent.get(record.parent_id) ?? [];
    children.push(record);
    byParent.set(record.parent_id, children);
  }
  for (const children of byParent.values()) children.sort(compareRecords);
  const byId = new Map(records.map((record) => [record.id, record]));
  const openIds = ancestorIds(byId.get(currentId) ?? area, byId);
  const documents = [];

  function node(record, depth) {
    const children = (byParent.get(record.id) ?? []).map((child) => node(child, depth + 1));
    if (record.type === "text_document") documents.push(record);
    return {
      id: record.id,
      type: record.type,
      title: record.title,
      url: urlIndex.by_id.get(record.id)?.path ?? null,
      depth,
      current: record.id === currentId,
      open: openIds.has(record.id),
      children,
    };
  }
  const children = (byParent.get(area.id) ?? []).map((record) => node(record, 0));
  return { children, documents };
}

function areaNavigation(record, publicRecords, urlIndex) {
  const areas = publicRecords
    .filter((candidate) => candidate.type === "text_area" && candidate.text_id === record.text_id)
    .sort((left, right) => ["translation", "original", "research"].indexOf(left.area) - ["translation", "original", "research"].indexOf(right.area));
  const related = new Set(record.type === "text_document" ? record.data?.related_documents ?? [] : []);
  return areas.map((area) => {
    const matches = publicRecords.filter((candidate) =>
      candidate.type === "text_document" && candidate.text_id === record.text_id && candidate.area === area.area && related.has(candidate.id),
    );
    const target = area.area === record.area ? record : matches.length === 1 ? matches[0] : area;
    return {
      area: area.area,
      label: AREA_LABELS[area.area],
      url: urlIndex.by_id.get(target.id)?.path,
      current: area.area === record.area,
      multiple: matches.length > 1,
      choices: matches.length > 1 ? matches.map((match) => ({ title: match.title, url: urlIndex.by_id.get(match.id)?.path })).filter((match) => match.url) : [],
    };
  }).filter((item) => item.url);
}

export function buildReaderData({ record, publicRecords, urlIndex, site }) {
  if (!["text_area", "tree_node", "text_document"].includes(record.type)) return null;
  const area = publicRecords.find((candidate) =>
    candidate.type === "text_area" && candidate.text_id === record.text_id && candidate.area === record.area,
  );
  if (!area) return null;
  const areaRecords = publicRecords.filter((candidate) =>
    candidate.text_id === record.text_id && candidate.area === record.area && ["text_area", "tree_node", "text_document"].includes(candidate.type),
  );
  const tree = treeForArea(area, areaRecords, urlIndex, record.id);
  const currentDocumentIndex = tree.documents.findIndex((document) => document.id === record.id);
  const previous = currentDocumentIndex > 0 ? tree.documents[currentDocumentIndex - 1] : null;
  const next = currentDocumentIndex >= 0 && currentDocumentIndex < tree.documents.length - 1
    ? tree.documents[currentDocumentIndex + 1]
    : null;
  return {
    area: { id: area.id, title: AREA_LABELS[area.area], url: urlIndex.by_id.get(area.id)?.path },
    tree: tree.children,
    areas: areaNavigation(record, publicRecords, urlIndex),
    previous: previous ? { title: previous.title, url: urlIndex.by_id.get(previous.id)?.path } : null,
    next: next ? { title: next.title, url: urlIndex.by_id.get(next.id)?.path } : null,
    source_url: githubSourceUrl(site, record),
  };
}

export { AREA_LABELS, githubSourceUrl };
