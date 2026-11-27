# Component demos

This fork measures browser bindings for the same C, C++, and Rust WebAssembly components from [eqrion/component-demos](https://github.com/eqrion/component-demos/tree/d0b9dd1390a300978193adc623838fef4e4b632b). The controls are the demos’ compiled shims, Jco 1.13.0, and upstream main at `326f52ab4`. The review branch uses the checked TypeScript runtime through both internal Oxc bundling and the external `jco-cm-runtime` package. [Jco performance PR](https://github.com/vados-cosmonic/jco/pull/62)

## Browser performance on the Jco review branch

Both modes met the **10× target on all 21 warm headline workloads** on the published PR at `fe136cf1a`. Across guest languages, tree traversal ran 8.4–9.2× faster than main internally and 7.8–7.9× faster externally. For table creation the gains were 4.9–5.5× and 4.5–5.5×, respectively. The primary measurement used 12 balanced Chromium rounds and 1,668 fresh documents. A second matrix used byte-identical PR assets. [Per-workload results and repeat](docs/browser-performance.md) · [DOM and canvas controls](docs/dom-performance.md)

| Primary matrix | Internal Oxc | External runtime |
| --- | ---: | ---: |
| Warm workloads faster than upstream main | 21/21 | 21/21 |
| Largest warm time relative to fastest compiled shim | 4.93× | 4.98× |
| Warm medians at or below Jco 1.13.0 | 16/21 | 13/21 |
| First-result medians at or below Jco 1.13.0 | 9/21 | 5/21 |

Across all 84 original warm phases, 81 met the 10× target. In the other three phases, the fastest shim discarded a live DOM collection. When it also materialized and dropped the 2,000 handles returned by the component, both Jco modes took 1.46–1.64× the shim time. [Equal-work measurements](docs/runtime-packaging.md#loading-synchronous-task-operations-in-the-browser)

![Warm time against the fastest compiled shim and first-result time against Jco 1.13.0, across all four Jco builds.](web/bench/results/builds-overview-3e25d8d82.png)

## Host calls and resources

A synchronous leaf can reuse its active guest task and skip a subtask allocation on each host crossing. Detached host imports and calls during initialization still acquire a task when needed. The following medians come from controlled loops inside the guest, in nanoseconds per operation. [Binding measurements](docs/bindings.md) · [Resource lifetime and shutdown](docs/resources.md) · [PR-base controls](docs/revision-comparisons.md#pr-head-against-upstream-main)

| Guest loop | Jco 1.13.0 | PR base | Internal Oxc | External runtime |
| --- | ---: | ---: | ---: | ---: |
| Scalar host call | 16.8 | 2,378.8 | 21.4 | 24.4 |
| Acquire, borrow, and drop a resource | 329.6 | 5,218.5 | 152.6 | 148.0 |

## Module size and cold startup

These are medians across the 21 workloads. JavaScript sizes include the generated binding and all runtime modules it fetches. Guest Wasm and per-file Brotli measurements are in the size breakdown. [Module size](docs/module-size.md) · [Cold-start and instantiation breakdown](docs/cold-start.md)

| Median | Jco 1.13.0 | Upstream main | Internal Oxc | External runtime |
| --- | ---: | ---: | ---: | ---: |
| Import and initialization (ms) | 5.19 | 11.94 | 9.47 | 18.38 |
| First completed result (ms) | 63.33 | 207.45 | 62.06 | 76.78 |
| Complete JS, raw (KiB) | 9.58 | 111.34 | 69.75 | 106.75 |
| Complete JS, gzip (KiB) | 3.01 | 25.42 | 18.57 | 34.67 |
| JS requests | 1 | 1 | 1 | 15 |

Cold startup is the remaining gap. Import was measurably slower than 1.13.0 in both runs on 20/21 internal and 21/21 external workloads. Even with all cores compiled and the bindings imported, the first table instance took about 1.0 ms on release, 4.6–4.8 ms internally and 5.2–5.3 ms externally. Splitting seven synchronous task operations out of the external async driver saved 4,212 Brotli bytes and reduced paired import time by 6.7% against the preceding external build. [Runtime packaging](docs/runtime-packaging.md) · [HTTP, caching and application bundling](docs/browser-delivery.md)

A deployment experiment measured time from navigation to the first C table result. Preload links in the HTML response reduced paired time by 14.6% internally and 8.5% externally. With the same hints applied to release, external Jco still took 21.2% longer. [Cold-navigation measurements](docs/cold-start.md#preloading-the-bindings-from-the-navigation-response)

## Review and remaining work

The integration PR contains the full compiler changes. Review begins with the shared task and resource operations on the pinned upstream main, followed by the separate package split on its integrated prerequisite. The runtime slice passed 509 checked tests, its packed-package consumer test and embedded snapshot verification. [Runtime operations PR](https://github.com/vados-cosmonic/jco/pull/63) · [Packaging PR](https://github.com/vados-cosmonic/jco/pull/64)

The lock-release follow-up at local revision `81c0d5d61` fixes duplicate callbacks when a waiter reenters the component. In the isolated Chromium probe the empty lock cycle fell from 36.39 to 19.54 ns and the 32-callback cycle from 1,464.84 to 673.22 ns. The one-callback interval included parity. Full-suite FIFO validation, separate upstream review of the changes, and cold-start parity with 1.13.0 are outstanding at this checkpoint. [Callback measurements and checks](docs/lock-release.md) · [Review history](docs/revision-comparisons.md)

## Reproduce the comparison

Run benchmark commands from the repository root. The original guests and build scripts are under `c/`, `cpp/`, and `rust/`. To open the interactive demos, install the web dependencies with `npm ci --prefix web` and run `npm run --prefix web dev`. [Build and benchmark instructions](docs/reproduce.md) · [Original release and main comparison](docs/baseline-study.md) · [Original candidate, controls and reproduction](docs/candidate-study.md)
