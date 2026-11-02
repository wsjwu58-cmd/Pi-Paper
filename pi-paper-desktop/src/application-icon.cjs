const path = require('node:path')

function applicationIcon(nativeImage, directory) {
  // The macOS artwork already includes its Dock margins and rounded mask.
  if (process.platform === 'darwin') return path.join(directory, 'app-icon.mac.png')
  // Load the same multi-size ICO as the executable/shortcut. Cropped PNGs can
  // retain a bitmap stride that Windows' native icon conversion misinterprets.
  if (process.platform === 'win32') return path.join(directory, 'app-icon.ico')
  const image = nativeImage.createFromPath(path.join(directory, 'app-icon.png'))
  if (image.isEmpty()) return path.join(directory, 'app-icon.ico')
  const { width, height } = image.getSize()
  const insetX = Math.floor(width * 0.14)
  const insetY = Math.floor(height * 0.14)
  return image.crop({ x: insetX, y: insetY, width: width - 2 * insetX, height: height - 2 * insetY })
}
module.exports = { applicationIcon }
