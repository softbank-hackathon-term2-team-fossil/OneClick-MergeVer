# SBSB 설계 맥락

## 목표

고객이 GitHub 저장소와 기존 VM 정보만 연결하면 Docker 지식 없이도 빌드, 설치,
업데이트를 수행하는 배포 플랫폼이다. 현재 대상은 단일 웹 애플리케이션과 SSH로
접속 가능한 Ubuntu/Debian VM이다.

## 전체 흐름

```text
고객 코드 push
  → 고객 저장소의 GitHub Actions가 Docker 이미지 빌드
  → SBSB 전용 비공개 Docker Hub 저장소에 push
  → 고객이 SBSB에서 VM 배포 요청
  → SBSB 백엔드가 VM에 SSH 접속
  → Docker Hub 이미지 pull
  → 기존 컨테이너 교체
```

GitHub Actions는 이미지 빌드와 업로드까지만 담당한다. 고객 VM으로 SSH 접속하고
컨테이너를 교체하는 주체는 SBSB 백엔드다.

## GitHub 연결과 설정 PR

고객은 SBSB GitHub App을 저장소에 설치한다. App은 선택된 저장소에서 다음 작업만
수행한다.

- 빌드에 필요한 제한된 파일 읽기
- AI가 생성한 `Dockerfile`과 검증된 `sbsb-build.yml`을 별도 브랜치에 추가
- 고객 검토용 Pull Request 생성
- 빌드 상태 조회
- SBSB Docker Hub 업로드 키를 Actions Secrets에 암호화 등록

고객이 PR을 머지하면 기준 브랜치의 push를 트리거로 이미지가 생성된다. 태그는
변경 불가능한 커밋 SHA와 편의를 위한 `latest` 두 가지를 사용한다.

## SBSB 전용 비공개 Docker Hub 저장소

현재 구현은 SBSB가 관리하는 Docker Hub private repository 하나를 사용한다.
운영자가 저장소를 한 번 만든 뒤, 고객 저장소마다
`<github-owner>-<repository>-<hash>` 형태의 태그 접두사를 사용한다.

고객 GitHub Actions에는 SBSB Docker Hub 사용자명과 access token을 Actions
Secret으로 등록하므로 고객이 토큰을 직접 입력하지 않는다. 이미지 태그는
`<고객접두사>-<commit-sha>`와 `<고객접두사>-latest` 두 종류다.

SBSB 백엔드는 배포할 때 동일한 Docker Hub 계정으로 로그인한다. 인증정보는 SSH
연결을 통해 Docker 로그인에 잠깐 사용한 뒤 VM의 임시 Docker 설정 디렉터리와
함께 삭제된다.

## 온프레미스 배포

고객이 입력하는 값은 다음과 같다.

- VM 주소 또는 IP
- SSH 포트와 사용자
- SSH 비밀번호 또는 개인 키
- 외부 공개 포트
- 컨테이너 내부 포트

SBSB 백엔드는 SSH로 접속해 Docker 실행 권한을 확인한 뒤 이미지 pull, 기존
컨테이너 제거, 새 컨테이너 실행을 순서대로 수행한다. SSH 정보는 GitHub Actions
Secret에 저장하지 않는다. 첫 배포가 성공하면 서버 연결정보와 SSH 인증정보를
SBSB 서버에 AES-256-GCM으로 암호화 저장한다. 이후 고객이 코드를 push해 새
`latest` 이미지가 만들어지면 `최신 이미지로 업데이트` 버튼 한 번으로 같은
서버의 컨테이너를 교체한다.

## 환경 변수

- `DOCKERHUB_NAMESPACE`: 이미지 저장소를 소유한 Docker Hub 사용자 또는 조직
- `DOCKERHUB_REPOSITORY`: 미리 만든 private repository 이름
- `DOCKERHUB_USERNAME`: push/pull에 사용할 Docker Hub 사용자 또는 조직
- `DOCKERHUB_ACCESS_TOKEN`: read/write 권한의 access token
- `SBSB_CREDENTIAL_ENCRYPTION_KEY`: 저장된 SSH 인증정보를 암호화하는 서버 키
- `DATABASE_URL`: SBSB 자체 Postgres 주소 (프로젝트, 저장된 서버, 배포 이력)

