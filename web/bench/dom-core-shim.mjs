// A direct host for the DOM and canvas benchmarks’ core modules. These trusted guests
// use synchronous imports, owned DOM references and UTF-8 strings.
import { getWindow, getPerformance } from "../host/web-host.js";

export async function instantiateDomGuest(corePath, importedPages) {
  const handles = [undefined];
  const free = [];
  let memory, realloc, view;
  let listCount = 0, listElements = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  function own(object) {
    const handle = free.pop() ?? handles.length;
    handles[handle] = object;
    return handle;
  }

  function drop(handle) {
    if (handles[handle] === undefined) throw Error("Guest dropped an unknown handle");
    handles[handle] = undefined;
    free.push(handle);
  }

  function string(ptr, len) {
    return decoder.decode(new Uint8Array(memory.buffer, ptr >>> 0, len >>> 0));
  }

  function dataView() {
    if (view?.buffer !== memory.buffer) view = new DataView(memory.buffer);
    return view;
  }

  function option(object, out) {
    const dv = dataView();
    dv.setUint8(out >>> 0, Number(object != null));
    if (object != null) dv.setUint32((out >>> 0) + 4, own(object), true);
  }

  function append(parent, child) {
    return own(handles[parent].appendChild(handles[child]));
  }

  const root = {
    "get-window": () => own(getWindow()),
    "get-performance": () => own(getPerformance()),
    "[method]window.get-document": h => own(handles[h].getDocument()),
    "[method]document.get-body": (h, out) => option(handles[h].getBody(), out),
    "[method]document.create-element": (h, ptr, len) => own(handles[h].createElement(string(ptr, len))),
    "[method]document.get-element-by-id": (h, ptr, len, out) =>
      option(handles[h].getElementById(string(ptr, len)), out),
    "[method]document.get-elements-by-class-name-list": (h, ptr, len, out) => {
      const elements = handles[h].getElementsByClassNameList(string(ptr, len));
      const base = realloc(0, 0, 4, elements.length * 4) >>> 0;
      const dv = dataView();
      for (let i = 0; i < elements.length; i++) dv.setUint32(base + i * 4, own(elements[i]), true);
      dv.setUint32(out >>> 0, base, true);
      dv.setUint32((out >>> 0) + 4, elements.length, true);
      listCount++;
      listElements += elements.length;
    },
    "[method]element.append-child": append,
    "[method]html-element.append-child": append,
    "[method]element.set-attribute": (h, p, n, q, m) => handles[h].setAttribute(string(p, n), string(q, m)),
    "[method]element.set-text-content": (h, ptr, len) => handles[h].setTextContent(string(ptr, len)),
    "[method]element.get-context2d": h => own(handles[h].getContext2d()),
    "[method]canvas-rendering-context2d.set-fill-style": (h, p, n) => handles[h].setFillStyle(string(p, n)),
    "[method]canvas-rendering-context2d.fill-rect": (h, x, y, w, height) => handles[h].fillRect(x, y, w, height),
    "[method]canvas-rendering-context2d.get-image-data-array-buffer": (h, x, y, w, height, out) => {
      const bytes = handles[h].getImageDataArrayBuffer(x, y, w, height);
      const ptr = realloc(0, 0, 1, bytes.byteLength) >>> 0;
      new Uint8Array(memory.buffer, ptr, bytes.byteLength).set(bytes);
      const dv = dataView();
      dv.setUint32(out >>> 0, ptr, true);
      dv.setUint32((out >>> 0) + 4, bytes.byteLength, true);
    },
    "[method]canvas-rendering-context2d.put-image-data-array-buffer": (h, ptr, len, x, y, w, height) => {
      const start = ptr >>> 0;
      const snapshot = new Uint8Array(memory.buffer.slice(start, start + (len >>> 0)));
      handles[h].putImageDataArrayBuffer(snapshot, x, y, w, height);
    },
    "[method]element.get-first-child": (h, out) => option(handles[h].getFirstChild(), out),
    "[method]element.get-next-sibling": (h, out) => option(handles[h].getNextSibling(), out),
    "[method]element.remove": h => handles[h].remove(),
    "[method]performance.mark": (h, p, n) => own(handles[h].mark(string(p, n))),
    "[method]performance.measure": (h, p, n, q, m, r, k) =>
      own(handles[h].measure(string(p, n), string(q, m), string(r, k))),
    "[method]performance-measure.get-duration": h => handles[h].getDuration(),
  };
  for (const resource of ["document", "element", "html-element", "window", "performance",
                          "performance-mark", "performance-measure", "canvas-rendering-context2d"]) {
    root["[resource-drop]" + resource] = drop;
  }

  const imports = { $root: root };
  if (importedPages !== undefined) {
    memory = new WebAssembly.Memory({ initial: importedPages });
    imports.env = { memory };
  }
  const { instance } = await WebAssembly.instantiateStreaming(fetch(corePath), imports);
  memory ??= instance.exports.memory;
  realloc = instance.exports.cabi_realloc;
  instance.exports._initialize?.();
  return {
    run: instance.exports.run,
    counts() {
      return { liveHandles: handles.length - 1 - free.length, listCount, listElements };
    },
  };
}
