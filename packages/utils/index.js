'use strict';

const dateutil = require('./dateutil');

/**
 * utils 패키지 연결 상태를 간단히 확인합니다.
 */
function logUtilsReady() {
  console.log('@pocketpages/utils ready');
}

module.exports = {
  dateutil,
  logUtilsReady,
};
