import { tracePixels } from './tracing.mjs';
self.onmessage = ({ data }) => {
  try {
    const pixels = tracePixels(data.pixels, data.width, data.height, data.darkness, data.lineWidth);
    self.postMessage({ pixels, width:data.width, height:data.height }, [pixels.buffer]);
  } catch (error) { self.postMessage({ error: error.message }); }
};
