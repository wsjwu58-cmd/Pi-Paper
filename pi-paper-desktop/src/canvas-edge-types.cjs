// Shared by the local canvas store and portable template validation.
const EDGE_COMPATIBLE_TARGET_TYPES = Object.freeze({
  text: new Set(['text', 'image', 'video', 'audio', 'director']),
  image: new Set(['image', 'video', 'director']),
  video: new Set(['video', 'compose']),
  audio: new Set(['audio', 'video']),
  compose: new Set(['video', 'compose']),
  director: new Set(['image', 'video']),
})

module.exports = { EDGE_COMPATIBLE_TARGET_TYPES }
