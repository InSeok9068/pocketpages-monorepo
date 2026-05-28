;(function () {
  const MAX_NARROW_WIDTH = 320
  const MIN_SPLIT_HEIGHT = 1600
  const MIN_SPLIT_RATIO = 4.2
  const TARGET_SLICE_WIDTH = 864
  const SLICE_OVERLAP_RATIO = 0.12

  function stripFileExtension(fileName) {
    return String(fileName || '').replace(/\.[^.]+$/, '')
  }

  function padSliceNumber(value) {
    return String(value).padStart(2, '0')
  }

  function buildSourceToken(sourceIndex) {
    return 'ppsrc_' + padSliceNumber(Number(sourceIndex || 0) + 1)
  }

  function loadImageFromFile(file) {
    return new Promise(function (resolve, reject) {
      const image = new Image()
      const objectUrl = URL.createObjectURL(file)

      image.onload = function () {
        URL.revokeObjectURL(objectUrl)
        resolve(image)
      }

      image.onerror = function () {
        URL.revokeObjectURL(objectUrl)
        reject(new Error('이미지 크기를 읽지 못했습니다.'))
      }

      image.src = objectUrl
    })
  }

  function canvasToJpegBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(
        function (blob) {
          if (!blob) {
            reject(new Error('이미지 분할 결과를 만들지 못했습니다.'))
            return
          }

          resolve(blob)
        },
        'image/jpeg',
        0.94
      )
    })
  }

  function shouldSplitImage(image) {
    const width = Number(image.naturalWidth || image.width || 0)
    const height = Number(image.naturalHeight || image.height || 0)

    if (!width || !height) {
      return false
    }

    return width <= MAX_NARROW_WIDTH && height >= MIN_SPLIT_HEIGHT && height / width >= MIN_SPLIT_RATIO
  }

  function resolveSliceCount(height) {
    if (height >= 2200) {
      return 4
    }

    return 3
  }

  function buildSliceBounds(height, sliceCount) {
    const bounds = []
    const baseSliceHeight = Math.ceil(height / sliceCount)
    const overlapHeight = Math.round(baseSliceHeight * SLICE_OVERLAP_RATIO)

    for (let index = 0; index < sliceCount; index += 1) {
      const start = Math.max(0, index * baseSliceHeight - overlapHeight)
      const end = Math.min(height, (index + 1) * baseSliceHeight + (index < sliceCount - 1 ? overlapHeight : 0))

      bounds.push({
        top: start,
        height: Math.max(1, end - start),
      })
    }

    return bounds
  }

  async function splitTallCaptureFile(file, sourceIndex) {
    const image = await loadImageFromFile(file)

    if (!shouldSplitImage(image)) {
      return [file]
    }

    const sourceWidth = Number(image.naturalWidth || image.width || 0)
    const sourceHeight = Number(image.naturalHeight || image.height || 0)
    const sliceCount = resolveSliceCount(sourceHeight)
    const sliceBounds = buildSliceBounds(sourceHeight, sliceCount)
    const baseName = stripFileExtension(file.name)
    const sourceToken = buildSourceToken(sourceIndex)
    const splitFiles = []

    for (let index = 0; index < sliceBounds.length; index += 1) {
      const sliceBound = sliceBounds[index]
      const targetHeight = Math.max(1, Math.round((sliceBound.height * TARGET_SLICE_WIDTH) / sourceWidth))
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')

      canvas.width = TARGET_SLICE_WIDTH
      canvas.height = targetHeight

      if (!context) {
        throw new Error('이미지 분할 컨텍스트를 만들지 못했습니다.')
      }

      context.drawImage(image, 0, sliceBound.top, sourceWidth, sliceBound.height, 0, 0, TARGET_SLICE_WIDTH, targetHeight)

      const blob = await canvasToJpegBlob(canvas)
      const sliceFileName = baseName + '__' + sourceToken + '__ppslice_' + padSliceNumber(index + 1) + 'of' + padSliceNumber(sliceBounds.length) + '.jpg'

      splitFiles.push(
        new File([blob], sliceFileName, {
          type: 'image/jpeg',
          lastModified: file.lastModified,
        })
      )
    }

    return splitFiles
  }

  async function expandTallCaptureFiles(files) {
    const expandedFiles = []

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      const splitFiles = await splitTallCaptureFile(file, index)

      for (let splitIndex = 0; splitIndex < splitFiles.length; splitIndex += 1) {
        expandedFiles.push(splitFiles[splitIndex])
      }
    }

    return expandedFiles
  }

  window.photofolioUploadPreprocessor = {
    expandTallCaptureFiles: expandTallCaptureFiles,
  }
})()
