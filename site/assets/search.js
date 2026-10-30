const form = document.querySelector('[role="search"]');
const input = form?.querySelector("input");
const status = document.querySelector(".search-status");
const list = document.querySelector(".search-results");
let entries = null;

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
  list.replaceChildren();
  const query = normalize(input.value);
  if (!query) {
    status.textContent = "검색어를 입력하세요.";
    return;
  }
  try {
    const data = await loadIndex();
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
      type.textContent = result.item.type;
      item.append(link, type);
      if (result.item.description) {
        const description = document.createElement("p");
        description.textContent = result.item.description;
        item.append(description);
      }
      list.append(item);
    }
    status.textContent = results.length ? `${results.length}개 결과` : "일치하는 공개 자료가 없습니다.";
  } catch {
    status.textContent = "검색 자료를 불러오지 못했습니다.";
  }
});
