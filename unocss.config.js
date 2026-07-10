const { presetIcons } = require('@unocss/preset-icons')
const { presetWind4 } = require('@unocss/preset-wind4')

module.exports = {
  presets: [
    presetWind4({
      preflights: {
        reset: false,
      },
    }),
    presetIcons(),
  ],
}