Docker Hub access token은 서버 환경 변수에서만 관리하고 코드에 저장하지 않는다.

## 클라우드 배포 (AWS EC2, Azure VM)

온프레미스와 같은 Docker Hub 이미지를 클라우드 VM이 직접 받아 실행한다. 이미지는 한 번만
게시되고 대상마다 다시 올리지 않으므로, 어느 대상에 배포하든 같은 이미지다.

```text
GitHub Actions 빌드 ─┐
                     ├─▶ Docker Hub ◀── 온프레미스 VM (SSH로 지시)
ZIP 업로드 → 로컬 빌드 ┘             ◀── AWS EC2 (SSM Run Command로 지시)
                                    ◀── Azure VM (VM Run Command로 지시)
```

소스는 두 가지다.

- GitHub: 화면에서 고른 커밋의 이미지를 사용한다. 선택 가능한 버전은 해당 브랜치에서 SBSB
  빌드가 성공했고 Docker Hub에 이미지가 남아 있는 최근 커밋이다.
- ZIP: SBSB 서버에서 검사·AI Dockerfile 생성·`linux/amd64` 빌드를 한 뒤 같은 Docker Hub
  저장소에 `zip-<해시>` 태그로 올린다.

### 클라우드 VM의 Docker Hub 인증

Docker Hub는 클라우드 밖의 저장소라 VM의 클라우드 신원(IAM 역할, 관리 ID)을 알아보지 못한다.
그래서 Docker Hub 토큰이 필요한데, SSM Run Command와 VM Run Command는 보낸 명령 문장을
기록으로 남기므로 토큰을 명령에 넣으면 그 기록에 노출된다.

이를 피하려고 읽기 전용 Docker Hub 토큰을 각 클라우드의 비밀 저장소에 두고, VM이 자기 신원으로
직접 읽게 한다. 원격 명령에는 "저장소에서 읽어 로그인하라"는 문장만 들어간다.

| | AWS | Azure |
| --- | --- | --- |
| 토큰 위치 | SSM Parameter Store SecureString | Key Vault secret (Azure RBAC 권한 모드) |
| VM이 읽는 권한 | 인스턴스 역할의 `ssm:GetParameter` | 관리 ID의 `Key Vault Secrets User` (SBSB가 배포 때 부여) |
| 로그인 흔적 | 임시 Docker 설정 디렉터리, 스크립트 종료 시 삭제 | 동일 |

운영자가 한 번 해 둘 일:

1. Docker Hub에서 **읽기 전용** 토큰을 따로 발급한다. 업로드용 `DOCKERHUB_ACCESS_TOKEN`을
   재사용하지 않는다.
2. AWS: 배포할 리전마다 `aws ssm put-parameter --name /sbsb/dockerhub/token --type SecureString`으로
   저장하고, EC2 인스턴스 역할에 `AmazonSSMManagedInstanceCore`와 그 파라미터의
   `ssm:GetParameter`를 준다. 기존 EC2를 고르는 경우 그 인스턴스의 역할에도 같은 권한이 필요하다.
3. Azure: RBAC 권한 모드의 Key Vault에 `sbsb-dockerhub-token` 이름으로 저장한다.
4. `.env.local`에 `SBSB_AWS_DOCKERHUB_TOKEN_PARAMETER`, `SBSB_AZURE_KEY_VAULT` 등을 설정한다
   (`.env.example` 참고).

검토한 대안: 클라우드마다 자체 레지스트리(ECR, ACR)로 이미지를 복사하면 토큰 없이 클라우드
신원만으로 받을 수 있다. 다만 SBSB 서버가 이미지를 받아 다시 올려야 하고 대상 간 이미지가
같다는 보장이 약해져, 단일 레지스트리를 택하고 인증을 비밀 저장소로 해결했다.

### Google Cloud Run

VM 대상과 달리 서버가 없다. 이미지 주소만 주면 구글이 실행하고, 요청량에 따라 0개에서
`GCP_MAX_INSTANCES`개까지 자동으로 늘리고 줄이며, HTTPS 주소를 자동으로 발급한다. 저장소마다
Cloud Run 서비스 하나를 두고, 배포할 때마다 그 서비스의 새 리비전이 된다. 새 리비전이
헬스체크 경로에 응답하지 않으면 직전에 서비스하던 리비전으로 트래픽을 되돌린다.

