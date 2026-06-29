;(function () {
  const DB_NAME = 'mom-calendar'
  const DB_VERSION = 2
  const WORKPLACES = 'workplaces'
  const WORK_LOGS = 'work_logs'
  const BACKUP_META = 'backup_meta'
  const BACKUP_META_KEY = 'backup'

  let dbPromise

  /**
   * IndexedDB 연결을 준비한다.
   * @returns {Promise<IDBDatabase>}
   */
  function openDatabase() {
    if (dbPromise) return dbPromise

    dbPromise = new Promise(function (resolve, reject) {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onupgradeneeded = function () {
        const db = request.result

        if (!db.objectStoreNames.contains(WORKPLACES)) {
          const workplaces = db.createObjectStore(WORKPLACES, { keyPath: 'id' })
          workplaces.createIndex('name', 'name', { unique: false })
          workplaces.createIndex('updatedAt', 'updatedAt', { unique: false })
        }

        if (!db.objectStoreNames.contains(WORK_LOGS)) {
          const workLogs = db.createObjectStore(WORK_LOGS, { keyPath: 'date' })
          workLogs.createIndex('workplaceId', 'workplaceId', { unique: false })
          workLogs.createIndex('updatedAt', 'updatedAt', { unique: false })
        }

        if (!db.objectStoreNames.contains(BACKUP_META)) {
          db.createObjectStore(BACKUP_META, { keyPath: 'key' })
        }
      }

      request.onsuccess = function () {
        resolve(request.result)
      }

      request.onerror = function () {
        reject(request.error)
      }
    })

    return dbPromise
  }

  /**
   * 저장소의 모든 레코드를 가져온다.
   * @param {string} storeName
   * @returns {Promise<Array<any>>}
   */
  function getAll(storeName) {
    return openDatabase().then(function (db) {
      return new Promise(function (resolve, reject) {
        const transaction = db.transaction(storeName, 'readonly')
        const request = transaction.objectStore(storeName).getAll()

        request.onsuccess = function () {
          resolve(request.result || [])
        }

        request.onerror = function () {
          reject(request.error)
        }
      })
    })
  }

  /**
   * key로 레코드를 가져온다.
   * @param {string} storeName
   * @param {IDBValidKey} key
   * @returns {Promise<any>}
   */
  function getOne(storeName, key) {
    return openDatabase().then(function (db) {
      return new Promise(function (resolve, reject) {
        const transaction = db.transaction(storeName, 'readonly')
        const request = transaction.objectStore(storeName).get(key)

        request.onsuccess = function () {
          resolve(request.result || null)
        }

        request.onerror = function () {
          reject(request.error)
        }
      })
    })
  }

  /**
   * 레코드를 저장한다.
   * @param {string} storeName
   * @param {any} value
   * @returns {Promise<void>}
   */
  function putOne(storeName, value) {
    return openDatabase().then(function (db) {
      return new Promise(function (resolve, reject) {
        const transaction = db.transaction(storeName, 'readwrite')
        transaction.objectStore(storeName).put(value)

        transaction.oncomplete = function () {
          resolve()
        }

        transaction.onerror = function () {
          reject(transaction.error)
        }
      })
    })
  }

  /**
   * key로 레코드를 삭제한다.
   * @param {string} storeName
   * @param {IDBValidKey} key
   * @returns {Promise<void>}
   */
  function deleteOne(storeName, key) {
    return openDatabase().then(function (db) {
      return new Promise(function (resolve, reject) {
        const transaction = db.transaction(storeName, 'readwrite')
        transaction.objectStore(storeName).delete(key)

        transaction.oncomplete = function () {
          resolve()
        }

        transaction.onerror = function () {
          reject(transaction.error)
        }
      })
    })
  }

  /**
   * 백업 메타 정보를 가져온다.
   * @returns {Promise<types.BackupMeta | null>}
   */
  function getBackupMeta() {
    return getOne(BACKUP_META, BACKUP_META_KEY).then(function (meta) {
      if (!meta) return null

      return {
        backupId: String(meta.backupId || ''),
        lastBackupAt: String(meta.lastBackupAt || ''),
        lastRestoreAt: String(meta.lastRestoreAt || ''),
      }
    })
  }

  /**
   * 백업 메타 정보를 저장한다.
   * @param {types.BackupMeta} meta
   * @returns {Promise<void>}
   */
  function saveBackupMeta(meta) {
    return putOne(
      BACKUP_META,
      Object.assign(
        {
          key: BACKUP_META_KEY,
        },
        meta
      )
    )
  }

  /**
   * 백업 파일 형태로 로컬 데이터를 묶는다.
   * @returns {Promise<types.MomCalendarBackup>}
   */
  function exportBackupData() {
    return Promise.all([listWorkplaces(), listWorkLogs(), getBackupMeta()]).then(function (results) {
      const meta = results[2] || {}

      return {
        app: 'mom-calendar',
        version: 1,
        backupId: String(meta.backupId || ''),
        createdAt: new Date().toISOString(),
        data: {
          workplaces: results[0],
          workLogs: results[1],
        },
      }
    })
  }

  /**
   * 복구 가능한 백업 데이터인지 확인한다.
   * @param {any} backup
   * @returns {{workplaces: Array<types.Workplace>, workLogs: Array<types.WorkLog>}}
   */
  function getValidBackupData(backup) {
    if (!backup || typeof backup !== 'object' || backup.app !== 'mom-calendar') {
      throw new Error('백업 데이터가 올바르지 않습니다.')
    }

    if (!backup.data || typeof backup.data !== 'object') {
      throw new Error('백업 데이터가 올바르지 않습니다.')
    }

    if (!Array.isArray(backup.data.workplaces) || !Array.isArray(backup.data.workLogs)) {
      throw new Error('백업 데이터가 올바르지 않습니다.')
    }

    return {
      workplaces: backup.data.workplaces,
      workLogs: backup.data.workLogs,
    }
  }

  /**
   * 백업 데이터로 로컬 데이터를 교체한다.
   * @param {types.MomCalendarBackup} backup
   * @returns {Promise<void>}
   */
  function importBackupData(backup) {
    const data = getValidBackupData(backup)

    return openDatabase().then(function (db) {
      return new Promise(function (resolve, reject) {
        const transaction = db.transaction([WORKPLACES, WORK_LOGS], 'readwrite')
        const workplaceStore = transaction.objectStore(WORKPLACES)
        const workLogStore = transaction.objectStore(WORK_LOGS)

        workplaceStore.clear()
        workLogStore.clear()

        data.workplaces.forEach(function (workplace) {
          workplaceStore.put(workplace)
        })

        data.workLogs.forEach(function (workLog) {
          workLogStore.put(workLog)
        })

        transaction.oncomplete = function () {
          resolve()
        }

        transaction.onerror = function () {
          reject(transaction.error)
        }
      })
    })
  }

  /**
   * 근무지를 이름순으로 가져온다.
   * @returns {Promise<Array<types.Workplace>>}
   */
  function listWorkplaces() {
    return getAll(WORKPLACES).then(function (workplaces) {
      return workplaces.sort(function (left, right) {
        return left.name.localeCompare(right.name, 'ko')
      })
    })
  }

  /**
   * 날짜별 근무 기록을 가져온다.
   * @returns {Promise<Array<types.WorkLog>>}
   */
  function listWorkLogs() {
    return getAll(WORK_LOGS).then(function (logs) {
      return logs.sort(function (left, right) {
        return left.date.localeCompare(right.date)
      })
    })
  }

  window.MomCalendarDb = {
    listWorkplaces: listWorkplaces,
    saveWorkplace: function (workplace) {
      return putOne(WORKPLACES, workplace)
    },
    deleteWorkplace: function (id) {
      return deleteOne(WORKPLACES, id)
    },
    getWorkLog: function (date) {
      return getOne(WORK_LOGS, date)
    },
    listWorkLogs: listWorkLogs,
    saveWorkLog: function (workLog) {
      return putOne(WORK_LOGS, workLog)
    },
    deleteWorkLog: function (date) {
      return deleteOne(WORK_LOGS, date)
    },
    getBackupMeta: getBackupMeta,
    saveBackupMeta: saveBackupMeta,
    exportBackupData: exportBackupData,
    importBackupData: importBackupData,
  }
})()
