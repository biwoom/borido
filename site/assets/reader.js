const tree = document.querySelector(".reader-tree");
document.body.classList.add("reader-enhanced");
const treeToggle = document.querySelector(".tree-toggle");
const panel = document.querySelector(".reader-panel");
const panelContent = panel?.querySelector(".reader-panel-content");
const panelTitle = panel?.querySelector(".reader-panel-head h2");
const mobile = window.matchMedia("(max-width: 42rem)");
let reference = null;
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
  document.querySelector(".reader-layout")?.classList.remove("panel-open");
  document.querySelectorAll("[data-panel]").forEach((button) => button.setAttribute("aria-expanded", "false"));
  (activeButton?.closest(".reader-panel") ? document.querySelector('.document-tools [data-panel="' + activeButton.dataset.panel + '"]') : activeButton)?.focus();
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
    const headings = [...(source?.querySelectorAll("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]") ?? [])];
    const list = document.createElement("ol");
    const stack = [{ level: 0, list }];
    for (const heading of headings) {
      const level = Number(heading.tagName.slice(1));
      while (stack.length > 1 && level <= stack.at(-1).level) stack.pop();
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `#${encodeURIComponent(heading.id)}`;
      link.textContent = heading.textContent;
      item.append(link);
      stack.at(-1).list.append(item);
      const nested = document.createElement("ol");
      item.append(nested);
      stack.push({ level, list: nested });
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
  document.querySelector(".reader-layout")?.classList.add("panel-open");
  if (mobile.matches && tree) { tree.hidden = true; treeToggle?.setAttribute("aria-expanded", "false"); }
  document.querySelectorAll("[data-panel]").forEach((item) => item.setAttribute("aria-expanded", String(item === button)));
  if (window.matchMedia("(max-width: 42rem)").matches) panel.querySelector(".panel-close")?.focus();
}));

panel?.querySelector(".panel-close")?.addEventListener("click", closePanel);
treeToggle?.addEventListener("click", () => {
  const willOpen = tree.hidden;
  tree.hidden = !willOpen;
  treeToggle.setAttribute("aria-expanded", String(willOpen));
  if (willOpen && mobile.matches) closePanel();
  if (willOpen && window.matchMedia("(max-width: 42rem)").matches) tree.querySelector("a, summary")?.focus();
});

document.addEventListener("keydown", (event) => {
  const drawer = mobile.matches ? (!panel?.hidden ? panel : !tree?.hidden ? tree : null) : null;
  if (event.key === "Tab" && drawer) {
    const controls = [...drawer.querySelectorAll("button, a[href], summary")].filter((el) => el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  if (event.key === "Escape") {
    if (panel && !panel.hidden) closePanel();
    else if (mobile.matches && tree && !tree.hidden) {
      tree.hidden = true;
      treeToggle?.setAttribute("aria-expanded", "false");
      treeToggle?.focus();
    }
  }
});

document.querySelectorAll(".footnote-ref a").forEach((link) => link.addEventListener("click", () => {
  reference = link;
  if (panel.hidden || activeButton?.dataset.panel !== "footnotes") document.querySelector('[data-panel="footnotes"]')?.click();
}));
document.querySelectorAll(".footnotes a[href^='#fnref']").forEach((link) => link.addEventListener("click", (event) => {
  closePanel();
  if (reference) {
    event.preventDefault();
    reference.scrollIntoView({ block: "center" });
    reference.focus();
    history.replaceState(null, "", "#" + reference.id);
    reference = null;
  }
}));
function syncMobile() {
  if (tree) tree.hidden = mobile.matches;
  treeToggle?.setAttribute("aria-expanded", String(!mobile.matches));
}
syncMobile();
mobile.addEventListener("change", syncMobile);
document.querySelector(".tree-close")?.addEventListener("click", () => {
  tree.hidden = true; treeToggle?.setAttribute("aria-expanded", "false"); treeToggle?.focus();
});
function hashNote() {
  let target;
  try { target = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch { return; }
  if (target?.closest(".footnotes")) {
    if (panel.hidden || activeButton?.dataset.panel !== "footnotes") document.querySelector('[data-panel="footnotes"]')?.click();
    target.scrollIntoView({ block: "nearest" });
  }
}
window.addEventListener("hashchange", hashNote);
hashNote();
let printButton;
window.addEventListener("beforeprint", () => { printButton = panel && !panel.hidden ? activeButton : null; restoreFootnotes(); });
window.addEventListener("afterprint", () => { if (printButton) { closePanel(); printButton.click(); } });
document.addEventListener("click", (event) => {
  if (mobile.matches && !event.target.closest(".reader-panel, .reader-tree, .document-tools, .footnote-ref")) {
    closePanel(); if (tree) tree.hidden = true; treeToggle?.setAttribute("aria-expanded", "false");
  }
});
