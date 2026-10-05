const path = require('node:path')

/** Increase the artwork's visible size within the OS icon, retaining the original file. */
function applicationIcon(nativeImage, directory) {
  const image = nativeImage.createFromPath(path.join(directory, 'app-icon.png'))
  if (image.isEmpty()) return path.join(directory, 'app-icon.ico')
  const { width, height } = image.getSize()
  const insetX = Math.floor(width * 0.14)
  const insetY = Math.floor(height * 0.14)
  return image.crop({ x: insetX, y: insetY, width: width - 2 * insetX, height: height - 2 * insetY })
}
module.exports = { applicationIcon }
