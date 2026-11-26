// Both host adapters exchange an owned byte list with the guest. The view
// adapter can reuse the browser's readback and the binding's write snapshot.
export function installPixelViews() {
  const proto = CanvasRenderingContext2D.prototype;
  proto.getImageDataArrayBuffer = function (x, y, width, height) {
    const { data } = this.getImageData(x, y, width, height);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  };
  proto.putImageDataArrayBuffer = function (bytes, x, y, width, height) {
    const data = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.putImageData(new ImageData(data, width, height), x, y);
  };
}

// The guest draws different checkerboards and copies a square between them.
// Check every channel on both canvases after the timer, including the border.
export function checkCanvasPixels(size) {
  const canvases = document.querySelectorAll("canvas");
  if (canvases.length !== 2) throw Error("Expected a source and a destination canvas");
  const sourceColors = [[244, 164, 96, 255], [70, 130, 180, 255]];
  const destColors = [[205, 92, 92, 255], [72, 209, 204, 255]];
  for (const [index, canvas] of canvases.entries()) {
    if (canvas.width !== size || canvas.height !== size) throw Error("Unexpected canvas size");
    const pixels = canvas.getContext("2d").getImageData(0, 0, size, size).data;
    for (let y = 0; y < size; ++y) {
      for (let x = 0; x < size; ++x) {
        const copied = x >= 40 && x < size - 40 && y >= 40 && y < size - 40;
        const source = index === 0 || copied;
        const tile = source ? 32 : 16;
        const color = (source ? sourceColors : destColors)[(Math.floor(x / tile) + Math.floor(y / tile)) % 2];
        const offset = (y * size + x) * 4;
        for (let c = 0; c < 4; c++) {
          if (pixels[offset + c] !== color[c]) throw Error(`Bad RGBA at canvas ${index} pixel (${x}, ${y})`);
        }
      }
    }
  }
  return canvases.length * size * size;
}
