# Admin application

W04부터 로컬 편집기 HTML·CSS·바닐라 JavaScript를 둔다. 서버 내부 파일을 직접 읽지 않고 제한된 API만 사용한다.

스타일 계층은 Basecoat Vega 배포 CSS → `styles/tokens.css` → `styles/admin.css` 순서다. 토큰은 검정·흰색·중립 회색을 기반으로 황금색 `#f0b100`을 주 강조, 연두색 `#00c951`을 보조/성공 강조로 사용한다. 흰 배경의 작은 황금 계열 텍스트는 대비를 위해 `--borido-accent-ink`를 사용한다.

OL 프로젝트의 단순한 shadcn/ui 계열 토큰·간격·경계·낮은 그림자 구조를 참고했지만 OL CSS를 런타임 의존성으로 사용하거나 복제하지 않는다. 보리도 컴포넌트와 공개 독서 화면은 자체 요구와 검증 기준으로 발전시킨다.
