const elements = {
  loading: document.querySelector("#loading-view"),
  session: document.querySelector("#session-view"),
  blocked: document.querySelector("#blocked-view"),
  blockedMessage: document.querySelector("#blocked-message"),
  shell: document.querySelector("#app-shell"),
  notice: document.querySelector("#notice"),
  status: document.querySelector("#save-status"),
  headerSiteName: document.querySelector("#header-site-name"),
  projectPath: document.querySelector("#project-path"),
  newProjectNote: document.querySelector("#new-project-note"),
  newProjectPath: document.querySelector("#new-project-path"),
  settingsEyebrow: document.querySelector("#settings-eyebrow"),
  settingsTitle: document.querySelector("#settings-title"),
  settingsIntro: document.querySelector("#settings-intro"),
  form: document.querySelector("#site-form"),
  saveButton: document.querySelector("#save-button"),
  reloadButton: document.querySelector("#reload-button"),
  connectionSection: document.querySelector("#connection-section"),
  sourceConnection: document.querySelector("#source-connection"),
  deploymentConnection: document.querySelector("#deployment-connection"),
  settingsView: document.querySelector("#settings-view"),
  placeholderView: document.querySelector("#content-placeholder-view"),
  placeholderTitle: document.querySelector("#placeholder-title"),
  placeholderIntro: document.querySelector("#placeholder-intro"),
  emptyTitle: document.querySelector("#empty-title"),
  emptyDescription: document.querySelector("#empty-description"),
  live: document.querySelector("#live-region"),
};

const state = {
  token: null,
  mode: null,
  root: null,
  project: null,
  dirty: false,
  saving: false,
  view: "settings",
};

const contentCopy = {
  texts: {
    title: "경론",
    intro: "문헌과 세 자료 영역을 한곳에서 관리합니다.",
    empty: "아직 등록된 경론이 없습니다",
    description: "프로젝트 기반이 준비되었습니다. 경론 스키마와 분류·트리 편집은 W05 이후 연결합니다.",
  },
  stories: {
    title: "이야기",
    intro: "출처와 각색 정보를 갖춘 이야기를 관리합니다.",
    empty: "아직 등록된 이야기가 없습니다",
    description: "이야기 콘텐츠 모델과 편집 화면은 W08·W26에서 연결합니다.",
  },
  blog: {
    title: "블로그",
    intro: "날짜와 작성자, 태그를 갖춘 글을 관리합니다.",
    empty: "아직 등록된 블로그 글이 없습니다",
    description: "블로그 콘텐츠 모델과 편집 화면은 W08·W26에서 연결합니다.",
  },
  pages: {
    title: "일반 페이지",
    intro: "소개와 운영 정보처럼 독립적인 페이지를 관리합니다.",
    empty: "아직 등록된 페이지가 없습니다",
    description: "일반 페이지 모델과 메뉴 편집은 W08·W26에서 연결합니다.",
  },
  media: {
    title: "미디어",
    intro: "공개 상태와 사용 관계를 확인하며 자산을 관리합니다.",
    empty: "아직 등록된 미디어가 없습니다",
    description: "미디어 등록·참조·공개 선별 화면은 W13·W25에서 연결합니다.",
  },
};

function readSessionToken() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const fromUrl = fragment.get("session");
  if (fromUrl) {
    sessionStorage.setItem("borido.localSession", fromUrl);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return fromUrl;
  }
  return sessionStorage.getItem("borido.localSession");
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("X-Borido-Session", state.token);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? "로컬 서버 요청에 실패했습니다.");
    error.code = payload?.error?.code ?? "REQUEST_FAILED";
    error.details = payload?.error?.details ?? {};
    throw error;
  }
  return payload;
}

function showOnly(name) {
  elements.loading.hidden = name !== "loading";
  elements.session.hidden = name !== "session";
  elements.blocked.hidden = name !== "blocked";
  elements.shell.hidden = name !== "shell";
}

function setStatus(label, mode = "idle") {
  elements.status.textContent = label;
  elements.status.dataset.state = mode;
  elements.live.textContent = label;
}

function showNotice(message, code) {
  elements.notice.textContent = code ? `${message} (${code})` : message;
  elements.notice.hidden = false;
  elements.notice.focus?.();
}

function clearNotice() {
  elements.notice.hidden = true;
  elements.notice.textContent = "";
}

function currentPublicUrl(settings) {
  if (!settings?.base_url) return "";
  return `${settings.base_url}${settings.base_path === "/" ? "/" : settings.base_path}`;
}

function formInput() {
  const data = new FormData(elements.form);
  return {
    site_name: data.get("site_name")?.trim(),
    description: data.get("description") ?? "",
    default_language: data.get("default_language")?.trim(),
    author_name: data.get("author_name") ?? "",
    license: data.get("license") ?? "",
    timezone: data.get("timezone")?.trim(),
    public_url: data.get("public_url")?.trim() ?? "",
  };
}

function fillForm(settings = null) {
  const defaults = {
    site_name: "",
    description: "",
    default_language: navigator.language || "ko",
    author_name: "",
    license: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    public_url: "",
  };
  const values = settings
    ? { ...settings, public_url: currentPublicUrl(settings) }
    : defaults;
  for (const [name, value] of Object.entries(values)) {
    const field = elements.form.elements.namedItem(name);
    if (field) field.value = value ?? "";
  }
  state.dirty = false;
  setStatus(state.mode === "new" ? "입력 대기" : "저장됨");
}