Cloud Run은 서버가 없어 `docker login`을 실행할 곳이 없고, 비공개 Docker Hub 이미지를 직접
받지 못한다. 그래서 Artifact Registry의 **원격 저장소**가 Docker Hub에서 대신 받아 오게 한다.
SBSB는 이미지 주소의 호스트만 원격 저장소 주소로 바꾼다.

```text
sbsb/sbsb-images:<접두사>-<sha>
  → <리전>-docker.pkg.dev/<프로젝트>/<원격 저장소>/sbsb/sbsb-images:<접두사>-<sha>
```

Docker Hub 토큰은 Secret Manager에 두고 원격 저장소의 업스트림 인증으로 연결한다. AWS·Azure와
같은 원리다. 외부 레지스트리의 토큰을 클라우드의 비밀 저장소에 두고, 클라우드 안의 것이 자기
신원으로 읽는다.

운영자가 한 번 해 둘 일: `GCP_LOCATION`에 Docker Hub를 업스트림으로 하는 Artifact Registry 원격
저장소를 만들고(읽기 전용 토큰은 Secret Manager), 배포용 서비스 계정에 Cloud Run Admin,
Service Account User, Artifact Registry Reader를 준 뒤 그 키 파일 경로를
`GOOGLE_APPLICATION_CREDENTIALS`에 설정한다. Cloud Run이 `/healthz`를 가로채므로 헬스체크 경로는
다른 값을 쓴다.

| | AWS EC2 · Azure VM | Cloud Run |
| --- | --- | --- |
| 실행 단위 | VM 한 대의 컨테이너 하나 | 서버 없음, 요청에 따라 0~N개 |
| 공개 주소 | VM의 공인 IP, HTTP 80 | 자동 발급, HTTPS |
| 이미지 수령 | VM이 Docker Hub에 직접 로그인 | Artifact Registry 원격 저장소가 대신 |
| 실패 시 | 기존 컨테이너는 이미 제거됨 | 이전 리비전으로 자동 복원 |

### 클라우드 배포의 제약

- VM 한 대에 컨테이너 하나(`sbsb-app`, 호스트 80번 포트). 무중단 교체와 터널은 온프레미스
  경로에만 있고, 클라우드는 기존 컨테이너를 지운 뒤 새로 실행한다.
- 환경 변수 전달, 데이터베이스, HTTPS, 자동 롤백은 없다.
- 배포가 실패해도 새로 만든 VM·보안 그룹은 자동으로 정리하지 않는다. 요금이 남을 수 있다.
- 클라우드 배포 API는 로그인 없이 호출할 수 있다(ZIP 경로). 그래서 `pnpm dev`와 `pnpm start`는
  `127.0.0.1`에만 바인딩한다. 외부에 공개하려면 인증을 먼저 추가해야 한다.
- 사이트 서버에 Docker, AWS CLI, Azure CLI, Python 3이 필요하다.

## 데이터 저장과 배포 이력

OneClick의 구조를 따라 상태를 Postgres에 둔다(Prisma). SBSB에는 사용자 계정이 없으므로,
프로젝트의 주인은 사용자가 아니라 **저장소를 볼 수 있는 GitHub App 설치**다.

| 모델 | 내용 |
| --- | --- |
| `Project` | 설치 ID + 저장소 이름(소문자). 한 설치에서 저장소당 하나 |
| `Server` | 프로젝트의 온프레미스 서버. SSH 인증정보는 AES-256-GCM 암호문으로만 저장 |
| `Deployment` | 배포 한 번. 프로젝트 내 순번, 대상(온프레미스·AWS·Azure), 이미지 태그, 상태, 실패 사유, URL |

배포 흐름:

1. 원격 작업을 시작하기 전에 `RUNNING` 행을 만든다. 프로젝트 행을 잠그고 확인하므로, 같은
   대상에 진행 중인 배포가 있으면 두 번째 요청은 409로 거절된다.
