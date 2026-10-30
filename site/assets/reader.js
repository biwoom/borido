const tree = document.querySelector(".reader-tree");
const treeToggle = document.querySelector(".tree-toggle");
const panel = document.querySelector(".reader-panel");
const panelContent = panel?.querySelector(".reader-panel-content");
const panelTitle = panel?.querySelector(".reader-panel-head h2");
let activeButton = null;
let footnotes = null;
let footnotesAnchor = null;

function restoreFootnotes() {
  if (footnotes && footnotesAnchor?.parentNode) {
    footnotesAnchor.parentNode.insertBefore(footnotes, footnotesAnchor);
    footnotesAnchor.remove();
    footnotesAnchor = null;
  }
  footnotes = null;
}

function closePanel() {
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  panelContent.replaceChildren();
  restoreFootnotes();
  document.querySelectorAll("[data-panel]").forEach((button) => button.setAttribute("aria-expanded", "false"));
  activeButton?.focus();
}

document.querySelectorAll("[data-panel]").forEach((button) => button.addEventListener("click", () => {
  if (!panel || !panelContent) return;
  if (!panel.hidden && activeButton === button) return closePanel();
  restoreFootnotes();
  activeButton = button;
  const mode = button.dataset.panel;
  const source = mode === "toc" ? document.querySelector(".prose") : document.querySelector(".footnotes");
  panelTitle.textContent = mode === "toc" ? "목차" : "각주";
  panelContent.replaceChildren();
  if (mode === "toc") {
    const headings = [...(source?.querySelectorAll("h2[id], h3[id], h4[id]") ?? [])];
    const list = document.createElement("ol");
    for (const heading of headings) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `#${encodeURIComponent(heading.id)}`;
      link.textContent = heading.textContent;
      item.append(link);
      list.append(item);
    }
    if (headings.length) panelContent.append(list);
  } else if (source) {
    footnotes = source;
    footnotesAnchor = document.createComment("각주 원래 위치");
    source.before(footnotesAnchor);
    panelContent.append(source);
    source.hidden = false;
  }
  panel.hidden = false;
  document.querySelectorAll("[data-panel]").forEach((item) => item.setAttribute("aria-expanded", String(item === button)));
  if (window.matchMedia("(max-width: 42rem)").matches) panel.querySelector(".panel-close")?.focus();
}));

panel?.querySelector(".panel-close")?.addEventListener("click", closePanel);
treeToggle?.addEventListener("click", () => {
  const willOpen = tree.hidden;
  tree.hidden = !willOpen;
  treeToggle.setAttribute("aria-expanded", String(willOpen));
  if (willOpen && window.matchMedia("(max-width: 42rem)").matches) tree.querySelector("a, summary")?.focus();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (panel && !panel.hidden) closePanel();
    else if (tree && tree.hidden) {
      tree.hidden = false;
      treeToggle?.setAttribute("aria-expanded", "true");
      treeToggle?.focus();
    }
  }
});

document.querySelectorAll(".footnotes a[href^='#fnref']").forEach((link) => link.addEventListener("click", () => {
  const button = document.querySelector('[data-panel="footnotes"]');
  if (button) button.click();
}));
