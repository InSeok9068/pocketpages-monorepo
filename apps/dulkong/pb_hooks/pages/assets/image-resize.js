;(function (global) {
  'use strict'

  const DEFAULT_MAX_EDGE = 1920
  const DEFAULT_QUALITY = 0.82

  function loadImageElement(file) {
    return new Promise(function (resolve, reject) {
      const objectUrl = URL.createObjectURL(file)
      const image = new Image()

      image.onload = function () {
        resolve({
          source: image,
          width: image.naturalWidth,
          height: image.naturalHeight,
          release: function () {
            URL.revokeObjectURL(objectUrl)
          },
        })
      }
      image.onerror = function () {
        URL.revokeObjectURL(objectUrl)
        reject(new Error('이미지를 읽지 못했습니다.'))
      }
      image.src = objectUrl
    })
  }

  async function decodeImage(file) {
    if (typeof global.createImageBitmap === 'function') {
      try {
        const bitmap = await global.createImageBitmap(file, {
          imageOrientation: 'from-image',
        })

        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          release: function () {
            bitmap.close()
          },
        }
      } catch (error) {
        // HEIC처럼 createImageBitmap이 지원하지 않는 형식은 이미지 요소로 다시 시도한다.
      }
    }

    return loadImageElement(file)
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(resolve, type, quality)
    })
  }

  function outputTypeFor(file) {
    if (file.type === 'image/png') return 'image/png'
    if (file.type === 'image/webp') return 'image/webp'
    return 'image/jpeg'
  }

  function outputNameFor(file, outputType) {
    if (outputType !== 'image/jpeg') return file.name

    const dotIndex = file.name.lastIndexOf('.')
    const baseName = dotIndex > 0 ? file.name.slice(0, dotIndex) : file.name
    return baseName + '.jpg'
  }

  /**
   * 사진의 긴 변을 제한하고, 더 작아진 경우에만 새 파일을 반환한다.
   *
   * @param {File} file 원본 사진
   * @param {{ maxEdge?: number, quality?: number }} [options] 리사이즈 설정
   * @returns {Promise<File>} 업로드할 사진
   */
  async function resizeImageFile(file, options) {
    if (!(file instanceof File) || !String(file.type || '').startsWith('image/')) return file

    const settings = options || {}
    const maxEdge = Number(settings.maxEdge) || DEFAULT_MAX_EDGE
    const quality = Number(settings.quality) || DEFAULT_QUALITY
    let decoded = null

    try {
      decoded = await decodeImage(file)

      const longestEdge = Math.max(decoded.width, decoded.height)
      if (!longestEdge || longestEdge <= maxEdge) return file

      const scale = maxEdge / longestEdge
      const width = Math.max(1, Math.round(decoded.width * scale))
      const height = Math.max(1, Math.round(decoded.height * scale))
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (!context) return file

      canvas.width = width
      canvas.height = height
      context.drawImage(decoded.source, 0, 0, width, height)

      const outputType = outputTypeFor(file)
      const resizedBlob = await canvasToBlob(canvas, outputType, quality)
      canvas.width = 0
      canvas.height = 0

      if (!resizedBlob || resizedBlob.size >= file.size) return file

      return new File([resizedBlob], outputNameFor(file, outputType), {
        type: outputType,
        lastModified: file.lastModified,
      })
    } catch (error) {
      console.warn('Dulkong image resize skipped', error)
      return file
    } finally {
      if (decoded) decoded.release()
    }
  }

  global.dulkongResizeImageFile = resizeImageFile
})(window)
