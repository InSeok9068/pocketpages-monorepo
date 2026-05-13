const { presetIcons } = require('@unocss/preset-icons')
const { presetWind3 } = require('@unocss/preset-wind3')

module.exports = {
  presets: [presetWind3(), presetIcons()],
}
