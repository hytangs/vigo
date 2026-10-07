// CSS layout fixtures use Electron's software offscreen renderer. Waiting for
// paint gives us real pixels without depending on a desktop compositor in CI.
async function layoutFrame(window) {
  const contents = window.webContents
  if (!contents.isOffscreen()) throw new Error('Layout fixture must render offscreen')
  // A resize can update innerWidth before Chromium has applied every viewport
  // media query. Offscreen rendering supplies frames even without a desktop.
  await contents.executeJavaScript(`new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Layout frame did not settle')), 10000);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timeout); resolve();
    }));
  })`)
  const { width, height } = await contents.executeJavaScript(
    '({width: Math.round(innerWidth * devicePixelRatio), height: Math.round(innerHeight * devicePixelRatio)})',
  )
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      contents.removeListener('paint', painted)
    }
    const painted = (_event, _dirty, image) => {
      if (image.isEmpty()) return
      const size = image.getSize()
      if (size.width !== width || size.height !== height) return
      cleanup()
      resolve(image)
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Layout fixture produced no rendered frame within 10 seconds'))
    }, 10_000)
    contents.on('paint', painted)
    contents.invalidate()
  })
}

async function resizeLayout(window, width, height) {
  window.setContentSize(width, height)
  const deadline = Date.now() + 10_000
  while (true) {
    const size = await window.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})')
    if (size.width === width && size.height === height) return layoutFrame(window)
    if (Date.now() >= deadline) {
      throw new Error(`Layout viewport did not resize to ${width}x${height}; got ${size.width}x${size.height}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

module.exports = { layoutFrame, resizeLayout }