2. 끝나면 `SUCCESS`(URL 기록) 또는 `FAILED`(실패 사유 기록)로 바꾼다.
3. 서버가 시작될 때 `RUNNING`으로 남은 배포는 더 진행될 수 없으므로 `FAILED`로 정리한다.

화면의 배포 이력은 대상별로 가장 최근에 성공한 배포를 "서비스 중"으로 표시한다. 새 배포가
실패하면 무중단 교체가 기존 컨테이너를 유지하므로, 이력에서도 직전 성공 배포가 계속 서비스 중이다.
페이지를 새로 고쳐도 어떤 커밋이 배포되어 있는지 이력에서 복원한다.

### 롤백

온프레미스의 과거 성공 배포는 이력에서 한 번의 클릭으로 되돌린다. 이미지 태그가 커밋 SHA라
그 커밋의 이미지를 저장된 서버에 다시 배포하면 되고, 재빌드는 없다. 되돌리기도 하나의 배포로
기록되며(`trigger = ROLLBACK`) 어느 배포를 복원했는지 남긴다.

- `latest`로 배포한 기록은 되돌릴 수 없다. `latest`는 푸시마다 움직여 과거 버전을 가리키지 않는다.
- 클라우드는 이력에는 남지만 되돌리기 버튼이 없다. 클라우드 패널에서 버전을 골라 다시 배포한다.
- ZIP 배포는 저장소와 설치 정보가 없어 이력에 남기지 않는다.
- 되돌리는 것은 앱 이미지뿐이다. 앱의 데이터나 스키마는 되돌리지 않는다.

이전에 `.sbsb-data/deployments.json`에 저장한 서버 정보는 그 프로젝트를 처음 조회할 때
데이터베이스로 옮긴다.

검토한 대안: OneClick은 로그인한 사용자가 프로젝트를 소유하고, 헬스체크·지표·장애 기록까지
저장한다. SBSB는 GitHub App 설치를 권한의 경계로 쓰고 있어 사용자 모델은 들이지 않았고,
감시와 자동 롤백은 실행 코드가 아직 없어 이번 범위에서 제외했다.

## AI 실패 분석

빌드나 배포가 실패하면 화면에서 "AI로 실패 원인 분석"을 누를 수 있다. 버튼을 누르기 전에는
아무것도 외부로 보내지 않는다.

- 빌드 실패: 실패한 GitHub Actions 작업의 로그 끝부분을 내려받는다.
- 배포 실패: 화면에 표시된 오류와 배포 로그를 쓴다.
- 로그에서 흔한 비밀값 형식(API 키, 토큰, 개인 키, `password=` 등)을 지운 뒤, 그 커밋의
  Dockerfile, 입력한 포트·헬스체크 경로와 함께 LLM에 보낸다.
- 답은 요약, 가장 가능성 높은 원인, 다음 조치로 받는다. Dockerfile을 고치면 해결되는 경우
  수정안도 받으며, 생성 Dockerfile과 같은 검증을 통과한 것만 보여준다. 수정안은 표시만 하고
  자동으로 적용하지 않는다.

LLM은 `LLM_PROVIDER`로 고른다(`openai` 또는 `gemini`). Dockerfile 생성과 실패 분석이 같은 설정을 쓴다.

## 현재 범위와 다음 작업

현재 구현 범위:

- 저장소 분석과 AI Dockerfile 생성
- 설정 PR 생성
- 고객별 태그로 분리된 private Docker Hub 이미지 발행
- 멀티 아키텍처 이미지 빌드
- SBSB 백엔드의 직접 SSH 배포
- AWS EC2·Azure VM·Google Cloud Run 배포와 ZIP 업로드 (Docker Hub 단일 레지스트리)
- 빌드·배포 실패의 AI 분석, LLM 제공자 선택(OpenAI·Gemini)
- 암호화된 VM 연결 저장과 클릭 한 번의 최신 버전 업데이트
- Postgres 기반 배포 이력, 동시 배포 차단, 온프레미스 원클릭 롤백

다음 작업:

- 배포 로그 저장과 실시간 표시
- 배포 후 헬스체크와 장애 시 자동 롤백
- 클라우드 대상의 원클릭 롤백
- SSH host key fingerprint 검증
- 배포 중 장애 발생 시 기존 컨테이너 자동 복구
