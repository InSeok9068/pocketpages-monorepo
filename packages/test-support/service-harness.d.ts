interface ImportBaseOptions {
  /** 대상 컬렉션 이름입니다. */
  collection: string
  /** CSV 구분자입니다. */
  delimiter?: string
  /** importer 동시 실행 수입니다. */
  goroutines?: number
  /** importer 진행 출력 주기입니다. */
  printDelay?: string
  /** PocketBase validation 실행 여부입니다. */
  validate?: boolean
}

export type FixtureImportOptions = ImportBaseOptions & {
  /** `packages/test-support/fixtures` 기준 CSV 경로입니다. */
  fixture: string
  serviceFixture?: never
}

export type ServiceFixtureImportOptions = ImportBaseOptions & {
  fixture?: never
  /** `apps/<service>/__tests__/fixtures` 기준 CSV 경로입니다. */
  serviceFixture: string
}

export type ServiceImportOptions = FixtureImportOptions | ServiceFixtureImportOptions

export interface StartServiceOptions {
  /** 서비스 이름입니다. */
  serviceName: string
  /** readiness 대기 시간입니다. */
  timeoutMs?: number
  /** 서비스 시작 전 temp pb_data에 넣을 CSV 목록입니다. */
  imports?: ServiceImportOptions[]
}

export interface StartedService {
  /** 실행 중인 서비스 base URL입니다. */
  baseUrl: string
  /** 서비스 프로세스와 temp pb_data를 정리합니다. */
  stop(): Promise<void>
}

/** 테스트용 PocketPages 서비스를 띄우고 종료 함수를 돌려줍니다. */
export function startService(options: StartServiceOptions): Promise<StartedService>
