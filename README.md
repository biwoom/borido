# 보리도 · Borido

보리도는 개인이 불교 경론·이야기·블로그·일반 페이지를 로컬 파일로 편집하고, 독립적인 정적 사이트로 생성·공개하는 도구다. 원본 보존, 문헌 구조와 안정적인 주소, 명시적인 공개와 배포를 우선한다.

- 프로젝트 저장소: [biwoom/borido](https://github.com/biwoom/borido)
- 개발 기준: [문서 안내](docs/README.md)
- 작업 지침: [AGENTS.md](AGENTS.md)
- 현재 상태: **W01–W03 완료.** Node/npm 기반, 사용자 프로젝트/설정 계약과 보호된 루프백 API 서버를 구현했다. 편집 화면·콘텐츠 기능과 사이트 배포는 아직 없다.

## 문서 읽기

|문서|내용|
|---|---|
|[프로젝트 기획](docs/product.md)|목적·철학·범위·사용 흐름·MVP|
|[콘텐츠 명세](docs/content-spec.md)|데이터·파일·ID·분류·공개 조건·URL·링크·미디어|
|[화면 명세](docs/ui-spec.md)|공개 사이트·경론 읽기·로컬 편집기와 접근성|
|[기술 명세](docs/technical-spec.md)|실행 환경·모듈·API 경계·저장·빌드·보안·배포|
|[개발 계획](docs/development-plan.md)|작업 단위·의존성·테스트·완료 조건|
|[결정 기록](docs/decisions.md)|채택한 D01–D22, 이전 쟁점의 처리와 남은 검증|

2026-10-29 사용자가 설계 추천안 적용과 역할별 문서 통합을 승인했다. 위 문서가 현재 개발 기준이며, [기존 문서 아카이브](docs/archive/README.md)는 개정 이력 확인용이다. 아카이브에 남은 ‘미결정’과 과거의 URL/저장 예시는 현재 기준을 대체하지 않는다.

## 프로그램과 사용자 프로젝트

이 저장소는 프로그램·기본 템플릿·문서·테스트 자료를 관리한다. 실제 사용자 프로젝트는 프로그램 체크아웃 밖에서 관리하며, 그 안에 `content/`, `media/`, `config/`, `dist/`를 둔다. 프로그램 업데이트가 운영 원본을 덮어쓰지 않도록 한다.

콘텐츠의 `private` 상태는 사이트 출력만 통제한다. 공개 Git 저장소에 올린 원본이나 과거 이력을 숨겨주지 않는다. 사용자 원본 저장소와 사이트 배포 대상은 프로젝트별로 별도 지정하며, 이 저장소 주소에서 추측하지 않는다. 실제 Pages URL은 아직 지정되지 않았다.

## 실행 상태

Node.js 24 LTS·npm·ES Modules, 기본 HTTP 서버와 바닐라 UI를 채택했다. W01 검증 기준은 Node.js 24.22.2와 npm 11.14.1이며 `.nvmrc`와 `.node-version`에 기록했다. 현재 개발 컴퓨터의 기본 Node.js 25는 지원 범위가 아니므로 Node 24 환경을 선택해야 한다.

```sh
npm ci
npm run check
npm test
npm run test:e2e
```

`check`는 지원 Node/npm 환경을 검사한다. `test:e2e`는 현재 W01 러너만 확인하며 제품 브라우저 기능 검증은 아니다. `dev`, `validate`, `build`는 해당 기능이 아직 없어 제공하지 않는다.

W02 프로젝트 CLI는 프로그램 체크아웃 밖의 존재하지 않는 경로만 새 프로젝트로 초기화한다. 기존 경로를 덮어쓰지 않으며 GitHub 설정은 생략할 수 있다.

```sh
npm run project -- init /absolute/user-project \
  --name "내 자료실" --language ko --timezone Asia/Seoul \
  --public-url https://example.github.io/library/

npm run project -- open /absolute/user-project
```

공개 URL을 생략하면 오프라인 프로젝트로 시작한다. 전체 필드와 오류 계약은 [기술 명세의 W02 계약](docs/technical-spec.md#w02-project-contract)을 따른다.

기존 프로젝트의 W03 API 서버는 다음처럼 시작한다. 포트를 생략하면 사용 가능한 루프백 포트를 선택하고 Origin·프로젝트 루트·이번 프로세스의 세션 토큰을 JSON으로 한 번 출력한다.

```sh
npm run dev -- --project /absolute/user-project
```

현재 서버는 프로젝트/설정 JSON API만 제공하며 편집 화면은 없다. API 계약은 [기술 명세의 W03 계약](docs/technical-spec.md#w03-server-contract)을 따른다. 다음 작업은 [W04](docs/development-plan.md#phase1)의 최초 실행·설정 UI다.
