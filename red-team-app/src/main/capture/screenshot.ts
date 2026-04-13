import { desktopCapturer, screen, nativeImage } from 'electron';

export async function captureScreenshot(): Promise<Buffer> {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const scaleFactor = primaryDisplay.scaleFactor;

  // Use 1x resolution — retina 2x is too large for OCR and slows Tesseract significantly
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
  });

  if (sources.length === 0) {
    throw new Error('No screen sources available');
  }

  // Use the primary display source
  const source = sources[0];
  const thumbnail = source.thumbnail;

  // Resize to max 1280px wide to keep payload under Electron's HTTP/2 body limit
  const imgSize = thumbnail.getSize();
  let finalImg = thumbnail;
  if (imgSize.width > 1280) {
    const ratio = 1280 / imgSize.width;
    finalImg = thumbnail.resize({
      width: Math.round(imgSize.width * ratio),
      height: Math.round(imgSize.height * ratio),
    });
  }

  // Use JPEG — much smaller than PNG for screenshots (~70-90% reduction)
  const jpegBuffer = finalImg.toJPEG(80);

  console.log(`[screenshot] Captured ${jpegBuffer.length} bytes JPEG (${finalImg.getSize().width}x${finalImg.getSize().height}, original ${width}x${height} @${scaleFactor}x)`);
  return jpegBuffer;
}
