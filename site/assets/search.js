const form = document.querySelector('[role="search"]');
const input = form?.querySelector("input");
const status = document.querySelector(".search-status");
const list = document.querySelector(".search-results");
let entries = null;
let requestVersion = 0;

async function loadIndex() {
  if (entries) return entries;
  const response = await fetch(form.dataset.searchIndex, { credentials: "omit" });
  if (!response.ok) throw new Error("index");
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("format");
  entries = value;
  return entries;
}

function normalize(value) {
  return value.normalize("NFC").toLocaleLowerCase().trim();
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const version = ++requestVersion;
  list.replaceChildren();
  const query = normalize(input.value);
  if (!query) {
    status.textContent = "검색어를 입력하세요.";
    return;
  }
  try {
    const data = await loadIndex();
    if (version !== requestVersion) return;
    const results = data.map((item) => {
      const title = normalize(item.title);
      const haystack = normalize(`${item.title} ${item.description} ${item.text} ${item.text_title ?? ""} ${item.area ?? ""}`);
      return { item, titleMatch: title.includes(query), match: haystack.includes(query) };
    }).filter((result) => result.match).sort((left, right) => Number(right.titleMatch) - Number(left.titleMatch) || left.item.title.localeCompare(right.item.title, "ko"));
    for (const result of results) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = result.item.url;
      link.textContent = result.item.title;
      const type = document.createElement("span");
      type.textContent = ({ text: "경론", text_area: "자료 영역", tree_node: "구조", text_document: "경론 문서", story: "이야기", blog: "블로그", page: "페이지", taxonomy_section: "경론 분류" })[result.item.type] ?? result.item.type;
      item.append(link, type);
      if (result.item.text_title) {
        const context = document.createElement("p");
        context.textContent = [result.item.text_title, ({ translation: "번역", original: "원문", research: "연구" })[result.item.area]].filter(Boolean).join(" · ");
        item.append(context);
      }
      if (result.item.description) {
        const description = document.createElement("p");
        description.textContent = result.item.description;
        item.append(description);
      }
      list.append(item);
    }
    status.textContent = results.length ? `${results.length}개 결과` : "일치하는 공개 자료가 없습니다.";
  } catch {
    if (version !== requestVersion) return;
    status.textContent = "검색 자료를 불러오지 못했습니다.";
  }
});
