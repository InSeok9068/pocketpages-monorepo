(function () {
  const DB_NAME = 'mom-calendar'
  const DB_VERSION = 1
  const WORKPLACES = 'workplaces'
  const WORK_LOGS = 'work_logs'

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
  }
})()
