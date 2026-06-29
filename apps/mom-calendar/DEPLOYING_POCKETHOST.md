# PocketHost 배포

`mom-calendar`만 PocketHost에 배포하기 위한 절차입니다. 명령은 반드시 이 디렉터리(`apps/mom-calendar`) 기준으로 실행합니다.

## 최초 1회

```bash
npm i -g phio
cd apps/mom-calendar
phio login
phio link <instanceName>
phio info
```

- `<instanceName>`은 PocketHost에서 만든 `mom-calendar` 전용 인스턴스 이름입니다.
- `phio link`는 `.phioconfig`를 만들지만, 이 파일은 개인 배포 연결값이라 git에 올리지 않습니다.
- `phio info`에서 로그인 계정, 연결된 인스턴스, deploy key 상태를 확인합니다.

Windows 로컬에서 `phio deploy`가 `pb_hooks\pages\...`처럼 백슬래시 경로를 만들며 실패할 수 있습니다. 그 경우 아래 GitHub Actions 배포를 사용합니다.

## 배포

```bash
cd apps/mom-calendar
phio deploy
```

PHIO 기본 동작은 `pb_*`, `package.json`, `bun.lock*`, `patches/**`만 업로드하고 `pb_data/**`는 제외합니다. 이 앱에서는 주로 `pb_hooks`, `pb_schema.json`, `package.json`이 배포 대상입니다.

## GitHub Actions 배포

이 repo는 `release/mom-calendar` 브랜치에 push하면 PocketHost 배포 workflow가 실행됩니다.

필요한 GitHub secrets:

- `PHIO_USERNAME`: PocketHost 로그인 이메일
- `PHIO_PASSWORD`: PocketHost 로그인 비밀번호
- `PHIO_INSTANCE_NAME`: 배포할 PocketHost 인스턴스 이름
- `PHIO_DEPLOY_KEY`: 로컬 `phio_deploy_ed25519` private key 전체 내용

배포 흐름:

```bash
git checkout -B release/mom-calendar
git merge main
git push origin release/mom-calendar
```

기존 Docker release workflow는 `release/mom-calendar`에서는 실행되지 않도록 제외했습니다.

`PHIO_DEPLOY_KEY`는 PocketHost Settings > Keys에 등록된 `Phio` public key와 짝이 맞는 private key여야 합니다. Windows 기본 위치는 보통 아래 경로입니다.

```powershell
Get-Content "$env:APPDATA\phio-nodejs\Config\phio_deploy_ed25519"
```

이 값을 GitHub secret으로 넣으면 Actions가 실행될 때 `/tmp/phio/phio_deploy_ed25519`로 복원하고, public key는 `ssh-keygen`으로 다시 생성합니다.

## 주의

- 루트 디렉터리에서 `phio deploy`를 실행하지 않습니다. 모노레포 전체가 기준이 될 수 있습니다.
- 기존 서비스와 섞이지 않도록 PocketHost 인스턴스는 `mom-calendar` 전용으로 새로 만듭니다.
- 로컬 데이터(`pb_data`), 실행 파일(`pocketbase.exe`, `pbw.exe`), `node_modules`는 배포 대상이 아닙니다.
- PocketHost에 이미 다른 hooks가 있는 인스턴스에 배포하면 해당 인스턴스의 파일과 충돌할 수 있습니다.
