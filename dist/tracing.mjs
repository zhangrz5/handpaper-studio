// Outline conversion keeps the original pixels' positions, including all lettering.
export function tracePixels(rgba, width, height, darkness = 24, lineWidth = 1) {
  const size = width * height;
  const gray = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const p = i * 4, a = rgba[p + 3] / 255;
    gray[i] = (rgba[p] * .299 + rgba[p + 1] * .587 + rgba[p + 2] * .114) * a + 255 * (1 - a);
  }
  const blur = new Float32Array(size);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const p = y * width + x;
    blur[p] = (gray[p-width-1]+2*gray[p-width]+gray[p-width+1]+2*gray[p-1]+4*gray[p]+2*gray[p+1]+gray[p+width-1]+2*gray[p+width]+gray[p+width+1])/16;
  }
  for (let x = 0; x < width; x++) { blur[x]=gray[x]; blur[(height-1)*width+x]=gray[(height-1)*width+x]; }
  for (let y = 0; y < height; y++) { blur[y*width]=gray[y*width]; blur[y*width+width-1]=gray[y*width+width-1]; }
  const strength = new Float32Array(size), direction = new Int32Array(size);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const p = y * width + x;
    const gx = -blur[p-width-1]+blur[p-width+1]-2*blur[p-1]+2*blur[p+1]-blur[p+width-1]+blur[p+width+1];
    const gy = -blur[p-width-1]-2*blur[p-width]-blur[p-width+1]+blur[p+width-1]+2*blur[p+width]+blur[p+width+1];
    strength[p] = Math.hypot(gx,gy);
    const ax=Math.abs(gx),ay=Math.abs(gy);
    const offset=ay<=ax*.4142?1:ay>=ax*2.4142?width:gx*gy>=0?width+1:1-width;
    direction[p]=offset*((ay>=ax*2.4142?gy:gx)<0?-1:1);
  }
  // Retain the gradient ridge only: a tracing guide needs a thin contour, not a band.
  const edges = new Float32Array(size);
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++) {
    const p=y*width+x,s=strength[p],offset=direction[p];
    if(s>24&&s>=strength[p-offset]&&s>strength[p+offset])edges[p]=Math.min(1,(s-24)/150);
  }
  // Five narrow settings: 1.0–1.8 source pixels, with soft coverage at the sides.
  const level=Math.max(1,Math.min(5,Math.round(Number(lineWidth)||1)));
  const sideCoverage=(level-1)*.1;
  const output = new Uint8ClampedArray(size * 4);
  output.fill(255);
  const opacity = Math.max(10,Math.min(50,Number(darkness)||24))/100;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const p=y*width+x;
    let ink=edges[p];
    if(sideCoverage) {
      const neighbor=Math.max(x?edges[p-1]:0,x<width-1?edges[p+1]:0,y?edges[p-width]:0,y<height-1?edges[p+width]:0);
      ink=Math.max(ink,neighbor*sideCoverage);
    }
    const v=Math.round(255-255*opacity*ink);
    output[p*4]=output[p*4+1]=output[p*4+2]=v;
  }
  return output;
}