function connectionLabel(connection) {
  if (!connection) return "미연결";
  return `${connection.repository_url} · ${connection.branch}`;
}

function renderSettings() {
  state.view = "settings";
  elements.settingsView.hidden = false;
  elements.placeholderView.hidden = true;
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === "settings";
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  const isNew = state.mode === "new";
  elements.settingsEyebrow.textContent = isNew ? "FIRST RUN" : "SITE SETTINGS";
  elements.settingsTitle.textContent = isNew ? "새 프로젝트 시작" : "사이트 설정";
  elements.settingsIntro.textContent = isNew
    ? "로컬 원본을 만들기 전에 사이트 기본 정보를 확인합니다."
    : "사이트의 기본 정보와 공개 주소를 관리합니다.";
  elements.newProjectNote.hidden = !isNew;
  elements.connectionSection.hidden = isNew;
  elements.reloadButton.hidden = isNew;
  elements.saveButton.textContent = isNew ? "프로젝트 만들기" : "설정 저장";
  elements.headerSiteName.textContent = state.project?.settings.site_name ?? "새 프로젝트";
  elements.projectPath.textContent = state.root;
  elements.projectPath.title = state.root;
  elements.newProjectPath.textContent = state.root;
  elements.sourceConnection.textContent = connectionLabel(
    state.project?.settings.source_repository,
  );
  elements.deploymentConnection.textContent = connectionLabel(
    state.project?.settings.deployment,
  );
  fillForm(state.project?.settings ?? null);
  requestAnimationFrame(() => elements.form.elements.site_name.focus());
}

function renderContent(view) {
  if (state.mode !== "existing") {
    showNotice("프로젝트를 먼저 만들어야 콘텐츠 영역을 열 수 있습니다.");
    return;
  }
  state.view = view;
  const copy = contentCopy[view];
  elements.settingsView.hidden = true;
  elements.placeholderView.hidden = false;
  elements.placeholderTitle.textContent = copy.title;
  elements.placeholderIntro.textContent = copy.intro;
  elements.emptyTitle.textContent = copy.empty;
  elements.emptyDescription.textContent = copy.description;
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  elements.placeholderView.querySelector("h1").focus?.();
}

async function loadBootstrap({ keepView = false } = {}) {
  clearNotice();
  const payload = await api("/api/v1/bootstrap");
  state.mode = payload.bootstrap.mode;
  state.root = payload.bootstrap.root;
  state.project = payload.bootstrap.project;

  if (state.mode === "blocked") {
    elements.blockedMessage.textContent = payload.bootstrap.error?.message;
    showOnly("blocked");
    return;
  }

  showOnly("shell");
  if (keepView && state.view !== "settings") renderContent(state.view);
  else renderSettings();
}

async function saveSettings(event) {
  event?.preventDefault();
  clearNotice();
  if (state.saving || !elements.form.reportValidity()) return;
  state.saving = true;
  elements.saveButton.disabled = true;
  setStatus("저장 중", "dirty");
  try {
    const input = formInput();
    const payload =
      state.mode === "new"
        ? await api("/api/v1/project", {
            method: "POST",
            body: JSON.stringify({ input }),
          })
        : await api("/api/v1/project/settings", {
            method: "PUT",
            body: JSON.stringify({
              input,
              expected_revision: state.project.settings_revision,
            }),
          });
    const wasNew = state.mode === "new";
    state.mode = "existing";
    state.root = payload.project.root;
    state.project = payload.project;
    state.dirty = false;
    elements.headerSiteName.textContent = payload.project.settings.site_name;
    setStatus("저장됨");
    elements.live.textContent = wasNew
      ? "새 프로젝트를 만들었습니다. 경론 목록으로 이동합니다."
      : "사이트 설정을 저장했습니다.";
    if (wasNew) renderContent("texts");
    else renderSettings();
  } catch (error) {
    setStatus(error.code === "PROJECT_REVISION_CONFLICT" ? "외부 변경" : "저장 실패", "error");
    showNotice(error.message, error.code);
  } finally {
    state.saving = false;
    elements.saveButton.disabled = false;
  }
}

elements.form.addEventListener("input", () => {
  if (state.saving) return;
  state.dirty = true;
  setStatus("저장 필요", "dirty");
});
elements.form.addEventListener("submit", saveSettings);
elements.reloadButton.addEventListener("click", async () => {
  if (state.dirty && !confirm("저장하지 않은 입력을 버리고 다시 읽을까요?")) return;
  try {
    await loadBootstrap();
  } catch (error) {
    showNotice(error.message, error.code);
  }
});
document.querySelector("#primary-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  if (state.dirty && !confirm("저장하지 않은 입력이 있습니다. 이동할까요?")) return;
  clearNotice();
  if (button.dataset.view === "settings") renderSettings();
  else renderContent(button.dataset.view);
});
document.querySelector("[data-view-link='settings']").addEventListener("click", renderSettings);
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (state.view === "settings") saveSettings();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

async function start() {
  state.token = readSessionToken();
  if (!state.token) {
    showOnly("session");
    return;
  }
  try {
    await loadBootstrap();
  } catch (error) {
    if (error.code === "INVALID_SESSION") {
      sessionStorage.removeItem("borido.localSession");
      showOnly("session");
      return;
    }
    elements.blockedMessage.textContent = error.message;
    showOnly("blocked");
  }
}

start();
