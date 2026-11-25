// Install the demo's actual host adapter before wrapping its method. The
// generated modules can capture the method during their own initialization.
import "/host/web-host.js";

export function observeReadback(canvasSize) {
  const prototype = CanvasRenderingContext2D.prototype;
  const read = prototype.getImageDataArrayBuffer;
  const expectedBytes = (canvasSize - 2 * 40) ** 2 * 4;
  let calls = [];
  prototype.getImageDataArrayBuffer = function (x, y, width, height) {
    const start = performance.now();
    const result = read.call(this, x, y, width, height);
    const end = performance.now();
    if (result.byteLength !== expectedBytes) throw Error("Unexpected pixel payload size");
    calls.push({ start, end });
    return result;
  };

  return {
    finish(reportedSeconds) {
      const reps = (calls.length + 1) / 2;
      if (!Number.isInteger(reps) || reps < 1 || (reps & (reps - 1))) {
        throw Error("Unexpected readback autoranging sequence");
      }
      // Each of the three guests doubles repetitions until a timed pass
      // reaches its threshold. All read passes precede the write passes.
      const finalRead = performance.getEntriesByName("measure", "measure")[Math.log2(reps)];
      const last = calls.slice(-reps);
      if (!finalRead || last[0].start < finalRead.startTime ||
          last.at(-1).end > finalRead.startTime + finalRead.duration + 1e-6) {
        throw Error("Host samples fall outside the guest's final read measurement");
      }
      const totalUs = finalRead.duration * 1000 / reps;
      if (Math.abs(totalUs - reportedSeconds * 1e6) > 0.11) {
        throw Error("Host observer disagrees with the guest's result table");
      }
      const hostUs = last.reduce((sum, call) => sum + call.end - call.start, 0) * 1000 / reps;
      calls = [];
      return { reps, bytes: expectedBytes, totalUs, hostUs, remainderUs: totalUs - hostUs };
    },
  };
}
