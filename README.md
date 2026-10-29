# 보리도 · Borido

보리도는 개인이 불교 경론·이야기·블로그·일반 페이지를 로컬 파일로 편집하고, 독립적인 정적 사이트로 생성·공개하는 도구다. 원본 보존, 문헌 구조와 안정적인 주소, 명시적인 공개와 배포를 우선한다.

- 프로젝트 저장소: [biwoom/borido](https://github.com/biwoom/borido)
- 개발 기준: [문서 안내](docs/README.md)
- 작업 지침: [AGENTS.md](AGENTS.md)
- 현재 상태: **W01–W05 완료.** Node/npm 기반, 사용자 프로젝트/설정, 보호된 루프백 서버·최초 실행 UI와 읽기 전용 콘텐츠 스키마/검증/인덱스를 구현했다. 콘텐츠 저장·편집, 정적 사이트 생성과 배포는 아직 없다.

## 문서 읽기

|문서|내용|
|---|---|
|[프로젝트 기획](docs/product.md)|목적·철학·범위·사용 흐름·MVP|
|[콘텐츠 명세](docs/content-spec.md)|데이터·파일·ID·분류·공개 조건·URL·링크·미디어|
|[화면 명세](docs/ui-spec.md)|공개 사이트·경론 읽기·로컬 편집기와 접근성|
|[기술 명세](docs/technical-spec.md)|실행 환경·모듈·API 경계·저장·빌드·보안·배포|
|[개발 계획](docs/development-plan.md)|작업 단위·의존성·테스트·완료 조건|
|[결정 기록](docs/decisions.md)|채택·변경한 D01–D24, 이전 쟁점의 처리와 남은 검증|

2026-10-29 사용자가 설계 추천안 적용과 역할별 문서 통합을 승인했다. 위 문서가 현재 개발 기준이며, [기존 문서 아카이브](docs/archive/README.md)는 개정 이력 확인용이다. 아카이브에 남은 ‘미결정’과 과거의 URL/저장 예시는 현재 기준을 대체하지 않는다.

## 통합 운영 구조

운영 목표는 이 저장소의 `main` 하나에서 프로그램·문서와 예약된 `project/` 원본을 함께 관리하는 것이다. `project/` 안에 `content/`, `media/`, `config/`, 로컬 `dist/`를 두되 프로그램 코드와 쓰기 책임을 분리한다. 외부 프로젝트를 명시 경로로 여는 기능도 유지한다.

콘텐츠의 `draft`·`private` 상태는 사이트 출력만 통제한다. 공개 `main`에 올린 원본이나 과거 이력을 숨겨주지 않으므로 비밀·개인정보·공개 권한 없는 자료는 저장하지 않는다. 로컬 `dist/`는 `main`에서 추적하지 않고, 명시적 배포 때 GitHub Actions가 검증된 Pages artifact만 게시한다. Pages URL 후보는 `https://biwoom.github.io/borido/`이며 실제 설정/호스팅 검증은 W28–W31에 속한다.

## 실행 상태

Node.js 24 LTS·npm·ES Modules, 기본 HTTP 서버와 바닐라 UI를 채택했다. W01 검증 기준은 Node.js 24.22.2와 npm 11.14.1이며 `.nvmrc`와 `.node-version`에 기록했다. 현재 개발 컴퓨터의 기본 Node.js 25는 지원 범위가 아니므로 Node 24 환경을 선택해야 한다.

```sh
npm ci
npm run check
npm test
npm run test:e2e
npm run validate -- /absolute/user-project
```

`check`는 지원 Node/npm 환경을 검사한다. `test:e2e`는 Playwright Chromium에서 최초 실행·설정 재열기와 세션 경계를 확인한다. `validate`는 W05 읽기 전용 콘텐츠 검사에 연결했으며 `build`는 아직 제공하지 않는다.

현재 W02 프로젝트 CLI는 아직 프로그램 체크아웃 밖의 존재하지 않는 경로만 초기화한다. D23–D24 목표 구조의 기본 `./project` 실행과 Actions 배포는 W06·W28–W31에서 구현하며, 그 전까지 기존 경로를 임의 이동하지 않는다.

```sh
npm run project -- init /absolute/user-project \
  --name "내 자료실" --language ko --timezone Asia/Seoul \
  --public-url https://example.github.io/library/

npm run project -- open /absolute/user-project
```

공개 URL을 생략하면 오프라인 프로젝트로 시작한다. 전체 필드와 오류 계약은 [기술 명세의 W02 계약](docs/technical-spec.md#w02-project-contract)을 따른다.

W04 로컬 편집기는 다음처럼 시작한다. 존재하지 않는 경로면 최초 실행 화면에서 프로젝트를 만들고, 기존 보리도 프로젝트면 설정 화면을 연다. 포트를 생략하면 사용 가능한 루프백 포트를 선택하며 터미널에 출력된 `url`을 브라우저에서 연다.

```sh
npm run dev -- --project /absolute/user-project
```

화면에서 사이트명·설명·언어·시간대·작성자·라이선스·공개 URL을 확인하고 명시적으로 저장한다. GitHub 연결 없이 오프라인으로 시작할 수 있으며 초기화 후 경론 목록 자리로 이동한다. 경로 선택은 실행 인자로만 고정하고 화면에서 다른 루트로 바꾸지 않는다. 계약은 [W03 서버](docs/technical-spec.md#w03-server-contract)와 [W04 UI](docs/technical-spec.md#w04-admin-contract)를 따른다.

W05 `validate`는 콘텐츠·경론 내부 레코드, 미디어, 분류, URL 이력과 사이트 설정을 읽기 전용으로 검사한다. 진단에는 수준·코드·프로젝트 상대 경로·레코드 ID·필드가 포함되며 원본을 자동 수정하지 않는다. 성공은 종료코드 0, 검증 오류는 1, 명령/프로젝트 열기 오류는 2다. 다음 작업은 W06의 안전한 저장·복구 기반이다.
