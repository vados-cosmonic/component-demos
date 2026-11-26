# Component demos

This fork benchmarks the browser examples from [eqrion/component-demos at d0b9dd1](https://github.com/eqrion/component-demos/tree/d0b9dd1390a300978193adc623838fef4e4b632b). It runs the same compiled C, C++, and Rust WebAssembly components through jco 1.13.0, pinned upstream main, and a branch that optimizes synchronous host imports. The comparison also includes the demos’ JavaScript, Emscripten (Embind and EM_JS), and Rust wasm-bindgen implementations where available.

## Bundled and external runtime on the review branch

The review branch uses the same checked operations for synchronous calls in both renderers. This run compares them directly against a custom provider using the original API-v1 contract. All three used the same runtime source and the same two Wasm core binaries. The external modes differ only in whether the provider opts into the synchronous operations. [Jco PR #62](https://github.com/vados-cosmonic/jco/pull/62) · [Measured Jco revision](https://github.com/vados-cosmonic/jco/commit/275c3071a3760180de923cda62388fc08d34f7cf)

| Warm operation, ns per guest iteration | Bundled | External | External API-v1 compatibility |
| --- | ---: | ---: | ---: |
| Scalar host call | 42.7 | 54.9 | 6,485.0 |
| Acquire, borrow and drop a resource | 337.2 | 437.9 | 13,841.2 |
| Return a 16-byte ASCII string | 1,376.3 | 1,327.5 | 10,458.4 |

Each entry is the median of seven Chromium 156 page medians. Each page ran two warmups and five timed passes of 65,536 iterations per operation and mode, rotating execution order and checking every result. Compare columns within this run. The full demo matrix below used a separate run and workload. [Runner](web/bench/provider-loop.mjs) · [Raw samples and core hashes](web/bench/results/provider-loop.json)

To reproduce, build the review checkout with `cargo build -p js-component-bindgen --example transpile --features embedded-cm-runtime` and build its runtime with `pnpm --filter @bytecodealliance/jco-cm-runtime build`. From this benchmark checkout, after `npm ci --prefix web`, run the following with `wasm-tools` on the path.

```sh
CHROME_BIN=/path/to/chrome node web/bench/provider-loop.mjs /path/to/jco \
  /path/to/jco/target/debug/examples/transpile /tmp/provider-loop.json
```

### Loading one component and then a second

On the review branch, the first component fetched a median of 23 JavaScript files with the checked external provider. Packing the runtime exports used by these demos into one shared ES module cut that to two files. The median time to the first guest result fell from **50.36 ms to 23.28 ms**, alongside **23.13 ms** for the internal Oxc bundle and **11.26 ms** for Jco 1.13.0. With the shared module already loaded, the second component returned its first result in **15.42 ms**, compared with **21.24 ms** for the internal bundle and **10.45 ms** for 1.13.0. [Measured Jco revision](https://github.com/vados-cosmonic/jco/commit/dc366893262deb4605c5ca7fb35da3f1fe587357)

![Time to first guest result and JavaScript bytes for the first and second components in a document](web/bench/results/provider-startup.png)

| Build | Component | Import (ms) | First result (ms) | JS requests | JS (KiB) | JS gzip (KiB) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Jco 1.13.0 | First | 7.45 | 11.26 | 1 | 21.2 | 3.4 |
| Jco 1.13.0 | Second | 7.39 | 10.45 | 1 | 21.2 | 3.4 |
| PR bundled | First | 15.34 | 23.13 | 1 | 126.4 | 23.6 |
| PR bundled | Second | 14.29 | 21.24 | 1 | 126.4 | 23.6 |
| PR external | First | 41.59 | 50.36 | 23 | 193.2 | 50.8 |
| PR external | Second | 9.73 | 15.93 | 1 | 67.1 | 8.4 |
| PR external, packed provider | First | 15.67 | 23.28 | 2 | 115.5 | 23.4 |
| PR external, packed provider | Second | 9.40 | 15.42 | 1 | 67.1 | 8.4 |

The packed configuration is an application build experiment. Rolldown bundles the named exports that the 15 generated entries import from the checked runtime. A browser import map directs those specifiers to the same file. The generated external bindings and guest Wasm are byte-identical with either provider layout. In all 15 workload and guest pairs, the packed provider returned the first result sooner than the ordinary external package. For the second component, it also beat the internal bundle in all 15 pairs. Every per-case 95% sign-test interval favored packing in those two comparisons. [Shared provider build](web/bench/shared-provider.mjs)

Twelve rounds used 720 fresh Chromium 156 documents with DevTools disconnected. Each document loaded the common host, then imported and ran the same compiled guest twice under distinct entry and Wasm URLs. Both imports transferred their own generated files. The second reused the external runtime by URL. The runner checked all transfer sizes and guest reports and balanced the four build orders within each workload and language. Guests used small fixed workloads for attribute writes, canvas draws, DOM queries, tree traversal and table creation. Each table cell is the median of 15 workload and guest medians. The server served uncompressed responses over loopback. The gzip column sums each requested JS file compressed separately at level 9. [Browser runner](web/bench/provider-startup.mjs) · [Raw samples and asset hashes (gzip)](web/bench/results/provider-startup.json.gz)

To repeat this comparison, use the review checkout and native generator from the preceding commands. Generate the 1.13.0 baseline files using the size comparison setup below. The report can also regenerate the chart with Matplotlib and `--plot web/bench/results/provider-startup.png`.

```sh
CHROME_BIN=/path/to/chrome node web/bench/provider-startup.mjs /path/to/jco \
  /path/to/jco/target/debug/examples/transpile web/bench/results/provider-startup.json.gz
python3 web/bench/provider-startup-report.py
```

<!-- candidate:start -->

## Optimized browser bindings

The branch uses js-component-bindgen’s internal Oxc bundler and the checked jco-cm-runtime. [Measured Jco commit `900def079`](https://github.com/vados-cosmonic/jco/commit/900def079675eaa44479b686670ff6f3c5749093) · [Canvas host comparison](#canvas-pixel-transfers-with-the-same-guest-binary) · [Payload and startup](#payload-and-startup) · [First guest result](#time-to-the-first-guest-result) · [Wasm startup timing](#where-startup-time-goes) · [Startup by revision](#startup-against-the-previous-branch) · [Eager compilation](#eager-javascript-compilation) · [Reproduction commands](#reproduce-the-candidate-run)

All Jco builds used the same guest binaries. Each value is the median of 7 fresh-page samples with one warm-up per page. The run collected 728 samples on 2026-11-26 with HeadlessChrome/156.0.8078.47 on Intel(R) Xeon(R) Processor @ 2.60GHz.

Stock main is pinned to `fdbf1ae2d`. [Upstream source](https://github.com/bytecodealliance/jco/commit/fdbf1ae2dbc9469b5c275b5686d8a4c43681618f) · [Transpiler CI build](https://github.com/bytecodealliance/jco/actions/runs/45736422241)

The candidate finished within **10× of the fastest available compiled shim in 21/21** headline comparisons. The largest ratio was **4.72×**. On separate fresh pages it matched or beat **1.13.0 in 15/21** and **stock main in 21/21**. On the same warmed page it matched or beat **1.13.0 in 20/21** headline cases and 82/84 across all phases. The shim comparison selects the lowest median among Embind, EM_JS and wasm-bindgen for each operation, including shims written in a different guest language. The phase tables in the original comparison describe workload differences and include raw JavaScript.

On a fresh page with DevTools disconnected, median time from import to the first full workload result was **81.29 ms** on the branch, **74.43 ms** on 1.13.0 and **272.18 ms** on stock main. The branch reached the first result at or before 1.13.0 in 7/21 paired cases. [Startup measurements](#time-to-the-first-guest-result)

![Candidate runtime relative to the two targets by operation and language](web/bench/results/candidate-runtime.png)

| Operation | Guest | Unit | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Fastest shim | Shim time | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | µs | 1.54 | 4.95 | 0.77 | 0.50× | Embind | 1.33 | 0.58× |
| Attribute write | C++ | µs | 1.24 | 4.38 | 0.63 | 0.51× | Embind | 1.33 | 0.48× |
| Attribute write | Rust | µs | 1.32 | 3.98 | 0.86 | 0.65× | Embind | 1.33 | 0.65× |
| Canvas fillRect | C | µs | 1.09 | 4.29 | 1.09 | 1.00× | Embind | 1.80 | 0.61× |
| Canvas fillRect | C++ | µs | 1.29 | 4.14 | 1.10 | 0.85× | Embind | 1.80 | 0.61× |
| Canvas fillRect | Rust | µs | 0.99 | 3.84 | 0.91 | 0.92× | Embind | 1.80 | 0.50× |
| Canvas pixel read | C | µs | 347.50 | 363.70 | 353.60 | 1.02× | Embind | 224.00 | 1.58× |
| Canvas pixel read | C++ | µs | 317.10 | 368.30 | 323.80 | 1.02× | Embind | 224.00 | 1.45× |
| Canvas pixel read | Rust | µs | 355.80 | 370.20 | 365.30 | 1.03× | Embind | 224.00 | 1.63× |
| DOM ID lookup | C | µs | 1.36 | 6.06 | 0.87 | 0.64× | Embind | 1.45 | 0.60× |
| DOM ID lookup | C++ | µs | 1.30 | 5.32 | 1.16 | 0.89× | Embind | 1.45 | 0.80× |
| DOM ID lookup | Rust | µs | 1.27 | 5.45 | 1.02 | 0.80× | Embind | 1.45 | 0.70× |
| Tree traversal | C | ms | 15.16 | 114.53 | 15.95 | 1.05× | EM_JS | 4.22 | 3.78× |
| Tree traversal | C++ | ms | 13.94 | 101.42 | 13.50 | 0.97× | EM_JS | 4.22 | 3.20× |
| Tree traversal | Rust | ms | 18.09 | 125.85 | 19.93 | 1.10× | EM_JS | 4.22 | 4.72× |
| Read 1 KiB string | C | µs | 4.73 | 7.69 | 2.14 | 0.45× | wasm-bindgen | 5.79 | 0.37× |
| Read 1 KiB string | C++ | µs | 5.17 | 7.92 | 2.07 | 0.40× | wasm-bindgen | 5.79 | 0.36× |
| Read 1 KiB string | Rust | µs | 4.89 | 7.27 | 2.12 | 0.43× | wasm-bindgen | 5.79 | 0.37× |
| Table creation | C | ms | 14.46 | 71.05 | 13.92 | 0.96× | EM_JS | 5.79 | 2.41× |
| Table creation | C++ | ms | 15.97 | 75.37 | 13.22 | 0.83× | EM_JS | 5.79 | 2.29× |
| Table creation | Rust | ms | 15.73 | 68.00 | 14.65 | 0.93× | EM_JS | 5.79 | 2.53× |

Comparing implementations in the same language, the branch stayed within 10× in **13/13** available headline comparisons. Each cell divides the branch’s median by that shim’s median. A dash means the demo has no implementation for that binding. The demos supply compiled shims for C++ and Rust.

| Operation | C++ / Embind | C++ / EM_JS | Rust / wasm-bindgen |
| --- | --- | --- | --- |
| Attribute write | 0.48× | — | — |
| Canvas fillRect | 0.61× | — | — |
| Canvas pixel read | 1.45× | — | — |
| DOM ID lookup | 0.80× | — | — |
| Tree traversal | 0.54× | 3.20× | 2.72× |
| Read 1 KiB string | 0.17× | 0.20× | 0.37× |
| Table creation | 0.87× | 2.29× | 1.38× |

<details><summary>How the synchronous bindings work</summary>

Eligible single-instance, synchronous components reuse the caller’s task for host imports. The adapter keeps direct references to its task stack and instance flags and checks for store interruptions. Oxc removes the asynchronous import fallback and the subtask, waitable, and future constructors. The shutdown path skips creating the two empty stream and future tables. The generator skips asynchronous wrappers for synchronous allocators and post-return hooks. Standalone modules also omit suspension markers on core imports.

In checked standalone bindings, the Oxc linker can put a runtime initializer’s value directly where the module first declares its state. Each declaration still allocates its own maps, arrays or objects in the original order. Calls with arguments, calls inside functions and factories with more complex bodies keep their original implementation.

During a guest allocation, the checked runtime clears the instance’s may-leave flag and restores it on return or throw. Allocators in components with context-slot operations use the general guard to supply fresh slots for each call. The adapter lifts short ASCII strings four bytes at a time. Synchronous UTF-8 results of 256 to 262,144 code units can reuse a per-instance byte buffer capped at 256 KiB. The runtime encodes there before requesting the exact guest allocation. Nested calls and larger results use the ordinary encoder.

Resource drops check the instance flag and record traps. When lifting a borrowed host resource, the adapter validates the handle and reads its 32-bit representation directly. Imported host resources with automatically assigned representations use their guest handle as an array index. Explicit host representations and shared tables use a representation map. Components with async operations, cross-component resource transfers or call tracking use the general adapter.

Earlier runs measured how the linker handles runtime dependencies and initializes module state. [Subtask constructors](https://github.com/vados-cosmonic/component-demos/blob/255eca61b14b5ab63567da558b5f561149cc5163/README.md#change-from-the-previous-branch-revision) · [Future and waitable constructors](https://github.com/vados-cosmonic/component-demos/blob/c25f90d93af43e9261dff31b186d5b01115e8a0f/README.md#change-from-the-previous-branch-revision) · [Direct module initialization](https://github.com/vados-cosmonic/component-demos/blob/bd6eb358c6c106711f5e75022a1498d1051f8989/README.md#direct-module-initialization) · [Runtime namespace](https://github.com/vados-cosmonic/component-demos/blob/53a0057e71d25b91dcb0f9c475762140765078c8/README.md#shorter-private-runtime-names)

</details>

### Change from the previous branch revision

Both revisions ran on the same guest binaries in the same browser session. Each cell divides the candidate median by the previous revision’s median. Parentheses count the rounds in which the candidate finished faster. [Compare `5c6ddda44` and `900def079`](https://github.com/vados-cosmonic/jco/compare/5c6ddda44bce1730a61a69f2d48db94e3065ca31...900def079675eaa44479b686670ff6f3c5749093)

External core Wasm files matched byte for byte for 32/32 inputs that emitted them. Across the 21 timed guest and workload combinations, the median ratio of candidate to previous startup time was 0.98×.

| Payload | Smallest saving (bytes) | Median saving (bytes) | Largest saving (bytes) | Smaller outputs |
| --- | --- | --- | --- | --- |
| JavaScript | 5,029 | 5,044 | 5,044 | 34/34 |
| Total gzip | 365 | 386 | 399 | 34/34 |
| Total Brotli | 233 | 304 | 359 | 34/34 |

Both branch revisions also ran with their default output and caching disabled. The change column takes the difference for each guest and workload first, then the median of those differences.

| Startup interval | Previous (ms) | Candidate (ms) | Median change (ms) | Faster workloads |
| --- | --- | --- | --- | --- |
| Import to ready | 21.12 | 20.61 | -0.53 | 16/21 |
| Import to JS response end | 2.52 | 2.47 | -0.02 | 12/21 |
| JS end to first Wasm request | 12.35 | 11.62 | -0.36 | 13/21 |
| First Wasm request to last Wasm response | 2.48 | 2.34 | -0.08 | 13/21 |
| Last Wasm response to ready | 4.30 | 4.11 | -0.14 | 14/21 |

| Operation | C | C++ | Rust |
| --- | --- | --- | --- |
| Attribute write | 1.26× (3/7) | 0.83× (7/7) | 1.12× (3/7) |
| Canvas fillRect | 0.90× (4/7) | 1.03× (3/7) | 0.97× (5/7) |
| Canvas pixel read | 1.05× (4/7) | 0.87× (4/7) | 1.04× (4/7) |
| DOM ID lookup | 0.79× (5/7) | 0.94× (4/7) | 1.05× (2/7) |
| Tree traversal | 0.93× (5/7) | 0.78× (5/7) | 1.12× (1/7) |
| Read 1 KiB string | 0.96× (4/7) | 0.95× (4/7) | 1.01× (4/7) |
| Table creation | 0.91× (3/7) | 1.02× (4/7) | 1.00× (3/7) |
| Bulk DOM query | 0.95× (4/7) | 0.89× (5/7) | 0.96× (3/7) |
| Tree construction | 0.95× (4/7) | 0.78× (5/7) | 1.02× (1/7) |
| set 8 B | 1.04× (5/7) | 0.94× (3/7) | 0.96× (3/7) |
| get 8 B | 1.07× (3/7) | 1.11× (3/7) | 1.06× (3/7) |
| get 128 B | 0.98× (5/7) | 0.91× (5/7) | 0.95× (5/7) |
| get 16384 B | 0.96× (4/7) | 0.95× (3/7) | 1.00× (3/7) |
| get 262144 B | 1.00× (4/7) | 0.98× (3/7) | 1.02× (2/7) |

### Warm 1.13.0 comparison on the same page

For each guest and workload, both builds run once to warm up, then 4 times each on the same page. Each pair alternates which build runs first. The runner clears the DOM and performance entries before every call. It repeats this on 9 fresh pages. Each page contributes the median of its candidate / 1.13.0 ratios. The median across pages was at or below 1× for **20/21** headline cases. [Raw paired timings](web/bench/results/paired-browser.json)

![Median paired time ratios by workload and guest, with bars spanning the middle half of page ratios](web/bench/results/paired-runtime.png)

The middle 50% describes variation between pages. The median interval uses a two-sided sign test over independent page medians at the 95% level for each phase individually. Measurements on this CPU and browser can share machine load across pages.

| Operation | Guest | Candidate / 1.13.0 | Middle 50% of page ratios | 95% median interval | Pages at or below 1× |
| --- | --- | --- | --- | --- | --- |
| Attribute write | C | 0.49× | 0.49–0.51× | 0.472–0.519× | 9/9 |
| Attribute write | C++ | 0.51× | 0.48–0.52× | 0.482–0.522× | 9/9 |
| Attribute write | Rust | 0.56× | 0.56–0.57× | 0.551–0.578× | 9/9 |
| Canvas fillRect | C | 0.91× | 0.90–0.94× | 0.902–0.952× | 9/9 |
| Canvas fillRect | C++ | 0.92× | 0.90–0.99× | 0.874–1.014× | 7/9 |
| Canvas fillRect | Rust | 0.94× | 0.94–0.98× | 0.912–1.023× | 7/9 |
| Canvas pixel read | C | 1.10× | 1.00–1.16× | 0.953–1.656× | 2/9 |
| Canvas pixel read | C++ | 0.96× | 0.91–1.00× | 0.901–1.091× | 6/9 |
| Canvas pixel read | Rust | 0.90× | 0.84–1.14× | 0.840–1.159× | 6/9 |
| DOM ID lookup | C | 0.64× | 0.58–0.72× | 0.538–0.730× | 9/9 |
| DOM ID lookup | C++ | 0.61× | 0.58–0.71× | 0.562–0.715× | 9/9 |
| DOM ID lookup | Rust | 0.60× | 0.58–0.73× | 0.551–0.763× | 9/9 |
| Tree traversal | C | 0.79× | 0.77–0.83× | 0.664–0.913× | 9/9 |
| Tree traversal | C++ | 0.79× | 0.77–0.80× | 0.704–0.866× | 9/9 |
| Tree traversal | Rust | 0.65× | 0.61–0.92× | 0.576–0.993× | 8/9 |
| Read 1 KiB string | C | 0.47× | 0.42–0.48× | 0.423–0.512× | 9/9 |
| Read 1 KiB string | C++ | 0.45× | 0.40–0.46× | 0.363–0.464× | 9/9 |
| Read 1 KiB string | Rust | 0.44× | 0.39–0.47× | 0.374–0.499× | 9/9 |
| Table creation | C | 0.94× | 0.82–1.01× | 0.806–1.029× | 6/9 |
| Table creation | C++ | 0.93× | 0.88–1.02× | 0.821–1.031× | 5/9 |
| Table creation | Rust | 0.95× | 0.93–0.96× | 0.905–0.969× | 8/9 |

Across all 84 reported phases and string lengths, the same-page comparison matched or beat 1.13.0 in **82/84** cases. The median interval lay entirely above 1× in **0/84** cases. Totals and subphases overlap.

| Slower paired phase | Guest | Metric | Candidate / 1.13.0 | 95% median interval | Pages at or below 1× |
| --- | --- | --- | --- | --- | --- |
| canvas-pixels | C | getImageData(): µs/call | 1.102× | 0.953–1.656× | 2/9 |
| string-marshalling | C++ | set 16384 B | 1.020× | 0.954–1.039× | 3/9 |

Across all reported phases and string lengths, 81/84 comparable candidate medians were within 10× of the fastest compiled shim and 71/84 matched or beat 1.13.0. Totals and their subphases overlap. Each ratio compares the same phase on both sides.

| Phases above 10× | Phase | Guest | Shim | Candidate / shim |
| --- | --- | --- | --- | --- |
| dom-query | bulk: total ms | C | Embind | 468.25× |
| dom-query | bulk: total ms | C++ | Embind | 611.25× |
| dom-query | bulk: total ms | Rust | Embind | 568.75× |

The bulk DOM query returns a live collection to Embind, which discards it. The component host materializes the collection with `Array.from`, then the bindings lower every element into a WIT resource handle. The ratio includes that difference in work. [Embind loop](cpp/dom-query/emscripten/main.cpp) · [Component host](web/host/web-host.js) · [C guest loop](c/dom-query/main.c)

### DOM bindings with identical guest code

These 216 fresh-page samples compare each language’s exact core Wasm binary with each set of bindings in the table. The direct JS shim calls the same DOM host, puts owned handles in guest memory and recycles them on guest drops. It implements the synchronous imports used by these guests. Jco also provides Canonical ABI checks, task tracking and instance shutdown. [Direct shim](web/bench/dom-core-shim.mjs) · [Raw timings and correctness checks](web/bench/results/dom-control-browser.json)

The bulk query copies 2,000 handles per call, 10 times. Each traversal visits 19,531 nodes. The runner checks the rendered fixture or node count for each guest and verifies list counts and handle release for the direct shim after warm-up and measurement.

With list materialization on both sides, the candidate took **1.30–1.72×** the direct shim’s bulk-query time across the three guests. Times below are per measured workload, after warm-up.

![DOM phase times for Jco 1.13.0 and the candidate relative to the same-guest direct shim](web/bench/results/dom-control-runtime.png)

| Phase | Guest | Direct (ms) | 1.13.0 (ms) | Candidate (ms) | Candidate / direct | Candidate / 1.13.0 | Rounds at or below 1.13.0 | Candidate / previous | Rounds at or below previous |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DOM ID lookup | C | 16.73 | 28.63 | 18.20 | 1.09× | 0.64× | 9/9 | 0.94× | 7/9 |
| DOM ID lookup | C++ | 16.19 | 28.45 | 19.18 | 1.18× | 0.67× | 9/9 | 0.87× | 7/9 |
| DOM ID lookup | Rust | 13.12 | 23.89 | 17.16 | 1.31× | 0.72× | 9/9 | 0.95× | 6/9 |
| Bulk DOM query | C | 7.52 | 12.15 | 9.80 | 1.30× | 0.81× | 8/9 | 0.91× | 5/9 |
| Bulk DOM query | C++ | 7.00 | 12.21 | 11.45 | 1.64× | 0.94× | 5/9 | 0.92× | 7/9 |
| Bulk DOM query | Rust | 6.34 | 11.97 | 10.94 | 1.72× | 0.91× | 6/9 | 1.01× | 5/9 |
| Tree construction | C | 25.19 | 52.06 | 45.73 | 1.82× | 0.88× | 5/9 | 0.84× | 6/9 |
| Tree construction | C++ | 22.77 | 54.58 | 53.16 | 2.33× | 0.97× | 3/9 | 0.95× | 6/9 |
| Tree construction | Rust | 26.52 | 44.25 | 48.42 | 1.83× | 1.09× | 2/9 | 0.98× | 5/9 |
| Tree traversal | C | 6.69 | 13.94 | 13.88 | 2.07× | 1.00× | 3/9 | 0.85× | 7/9 |
| Tree traversal | C++ | 5.50 | 15.27 | 16.38 | 2.98× | 1.07× | 3/9 | 1.02× | 4/9 |
| Tree traversal | Rust | 7.61 | 14.32 | 17.38 | 2.28× | 1.21× | 2/9 | 1.00× | 4/9 |

On the same guest binaries, initialization took the following times before the first guest call. Each median covers 9 fresh pages and includes importing the binding module, fetching the guest and instantiating it. The direct shim uses `WebAssembly.instantiateStreaming`.

| Workload | Guest | Direct startup (ms) | 1.13.0 (ms) | Candidate (ms) | Candidate / direct | Candidate / 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- |
| ID and bulk query | C | 8.88 | 11.75 | 21.45 | 2.42× | 1.83× |
| ID and bulk query | C++ | 9.34 | 11.32 | 21.43 | 2.30× | 1.89× |
| ID and bulk query | Rust | 9.19 | 11.64 | 20.85 | 2.27× | 1.79× |
| Tree traversal | C | 8.61 | 11.49 | 22.08 | 2.56× | 1.92× |
| Tree traversal | C++ | 8.27 | 10.99 | 20.63 | 2.49× | 1.88× |
| Tree traversal | Rust | 9.09 | 10.81 | 22.67 | 2.49× | 2.10× |

### Cost of a synchronous host import

The scalar, string and resource loops run 131,072 iterations per pass. The string loop changes the first byte before each call. The resource loop acquires a host object, borrows it to read its value, and drops it. The optional-resource loop checks the discriminant in guest memory every time and reads and drops each present handle. Each pass checks its checksum. All four adapters use byte-identical core modules. The direct shim keeps the fixture’s single live handle in one slot.

The byte-list loops copy a 176 × 176 RGBA region (123,904 bytes) 2,048 times per pass in each direction. The host-to-guest case uses a reusable host view and a fixed guest allocation. In the reverse direction the host keeps the final snapshot while the guest changes the source in Wasm. Both cases sum the changing first byte during the loop and verify the whole payload afterward. The canvas demo also measures browser readback, host allocation and guest allocation.

The string-return loops make 32,768 calls per pass for 16-byte results and 1,024 for 16 KiB results. One host returns a repeated ASCII string. The other rotates four strings containing two-, three-, and four-byte UTF-8 sequences. The guest checks each byte length, sums the first bytes, and hashes every distinct result outside the timer.

Times are nanoseconds per guest iteration, including the loop and host work. Each cell is the median of 7 fresh-page medians, with 2 warm-ups and 5 timed passes per page. The runner interleaves the four builds. [Raw timings and digests](web/bench/results/import-loop.json)

| Operation | Direct | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Candidate / direct |
| --- | --- | --- | --- | --- | --- | --- |
| u32 | 14.5 | 12.2 | 1,899.7 | 16.8 | 1.37× | 1.16× |
| 2-byte string | 460.8 | 422.7 | 2,523.0 | 121.3 | 0.29× | 0.26× |
| 9-byte string | 404.4 | 405.1 | 2,542.1 | 178.5 | 0.44× | 0.44× |
| 32-byte string | 410.5 | 409.7 | 2,360.5 | 415.8 | 1.01× | 1.01× |
| Acquire, borrow, drop | 42.0 | 265.5 | 4,620.4 | 122.1 | 0.46× | 2.91× |
| Optional resource, half present | 30.5 | 174.0 | 3,311.2 | 129.7 | 0.75× | 4.25× |
| 121 KiB host-to-guest byte list | 4,931.6 | 4,931.6 | 8,886.7 | 5,175.8 | 1.05× | 1.05× |
| 121 KiB guest-to-host byte list | 95,019.5 | 95,800.8 | 99,853.5 | 95,019.5 | 0.99× | 1.00× |
| 16-byte UTF-8 result, repeated ASCII | 1,629.6 | 1,834.1 | 4,074.1 | 344.8 | 0.19× | 0.21× |
| 16-byte UTF-8 result, rotating Unicode | 1,538.1 | 1,770.0 | 4,165.6 | 909.4 | 0.51× | 0.59× |
| 16 KiB UTF-8 result, repeated ASCII | 35,351.6 | 34,375.0 | 51,953.1 | 18,359.4 | 0.53× | 0.52× |
| 16 KiB UTF-8 result, rotating Unicode | 44,628.9 | 45,214.8 | 74,902.3 | 31,152.3 | 0.69× | 0.70× |

![Time per guest iteration relative to Jco 1.13.0, by import and transfer direction](web/bench/results/import-loop-runtime.png)

### Where the canvas read spends its time

The same-page comparison was repeated with a clock around the demo’s host method. That method reads 176 × 176 pixels from Chromium and creates a JavaScript byte array. The remainder includes guest allocation and freeing, the copy into Wasm, binding checks, the loop and observer overhead. Each cell is a median across 9 page medians. Columns are summarized independently. [Raw instrumented samples](web/bench/results/canvas-control-browser.json)

| Guest | Bindings | Full read (µs) | Inside host (µs) | Remainder (µs) | Inside host (%) |
| --- | --- | --- | --- | --- | --- |
| C | 1.13.0 | 352.5 | 339.4 | 13.7 | 96.1% |
| C | Candidate | 349.5 | 334.8 | 14.5 | 95.8% |
| C++ | 1.13.0 | 339.0 | 322.9 | 14.5 | 96.0% |
| C++ | Candidate | 352.6 | 338.6 | 14.8 | 95.9% |
| Rust | 1.13.0 | 339.1 | 326.1 | 13.8 | 95.9% |
| Rust | Candidate | 344.5 | 329.8 | 14.7 | 95.8% |

The host accounted for 95.8–96.1% of the full read across these builds. The candidate spent 14.5–14.8 µs per read outside the host, compared with 13.7–14.5 µs for 1.13.0.

### Canvas pixel transfers with the same guest binary

Each call transfers a 176 × 176 RGBA region (123,904 bytes). The original browser host copies the pixel array on both read and write. The alternate host creates a typed-array view over the browser’s readback or the binding’s write snapshot, preserving its offset and length. All four implementations still copy the bytes across the Wasm boundary. [View adapter](web/bench/canvas-host.mjs) · [Direct shim](web/bench/dom-core-shim.mjs)

For each guest, all four bindings use identical core Wasm. Each table cell is the median of 9 page medians, with one warm-up and 4 measured passes per page. The runner rotates the four bindings on each page, alternates the host order and checks every pixel on both canvases after each invocation. [Raw timings and pixel checks](web/bench/results/canvas-host.json)

Changing the host reduced the candidate’s read time by **43–52%** and write time by **58–60%**. With the view adapter, its six timings were **0.92–1.07×** the corresponding direct shim times. The headline benchmarks use the original host.

![Canvas read and write times for the candidate with both hosts and the direct shim with pixel views](web/bench/results/canvas-host-runtime.png)

| Guest | Bindings | Original read (µs) | View read (µs) | Original write (µs) | View write (µs) |
| --- | --- | --- | --- | --- | --- |
| C | Direct shim | 341.8 | 179.9 | 256.1 | 108.1 |
| C | 1.13.0 | 340.4 | 180.7 | 254.3 | 139.1 |
| C | Stock main | 374.6 | 218.8 | 318.0 | 122.2 |
| C | Candidate | 367.4 | 177.6 | 261.3 | 107.2 |
| C++ | Direct shim | 346.1 | 181.4 | 245.3 | 113.0 |
| C++ | 1.13.0 | 341.3 | 184.9 | 257.2 | 117.1 |
| C++ | Stock main | 347.4 | 219.0 | 306.8 | 139.3 |
| C++ | Candidate | 335.5 | 190.8 | 258.6 | 108.0 |
| Rust | Direct shim | 350.0 | 204.3 | 265.6 | 104.2 |
| Rust | 1.13.0 | 350.5 | 189.8 | 259.7 | 115.6 |
| Rust | Stock main | 356.8 | 212.4 | 390.9 | 166.9 |
| Rust | Candidate | 356.4 | 187.6 | 275.8 | 111.5 |

<details><summary>All timed phases and string lengths</summary>

| Demo | Phase | Guest | Candidate time | Fresh-page / 1.13.0 | Same-page / 1.13.0 | Candidate / main | Fastest shim | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| attribute-churn | total time | C | 61.27 ms | 0.50× | 0.49× | 0.15× | Embind | 0.58× |
| attribute-churn | total time | C++ | 50.55 ms | 0.51× | 0.51× | 0.14× | Embind | 0.47× |
| attribute-churn | total time | Rust | 68.61 ms | 0.65× | 0.56× | 0.22× | Embind | 0.64× |
| attribute-churn | per setAttribute() | C | 0.77 µs | 0.50× | 0.49× | 0.15× | Embind | 0.58× |
| attribute-churn | per setAttribute() | C++ | 0.63 µs | 0.51× | 0.51× | 0.14× | Embind | 0.48× |
| attribute-churn | per setAttribute() | Rust | 0.86 µs | 0.65× | 0.56× | 0.22× | Embind | 0.65× |
| canvas-draw | total | C | 54.66 ms | 1.00× | 0.91× | 0.25× | Embind | 0.61× |
| canvas-draw | total | C++ | 55.09 ms | 0.85× | 0.92× | 0.27× | Embind | 0.61× |
| canvas-draw | total | Rust | 45.53 ms | 0.92× | 0.94× | 0.24× | Embind | 0.50× |
| canvas-draw | per fill_rect() | C | 1.09 µs | 1.00× | 0.91× | 0.25× | Embind | 0.61× |
| canvas-draw | per fill_rect() | C++ | 1.10 µs | 0.85× | 0.92× | 0.27× | Embind | 0.61× |
| canvas-draw | per fill_rect() | Rust | 0.91 µs | 0.92× | 0.94× | 0.24× | Embind | 0.50× |
| canvas-pixels | getImageData(): µs/call | C | 353.60 µs | 1.02× | 1.10× | 0.97× | Embind | 1.58× |
| canvas-pixels | getImageData(): µs/call | C++ | 323.80 µs | 1.02× | 0.96× | 0.88× | Embind | 1.45× |
| canvas-pixels | getImageData(): µs/call | Rust | 365.30 µs | 1.03× | 0.90× | 0.99× | Embind | 1.63× |
| canvas-pixels | putImageData(): µs/call | C | 295.80 µs | 1.02× | 0.87× | 0.95× | Embind | 1.26× |
| canvas-pixels | putImageData(): µs/call | C++ | 276.10 µs | 0.97× | 0.98× | 0.86× | Embind | 1.18× |
| canvas-pixels | putImageData(): µs/call | Rust | 259.50 µs | 0.49× | 0.93× | 0.75× | Embind | 1.11× |
| dom-query | individual: total ms | C | 17.47 ms | 0.64× | 0.64× | 0.14× | Embind | 0.60× |
| dom-query | individual: total ms | C++ | 23.13 ms | 0.89× | 0.61× | 0.22× | Embind | 0.80× |
| dom-query | individual: total ms | Rust | 20.34 ms | 0.80× | 0.60× | 0.19× | Embind | 0.70× |
| dom-query | bulk: total ms | C | 9.37 ms | 0.71× | 0.76× | 0.49× | Embind | 468.25× |
| dom-query | bulk: total ms | C++ | 12.22 ms | 1.09× | 0.80× | 0.61× | Embind | 611.25× |
| dom-query | bulk: total ms | Rust | 11.38 ms | 1.01× | 0.72× | 0.64× | Embind | 568.75× |
| dom-query | individual: µs/element | C | 0.87 µs | 0.64× | 0.64× | 0.14× | Embind | 0.60× |
| dom-query | individual: µs/element | C++ | 1.16 µs | 0.89× | 0.61× | 0.22× | Embind | 0.80× |
| dom-query | individual: µs/element | Rust | 1.02 µs | 0.80× | 0.60× | 0.19× | Embind | 0.70× |
| dom-traversal | build | C | 52.76 ms | 0.97× | 0.76× | 0.24× | EM_JS | 2.74× |
| dom-traversal | build | C++ | 43.06 ms | 0.84× | 0.77× | 0.20× | EM_JS | 2.24× |
| dom-traversal | build | Rust | 53.43 ms | 0.93× | 0.82× | 0.27× | EM_JS | 2.78× |
| dom-traversal | traverse (total) | C | 15.95 ms | 1.05× | 0.79× | 0.14× | EM_JS | 3.78× |
| dom-traversal | traverse (total) | C++ | 13.50 ms | 0.97× | 0.79× | 0.13× | EM_JS | 3.20× |
| dom-traversal | traverse (total) | Rust | 19.93 ms | 1.10× | 0.65× | 0.16× | EM_JS | 4.72× |
| dom-traversal | traverse (per node) | C | 0.82 µs | 1.05× | 0.79× | 0.14× | EM_JS | 3.78× |
| dom-traversal | traverse (per node) | C++ | 0.69 µs | 0.97× | 0.79× | 0.13× | EM_JS | 3.20× |
| dom-traversal | traverse (per node) | Rust | 1.02 µs | 1.10× | 0.65× | 0.16× | EM_JS | 4.72× |
| string-marshalling | set 8 B | C | 0.46 µs | 0.53× | 0.65× | 0.13× | EM_JS | 1.36× |
| string-marshalling | set 8 B | C++ | 0.45 µs | 0.52× | 0.66× | 0.14× | EM_JS | 1.34× |
| string-marshalling | set 8 B | Rust | 0.43 µs | 0.47× | 0.77× | 0.14× | EM_JS | 1.27× |
| string-marshalling | get 8 B | C | 0.56 µs | 0.24× | 0.25× | 0.11× | EM_JS | 2.77× |
| string-marshalling | get 8 B | C++ | 0.62 µs | 0.27× | 0.24× | 0.12× | EM_JS | 3.07× |
| string-marshalling | get 8 B | Rust | 0.57 µs | 0.26× | 0.25× | 0.11× | EM_JS | 2.84× |
| string-marshalling | set 128 B | C | 0.68 µs | 0.61× | 0.93× | 0.16× | wasm-bindgen | 1.17× |
| string-marshalling | set 128 B | C++ | 0.68 µs | 0.64× | 0.88× | 0.16× | wasm-bindgen | 1.16× |
| string-marshalling | set 128 B | Rust | 0.68 µs | 0.64× | 0.96× | 0.15× | wasm-bindgen | 1.16× |
| string-marshalling | get 128 B | C | 1.95 µs | 0.71× | 0.76× | 0.30× | wasm-bindgen | 2.19× |
| string-marshalling | get 128 B | C++ | 1.92 µs | 0.80× | 0.71× | 0.32× | wasm-bindgen | 2.15× |
| string-marshalling | get 128 B | Rust | 1.84 µs | 0.55× | 0.72× | 0.36× | wasm-bindgen | 2.07× |
| string-marshalling | set 1024 B | C | 1.01 µs | 0.85× | 0.86× | 0.25× | wasm-bindgen | 1.10× |
| string-marshalling | set 1024 B | C++ | 1.10 µs | 0.90× | 0.89× | 0.27× | wasm-bindgen | 1.19× |
| string-marshalling | set 1024 B | Rust | 1.05 µs | 0.83× | 0.98× | 0.28× | wasm-bindgen | 1.15× |
| string-marshalling | get 1024 B | C | 2.14 µs | 0.45× | 0.47× | 0.28× | wasm-bindgen | 0.37× |
| string-marshalling | get 1024 B | C++ | 2.07 µs | 0.40× | 0.45× | 0.26× | wasm-bindgen | 0.36× |
| string-marshalling | get 1024 B | Rust | 2.12 µs | 0.43× | 0.44× | 0.29× | wasm-bindgen | 0.37× |
| string-marshalling | set 16384 B | C | 7.52 µs | 0.94× | 1.00× | 0.68× | wasm-bindgen | 1.06× |
| string-marshalling | set 16384 B | C++ | 7.75 µs | 1.04× | 1.02× | 0.70× | wasm-bindgen | 1.09× |
| string-marshalling | set 16384 B | Rust | 7.44 µs | 1.00× | 0.99× | 0.68× | wasm-bindgen | 1.05× |
| string-marshalling | get 16384 B | C | 19.96 µs | 0.36× | 0.49× | 0.35× | wasm-bindgen | 0.23× |
| string-marshalling | get 16384 B | C++ | 19.24 µs | 0.38× | 0.55× | 0.32× | wasm-bindgen | 0.22× |
| string-marshalling | get 16384 B | Rust | 19.35 µs | 0.49× | 0.54× | 0.36× | wasm-bindgen | 0.22× |
| string-marshalling | set 262144 B | C | 121.50 µs | 0.45× | 0.76× | 0.42× | Embind | 1.05× |
| string-marshalling | set 262144 B | C++ | 115.40 µs | 0.43× | 0.76× | 0.40× | Embind | 1.00× |
| string-marshalling | set 262144 B | Rust | 116.10 µs | 0.43× | 0.93× | 0.43× | Embind | 1.00× |
| string-marshalling | get 262144 B | C | 308.05 µs | 0.30× | 0.29× | 0.38× | wasm-bindgen | 0.22× |
| string-marshalling | get 262144 B | C++ | 296.65 µs | 0.31× | 0.30× | 0.36× | wasm-bindgen | 0.21× |
| string-marshalling | get 262144 B | Rust | 292.55 µs | 0.30× | 0.29× | 0.38× | wasm-bindgen | 0.21× |
| table-update | create: total ms | C | 13.92 ms | 0.96× | 0.94× | 0.20× | EM_JS | 2.41× |
| table-update | create: total ms | C++ | 13.22 ms | 0.83× | 0.93× | 0.18× | EM_JS | 2.29× |
| table-update | create: total ms | Rust | 14.65 ms | 0.93× | 0.95× | 0.22× | EM_JS | 2.53× |
| table-update | create: µs/row | C | 6.96 µs | 0.96× | 0.94× | 0.20× | EM_JS | 2.41× |
| table-update | create: µs/row | C++ | 6.61 µs | 0.83× | 0.93× | 0.18× | EM_JS | 2.28× |
| table-update | create: µs/row | Rust | 7.33 µs | 0.93× | 0.95× | 0.22× | EM_JS | 2.53× |
| table-update | update (selected): total ms | C | 1.10 ms | 1.00× | 0.80× | 0.30× | wasm-bindgen | 1.13× |
| table-update | update (selected): total ms | C++ | 1.13 ms | 0.82× | 0.78× | 0.29× | wasm-bindgen | 1.16× |
| table-update | update (selected): total ms | Rust | 1.03 ms | 0.97× | 0.97× | 0.34× | wasm-bindgen | 1.06× |
| table-update | update (selected): µs/row | C | 0.55 µs | 0.99× | 0.81× | 0.30× | wasm-bindgen | 1.13× |
| table-update | update (selected): µs/row | C++ | 0.56 µs | 0.82× | 0.78× | 0.29× | wasm-bindgen | 1.16× |
| table-update | update (selected): µs/row | Rust | 0.52 µs | 0.97× | 0.97× | 0.34× | wasm-bindgen | 1.06× |
| table-update | clear (unselected): total ms | C | 3.65 ms | 0.85× | 0.77× | 0.22× | wasm-bindgen | 1.29× |
| table-update | clear (unselected): total ms | C++ | 3.87 ms | 0.75× | 0.74× | 0.19× | wasm-bindgen | 1.37× |
| table-update | clear (unselected): total ms | Rust | 3.77 ms | 0.91× | 0.77× | 0.25× | wasm-bindgen | 1.33× |
| table-update | clear (unselected): µs/row | C | 1.82 µs | 0.85× | 0.77× | 0.22× | wasm-bindgen | 1.29× |
| table-update | clear (unselected): µs/row | C++ | 1.93 µs | 0.76× | 0.74× | 0.19× | wasm-bindgen | 1.37× |
| table-update | clear (unselected): µs/row | Rust | 1.88 µs | 0.91× | 0.77× | 0.25× | wasm-bindgen | 1.33× |

</details>

### Payload and startup

Payload medians cover 34 component inputs. Compression is per file. Startup is the median of the 21 per-workload and guest medians, from dynamic import through initialization, with browser caching disabled.

| Build | JS (KiB) | Core Wasm (KiB) | Total (KiB) | Gzip (KiB) | Brotli (KiB) | Startup (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 | 19.4 | 64.4 | 85.4 | 29.3 | 24.1 | 11.17 |
| Stock main | 183.9 | 64.4 | 255.2 | 58.2 | 48.3 | 25.63 |
| Candidate | 122.5 | 64.4 | 190.0 | 49.8 | 41.5 | 20.61 |

### What ships with `--minify`

Each Jco build generated its default and minified distribution from the same 34 components. Jco 1.13.0 uses Terser for its minify option. Stock main and the branch use Oxc. All external Wasm files matched byte for byte across formats. Payloads include JavaScript and external Wasm, compressed per file. Chromium interleaved the six distributions across 630 fresh pages, with 5 rounds for each of the 21 guest and workload combinations. The two ratio columns compare each format to that build’s default for the same guest and workload, then take the median of the 21 ratios. The final column compares workload times to the same format of 1.13.0. [Distribution sizes](web/bench/results/minified-sizes.json) · [Timings and resource requests](web/bench/results/minified-browser.json)

| Distribution | JS (KiB) | Total gzip (KiB) | Total Brotli (KiB) | Startup (ms) | Startup / default | Runtime / default | At or below 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 default | 19.4 | 29.3 | 24.1 | 11.03 | 1.00× | 1.00× | 21/21 |
| 1.13.0 minified | 8.7 | 28.8 | 23.7 | 10.93 | 0.97× | 1.02× | 21/21 |
| Stock main default | 183.9 | 58.2 | 48.3 | 26.08 | 1.00× | 1.00× | 1/21 |
| Stock main minified | 106.9 | 51.2 | 43.2 | 23.37 | 0.92× | 1.02× | 2/21 |
| Candidate default | 122.5 | 49.8 | 41.5 | 21.20 | 1.00× | 1.00× | 17/21 |
| Candidate minified | 69.8 | 44.7 | 37.9 | 18.91 | 0.90× | 0.99× | 19/21 |

Chromium’s Resource Timing entries give four consecutive intervals from the start of dynamic import until the module is ready. The gap before the first Wasm request includes resolving dependencies and executing JavaScript. The local server served uncompressed assets with caching disabled. Browser response-body sizes were checked against the generated file sizes. Each column reports its own median over workload medians.

| Distribution | Import to JS response end (ms) | JS response end to first Wasm request (ms) | First Wasm request to last Wasm response (ms) | Last Wasm response to ready (ms) |
| --- | --- | --- | --- | --- |
| 1.13.0 default | 2.27 | 3.24 | 2.41 | 3.08 |
| 1.13.0 minified | 2.33 | 2.96 | 2.47 | 2.98 |
| Stock main default | 2.50 | 16.72 | 2.50 | 4.22 |
| Stock main minified | 2.54 | 14.43 | 2.44 | 4.07 |
| Candidate default | 2.48 | 11.91 | 2.27 | 4.21 |
| Candidate minified | 2.31 | 10.21 | 2.44 | 3.96 |

Minifying the branch reduced startup by 10% on the median same-workload comparison. Its median import-to-ready time was 18.91 ms, compared with 10.93 ms for minified 1.13.0. Between the end of the entry JavaScript response and the first Wasm request, the corresponding medians were 10.21 and 2.96 ms.

![Default and minified gzip payloads and fresh-page startup for three Jco builds](web/bench/results/minified-startup.png)

### Startup with DevTools disconnected

In 1,470 fresh documents, the page timed its own dynamic import, ran the guest and sent the result to a local server. One browser kept the Puppeteer DevTools connection open. The other disconnected before the first measured navigation. Both navigated the same tab, with matching Chrome flags, no-store responses and verified network transfers. The order of the two browsers alternated over 5 rounds. Each table cell is the median of the 21 workload medians. [Observer timings](web/bench/results/startup-observer.json)

| Distribution | Attached startup (ms) | Detached startup (ms) | Attached JS end to Wasm request (ms) | Detached JS end to Wasm request (ms) |
| --- | --- | --- | --- | --- |
| 1.13.0 default | 9.69 | 7.43 | 3.34 | 1.98 |
| 1.13.0 minified | 9.20 | 7.29 | 2.90 | 1.91 |
| Stock main default | 25.42 | 16.60 | 17.29 | 9.69 |
| Stock main minified | 22.23 | 15.71 | 14.62 | 8.99 |
| Candidate default | 19.96 | 13.01 | 11.94 | 6.91 |
| Candidate minified | 17.73 | 12.95 | 10.58 | 6.47 |
| Previous branch default | 20.45 | 13.41 | 12.34 | 6.98 |

With DevTools disconnected, default-output startup took **0.99×** the previous revision’s time. The candidate was faster in 13/21 workloads. Each workload contributes its median within-round time ratio.

### Where startup time goes

Across 9 rounds, 1,134 fresh pages imported a default module and checked its first guest result with DevTools disconnected. Half recorded when the browser’s asynchronous WebAssembly compile and instantiate calls began and when their promises settled. Each instrumented page had an ordinary control with the same build, workload and round. The last column gives the median paired import-time ratio.

| Build | Import (ms) | Through JS response (ms) | JS end to first Wasm call (ms) | Compile only (ms) | Instantiate only (ms) | Both pending (ms) | Between calls (ms) | Last settlement to ready (ms) | Traced / ordinary |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 | 6.47 | 1.70 | 2.00 | 1.03 | 0.15 | 0.05 | 1.35 | 0.14 | 0.98× |
| Stock main | 13.81 | 2.00 | 8.44 | 1.43 | 0.16 | 0.05 | 1.07 | 0.32 | 0.94× |
| Candidate | 11.60 | 1.89 | 6.17 | 1.58 | 0.19 | 0.00 | 1.16 | 0.26 | 1.00× |

Compared with 1.13.0, the candidate’s median paired difference was **+4.94 ms** for import and **+4.01 ms** between the JavaScript response and the first Wasm call. These differences pair the two traced pages within each round before taking the median per workload and across workloads.

Each instant on a page counts once, including when several compile calls overlap. Pending calls measure elapsed wall time and can include fetching a module, scheduling and JavaScript running on the same page. The time from the entry script’s response to the first Wasm call also includes loading its dependencies. Instrumented pages copy the interval records after import readiness and before calling the guest. Columns are medians across workload medians and can sum to a different value from the median import. [Call intervals and ordinary control samples](web/bench/results/wasm-startup.json)

![Share of module import time before, during and between WebAssembly calls for each Jco build](web/bench/results/wasm-startup.png)

#### When the binding module starts executing

In 1,800 fresh documents, five small workloads ran in each of three guest languages. Each build ran once with a performance mark as its first executable statement and once with its ordinary source per round. The browser had already loaded the shared host. Time from the JavaScript response to the mark includes module loading, linking, compilation and browser scheduling. Each cell summarizes the 15 workload medians.

| Build | JS response to module body (ms) | Module body to first Wasm request (ms) | Ordinary import (ms) | Ordinary first result (ms) | Marked / ordinary import |
| --- | --- | --- | --- | --- | --- |
| 1.13.0 | 3.23 | 0.95 | 16.41 | 25.65 | 0.93× |
| Stock main | 15.49 | 6.70 | 38.34 | 72.62 | 0.97× |
| Candidate | 11.31 | 4.34 | 31.08 | 46.79 | 0.96× |
| Previous branch | 11.58 | 4.45 | 30.43 | 46.10 | 0.94× |

On ordinary pages, the median within-round ratio for candidate / previous time to first result was **0.986×**. The candidate finished sooner in 9/15 workload and language pairs. Against 1.13.0 the median ratio was 1.77×. Each pair contributes one median across rounds. [Page timings and marked module hashes](web/bench/results/module-body.json)

![Median first-result ratios and per-case 95% sign-test intervals in small workloads. Left of one favors the candidate.](web/bench/results/small-first-result.png)

### Time to the first guest result

Each fresh page called the guest immediately after import, using the same workload arguments across builds. The first call includes the complete guest workload and its browser API calls. The final column times both import and execution on one clock. Each column reports the median of the 21 workload medians with DevTools disconnected.

| Distribution | Import (ms) | First guest call (ms) | Time to first result (ms) |
| --- | --- | --- | --- |
| 1.13.0 default | 7.43 | 66.34 | 74.43 |
| 1.13.0 minified | 7.29 | 61.46 | 68.29 |
| Stock main default | 16.60 | 253.46 | 272.18 |
| Stock main minified | 15.71 | 233.18 | 250.75 |
| Candidate default | 13.01 | 66.45 | 81.29 |
| Candidate minified | 12.95 | 63.17 | 76.11 |
| Previous branch default | 13.41 | 62.93 | 80.63 |

The following ratios compare default builds within each round. Each row summarizes the three language medians. A ratio below 1 means the candidate returned the guest result sooner.

| Workload | Candidate / 1.13.0 | Candidate / stock main |
| --- | --- | --- |
| Attribute write | 0.66× | 0.21× |
| Canvas fillRect | 1.16× | 0.31× |
| Canvas pixel read | 1.01× | 0.87× |
| DOM ID lookup | 1.00× | 0.27× |
| Tree traversal | 1.13× | 0.20× |
| Read 1 KiB string | 0.95× | 0.79× |
| Table creation | 1.21× | 0.29× |

The candidate reached the first result at or before 1.13.0 in **7/21** language/workload pairs and at or before stock main in **21/21**.

![Time to the first guest result for each workload and language relative to 1.13.0 and stock main. Points left of 1 favor the candidate.](web/bench/results/first-result.png)

### Eager JavaScript compilation

The branch exposes `jco transpile --eager-compile` and the JS API option `eagerCompile: true`. The option reproduced all 21 hinted candidate modules served in these trials. Verification also checked 68 ordinary and minified JS outputs after removing the hint, and all 64 accompanying Wasm outputs against their original hashes. [Jco transpile options at the verified revision](https://github.com/vados-cosmonic/jco/blob/900def079675eaa44479b686670ff6f3c5749093/docs/src/transpiling.md) · [Verification](web/bench/verify-compile-hint.mjs)

The server prepended `//# allFunctionsCalledOnLoad` and a newline to each ordinary entry module. Chromium can use these 29 bytes to compile functions while the module loads. Each guest used identical Wasm and the same browser host. DevTools was disconnected. The full run used the headline workloads. A second run measured a first call that writes attributes on eight elements twice, draws 16 rectangles, queries eight elements twice, traverses a seven-node tree, or creates and updates eight table rows. [V8 compile hints](https://v8.dev/blog/explicit-compile-hints) · [Full workload timings](web/bench/results/compile-hint.json) · [Small workload timings](web/bench/results/compile-hint-small.json)

Each cell summarizes the median hinted / ordinary ratio within rounds, then takes the median across language/workload pairs. A ratio below 1 favors eager compilation. The last column counts pairs for which the guest returned its first result sooner.

| Workload | Build | Rounds | Import | First guest call | Time to first result | Pairs with earlier first result |
| --- | --- | --- | --- | --- | --- | --- |
| Full | 1.13.0 | 9 | 1.07× | 0.96× | 0.95× | 16/21 |
| Full | Stock main | 9 | 1.30× | 0.97× | 0.98× | 13/21 |
| Full | Candidate | 9 | 1.28× | 0.90× | 0.98× | 13/21 |
| Small | 1.13.0 | 15 | 1.07× | 0.36× | 0.81× | 15/15 |
| Small | Stock main | 15 | 1.30× | 0.49× | 0.92× | 14/15 |
| Small | Candidate | 15 | 1.28× | 0.28× | 0.96× | 14/15 |

For applications that import the component ahead of an interaction, the first-call column measures the remaining wait. Applications that import on demand also pay the import time. The absolute times below are candidate medians across workload medians, with each column summarized independently.

| Workload | Candidate output | Import (ms) | First guest call (ms) | Time to first result (ms) |
| --- | --- | --- | --- | --- |
| Full | Ordinary | 19.00 | 85.00 | 104.08 |
| Full | Eager | 25.92 | 81.20 | 104.82 |
| Small | Ordinary | 23.88 | 12.20 | 37.91 |
| Small | Eager | 31.15 | 3.79 | 35.87 |

| Eager candidate first result at or before release | Ordinary 1.13.0 | Eager 1.13.0 |
| --- | --- | --- |
| Full | 10/21 | 7/21 |
| Small | 0/15 | 0/15 |

Each pair also has a two-sided 95% sign-test interval for its median first-result ratio across fresh-browser rounds. The counts below show how often the interval establishes a direction on this machine. Coverage applies to each comparison individually.

| Candidate workload | Interval favors eager | Interval includes 1 | Interval favors ordinary |
| --- | --- | --- | --- |
| Full | 0 | 21 | 0 |
| Small | 0 | 15 | 0 |

| Candidate first result | Small workload | Full workload |
| --- | --- | --- |
| Attribute write | 0.94× | 0.98× |
| Canvas fillRect | 0.98× | 1.06× |
| Canvas pixel read | — | 0.91× |
| DOM ID lookup | 0.97× | 0.95× |
| Tree traversal | 0.96× | 1.00× |
| Read 1 KiB string | — | 0.96× |
| Table creation | 0.97× | 1.02× |

![Time to the first result with eager compilation relative to ordinary candidate bindings. Each marker shows the median of three languages and the line spans their range.](web/bench/results/compile-hint.png)

### Private data fields in the checked runtime

The bundled checked runtime uses short names for private data fields. Acorn resolved 21,758 renamed declarations and uses across 34 modules. The verifier checked lexical ownership, a one-to-one name mapping in every class, and every byte outside the private identifiers. All 32 external core Wasm files and all 66 packaged minified outputs matched the previous build byte for byte.

| JS size reduction per component (bytes) | Median | Range |
| --- | --- | --- |
| Uncompressed | 5044 | 5029–5044 |
| gzip -9 | 386 | 365–399 |
| Brotli 11 | 303.5 | 233–359 |

Private methods, accessors and fields that supply a function or class name keep their spellings. Debug runtime builds retain the source names. [Per-component verification](web/bench/results/runtime-fields.json) · [Verifier](web/bench/verify-runtime-fields.mjs)

### Time to generate the bindings

Each of 126 timed native processes read one component, prepared the checked runtime and wrote its bindings to a fresh directory. The runner randomized build and input order within each round, warmed the filesystem cache before timing and verified each output after stopping the timer. Both transpilers used the Cargo dev profile and rustc 1.99.1 (58cf8f9c3 2026-10-13). The CPU measurement counts user and system time in the child process.

| Input | Previous (ms) | Candidate (ms) | Paired wall time | 95% median interval | Paired CPU time |
| --- | --- | --- | --- | --- | --- |
| c/dom-query | 239.9 | 223.4 | 1.042× | 0.829–1.158× | 1.037× |
| rust/canvas-draw | 257.0 | 275.2 | 0.993× | 0.897–1.204× | 0.989× |
| cpp/table-update | 227.0 | 211.2 | 0.968× | 0.869–1.113× | 0.971× |

The intervals are per-input sign-test intervals for the median paired ratio. [Timings and executable hashes](web/bench/results/transpile-time.json)

### Startup against the previous branch

The same detached runs included ordinary output from the previous generator `5c6ddda44`. The table compares the two default builds, using the same component binaries and workload arguments in each round. For each language/workload pair, it divides candidate time by previous time and takes the median across rounds. Each timing column summarizes those pair medians. The last columns count the two-sided 95% sign-test intervals for time to first result that lie wholly below or above parity.

| Workload | Rounds | Import | First call | Time to first result | Pairs with earlier first result | Interval favors candidate | Interval favors previous |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Full | 9 | 0.95× | 0.98× | 0.97× | 15/21 | 2 | 0 |
| Small | 15 | 0.98× | 0.90× | 0.93× | 12/15 | 1 | 0 |

### Generated JavaScript reached by each demo

Chromium recorded block coverage on 126 fresh pages in a separate run. One page imported each module and finished initialization. A second also ran the demo once and checked its output. The table reports medians over the 21 guest and workload combinations. Sizes count UTF-8 bytes in V8’s covered source ranges. A demo can leave error handling, shutdown or other supported operations unexercised. [Per-module coverage and hashes](web/bench/results/js-coverage.json)

| Build | Reached at init (KiB) | Reached through first run (KiB) | Share through first run | Unreached through first run (KiB) |
| --- | --- | --- | --- | --- |
| 1.13.0 | 4.8 | 16.3 | 76.6% | 5.0 |
| Stock main | 54.6 | 97.4 | 50.9% | 93.3 |
| Candidate | 31.4 | 54.9 | 44.3% | 69.5 |

V8 also identified the functions that define the candidate’s shared runtime classes. Each row counts the function and its nested methods in the generated JavaScript. Reached bytes come from V8 block coverage on the same pages. The values are medians across modules containing that function.

| Runtime class | Modules | Emitted (KiB) | Reached at init (KiB) | Through first run (KiB) | Unreached through first run (KiB) |
| --- | --- | --- | --- | --- | --- |
| `AsyncTask` | 21 | 22.4 | 4.6 | 6.0 | 16.5 |
| `ComponentAsyncState` | 21 | 16.2 | 1.4 | 2.3 | 13.8 |
| `AsyncThread` | 21 | 3.2 | 0.7 | 0.7 | 2.5 |
| `RepTable` | 21 | 2.9 | 1.0 | 1.3 | 1.6 |

<details><summary>Candidate startup, variation and paired comparison to 1.13.0</summary>

The paired ratio divides the candidate time by the 1.13.0 time within each round, then takes the median. The final column counts rounds where the candidate was at least as fast.

| Operation | Guest | Startup median (ms) | Warm phase p25 | Warm phase p50 | Warm phase p75 | Phase unit | Paired ratio to 1.13.0 | Rounds at or below 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | 20.87 | 0.70 | 0.77 | 0.81 | µs | 0.51× | 7/7 |
| Attribute write | C++ | 21.08 | 0.60 | 0.63 | 0.66 | µs | 0.49× | 7/7 |
| Attribute write | Rust | 20.41 | 0.72 | 0.86 | 0.91 | µs | 0.60× | 7/7 |
| Canvas fillRect | C | 18.92 | 0.93 | 1.09 | 1.17 | µs | 0.92× | 4/7 |
| Canvas fillRect | C++ | 20.13 | 0.95 | 1.10 | 1.18 | µs | 0.92× | 4/7 |
| Canvas fillRect | Rust | 19.78 | 0.87 | 0.91 | 1.05 | µs | 0.94× | 4/7 |
| Canvas pixel read | C | 23.29 | 346.55 | 353.60 | 401.95 | µs | 1.09× | 2/7 |
| Canvas pixel read | C++ | 21.30 | 317.10 | 323.80 | 368.45 | µs | 1.21× | 3/7 |
| Canvas pixel read | Rust | 20.69 | 331.10 | 365.30 | 371.25 | µs | 0.93× | 4/7 |
| DOM ID lookup | C | 19.74 | 0.74 | 0.87 | 0.97 | µs | 0.70× | 7/7 |
| DOM ID lookup | C++ | 21.53 | 1.06 | 1.16 | 1.35 | µs | 0.99× | 5/7 |
| DOM ID lookup | Rust | 21.13 | 0.87 | 1.02 | 1.17 | µs | 1.03× | 3/7 |
| Tree traversal | C | 20.61 | 15.37 | 15.95 | 17.25 | ms | 1.02× | 3/7 |
| Tree traversal | C++ | 21.57 | 11.99 | 13.50 | 16.43 | ms | 1.12× | 3/7 |
| Tree traversal | Rust | 19.98 | 18.92 | 19.93 | 20.37 | ms | 1.15× | 2/7 |
| Read 1 KiB string | C | 19.70 | 1.82 | 2.14 | 2.27 | µs | 0.38× | 7/7 |
| Read 1 KiB string | C++ | 20.05 | 2.05 | 2.07 | 2.14 | µs | 0.42× | 7/7 |
| Read 1 KiB string | Rust | 18.08 | 1.90 | 2.12 | 2.15 | µs | 0.39× | 7/7 |
| Table creation | C | 20.59 | 11.94 | 13.92 | 17.34 | ms | 0.96× | 5/7 |
| Table creation | C++ | 22.62 | 11.92 | 13.22 | 14.42 | ms | 0.88× | 7/7 |
| Table creation | Rust | 21.01 | 13.29 | 14.65 | 15.53 | ms | 0.90× | 5/7 |

</details>

[Raw browser timings](web/bench/results/candidate-browser.json) · [File sizes, digests and generator revision](web/bench/results/candidate-sizes.json)

### Reproduce the candidate run

Run the dependency installation, main setup and size commands in [Reproduce the comparison](#reproduce-the-comparison), then run the following from the repository root. Cargo uses the Jco checkout’s pinned toolchain and lockfile.

```sh
git clone https://github.com/vados-cosmonic/jco ../jco-candidate
git -C ../jco-candidate checkout 900def079675eaa44479b686670ff6f3c5749093
node web/bench/candidate.mjs ../jco-candidate
git -C ../jco-candidate worktree add --detach ../jco-reference 5c6ddda44bce1730a61a69f2d48db94e3065ca31
node web/bench/candidate.mjs --reference ../jco-reference
CHROME_BIN=/path/to/chrome BENCH_CANDIDATE=1 ROUNDS=7 node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome BENCH_DOM_CONTROL=1 ROUNDS=9 node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome BENCH_PAIRED=1 ROUNDS=9 node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome BENCH_CANVAS_CONTROL=1 ROUNDS=9 node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome ROUNDS=9 node web/bench/canvas-host-bench.mjs
CHROME_BIN=/path/to/chrome ROUNDS=7 node web/bench/import-loop.mjs ../jco-candidate
CHROME_BIN=/path/to/chrome node web/bench/coverage.mjs
pnpm -C ../jco-candidate install --frozen-lockfile
pnpm -C ../jco-candidate --filter @bytecodealliance/jco-transpile run build
node web/bench/candidate.mjs --verify-wasm ../jco-candidate
node web/bench/minified.mjs ../jco-candidate
node web/bench/verify-runtime-fields.mjs 53a0057e71d25b91dcb0f9c475762140765078c8
python3 web/bench/transpile-time.py ../jco-reference/target/debug/examples/transpile ../jco-candidate/target/debug/examples/transpile --rounds 21 --build-profile dev
CHROME_BIN=/path/to/chrome BENCH_MINIFIED=1 ROUNDS=5 node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome ROUNDS=5 node web/bench/startup-observer.mjs
CHROME_BIN=/path/to/chrome ROUNDS=9 node web/bench/startup-observer.mjs --wasm-timing
CHROME_BIN=/path/to/chrome ROUNDS=15 node web/bench/startup-observer.mjs --module-body
CHROME_BIN=/path/to/chrome ROUNDS=9 node web/bench/startup-observer.mjs --compile-hint
CHROME_BIN=/path/to/chrome ROUNDS=15 node web/bench/startup-observer.mjs --compile-hint --small
node web/bench/verify-compile-hint.mjs ../jco-candidate
python3 web/bench/report.py --from-candidate
python3 web/bench/candidate-report.py
```

The minification comparison uses each version’s packaged transpiler. The verification command compares the packaged candidate’s default JavaScript and core Wasm to the native generator’s measured output for every input.

<details><summary>Run the Jco binding correctness checks</summary>

After building the candidate above, these tests exercise the inline and bundled generators, both runtime profiles, synchronous imports and the async operations that share their runtime. The integration tests use the guest fixtures from the pinned upstream build.

```sh
cd ../jco-candidate
cargo test --locked -p js-component-bindgen --lib
cargo test --locked -p js-component-bindgen --lib --features embedded-cm-runtime
pnpm --filter @bytecodealliance/jco-cm-runtime test
pnpm --filter @bytecodealliance/jco-cm-runtime test:checked
gh run download 45736422241 --repo bytecodealliance/jco --name js-generated-tests --dir packages/jco-transpile/test/fixtures/generated
cd packages/jco-transpile
node node_modules/vitest/vitest.mjs run -c test/vitest.ts \
  test/eager-compile.ts test/external-runtime/codegen.ts test/sync-host-import.ts test/p3/canonical-abi-traps.ts test/p3/task-return-memory.ts \
  test/p3/sync-call-block-trap.ts test/p3/async-export-future-result.ts \
  test/p3/future-lifts.ts test/p3/future-lowers.ts test/p3/future-drop.ts test/p3/future-transfer-g2g.ts \
  test/p3/stream-lifts.ts test/p3/stream-lowers.ts test/p3/stream-pass-through.ts test/p3/sync-stream-copy.ts
```

</details>

<!-- candidate:end -->

<!-- benchmark:start -->

## Browser performance

**jco 1.13.0 vs. main at `fdbf1ae2`** · 2026-11-26 · HeadlessChrome/156.0.8078.47 · Intel(R) Xeon(R) Processor @ 2.60GHz · linux 6.12.111 x64 · Node v26.13.0. [Upstream commit](https://github.com/bytecodealliance/jco/commit/fdbf1ae2dbc9469b5c275b5686d8a4c43681618f) · [Transpiler build](https://github.com/bytecodealliance/jco/actions/runs/45736422241)

These stock and shim timings come from the same interleaved fresh-page trial as the performance branch. [Full trial](web/bench/results/candidate-browser.json) · [Stock and shim samples](web/bench/results/browser.json)

Across the seven operations below and three guest languages, main took longer in **21 of 21** median comparisons. The highest ratio was **7.55×** for the C guest in `dom-traversal`.

For 256 KiB string reads, the median time on main changed by -22% to -13% across the three guest languages. The phase tables below include every tested string size.

Each cell is the median of 7 fresh-page samples. The chart divides main’s median time by 1.13.0’s for the same guest and operation. A value below 1× means main finished faster.

![Median time on main divided by baseline time for seven operations and three guest languages](web/bench/results/runtime.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 0.265 | 1.33 | — | — | 1.54 | 4.95 | 1.24 | 4.38 | 1.32 | 3.98 |
| Canvas fillRect (µs) | 0.917 | 1.80 | — | — | 1.09 | 4.29 | 1.29 | 4.14 | 0.988 | 3.84 |
| Canvas pixel read (µs) | 165.20 | 224.00 | — | — | 347.50 | 363.70 | 317.10 | 368.30 | 355.80 | 370.20 |
| DOM ID lookup (µs) | 0.288 | 1.45 | — | — | 1.36 | 6.06 | 1.30 | 5.32 | 1.27 | 5.45 |
| Tree traversal (ms) | 0.96 | 24.90 | 4.22 | 7.32 | 15.16 | 114.53 | 13.94 | 101.42 | 18.09 | 125.85 |
| Read 1 KiB string (µs) | 0.099 | 12.03 | 10.41 | 5.79 | 4.73 | 7.69 | 5.17 | 7.92 | 4.89 | 7.27 |
| Table creation (ms) | 4.22 | 15.15 | 5.79 | 10.59 | 14.46 | 71.05 | 15.97 | 75.37 | 15.73 | 68.00 |

Embind and EM_JS are the C++ Emscripten variants. An em dash marks an unavailable combination. Across toolchains, the upstream implementations can do different amounts of work. For example, the JavaScript bulk DOM query obtains a live collection while the component host materializes a list.

<details><summary>Run-to-run variation for the two jco versions</summary>

Each cell spans the 25th to 75th percentile of measured times, using linear interpolation between sorted samples.

| Operation | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 1.26–1.58 | 4.67–5.23 | 1.14–1.26 | 4.00–4.48 | 1.28–1.65 | 3.80–4.26 |
| Canvas fillRect (µs) | 1.01–1.18 | 4.12–4.46 | 1.06–1.31 | 4.01–4.32 | 0.864–1.21 | 3.62–4.18 |
| Canvas pixel read (µs) | 316.10–398.90 | 325.10–399.95 | 265.00–353.55 | 333.05–391.75 | 342.15–403.05 | 337.40–389.25 |
| DOM ID lookup (µs) | 1.18–1.48 | 5.80–6.73 | 1.16–1.34 | 4.88–5.66 | 1.02–1.38 | 4.99–5.68 |
| Tree traversal (ms) | 14.41–19.01 | 109.26–122.19 | 13.04–14.56 | 96.24–111.13 | 14.90–19.72 | 119.91–130.77 |
| Read 1 KiB string (µs) | 4.27–5.05 | 7.33–8.53 | 4.44–5.92 | 7.05–7.97 | 4.52–15.96 | 7.14–7.52 |
| Table creation (ms) | 12.52–16.00 | 64.14–85.00 | 14.94–16.93 | 71.75–80.57 | 13.57–16.27 | 63.74–74.58 |

</details>

<details><summary>All workload phases, per-call timings, and string transfer rates</summary>

Times come from the tables rendered by the demos and retain their original reporting precision. Effective string throughput uses the ASCII payload length divided by median call time (decimal MB/s).

**attribute-churn**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total time (ms) | 21.21 | 106.42 | — | — | 122.94 | 395.57 | 98.77 | 350.26 | 105.37 | 318.34 |
| per setAttribute() (µs) | 0.265 | 1.33 | — | — | 1.54 | 4.95 | 1.24 | 4.38 | 1.32 | 3.98 |

**canvas-draw**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total (ms) | 45.86 | 90.25 | — | — | 54.39 | 214.71 | 64.56 | 207.26 | 49.40 | 192.01 |
| per fill_rect() (µs) | 0.917 | 1.80 | — | — | 1.09 | 4.29 | 1.29 | 4.14 | 0.988 | 3.84 |

**canvas-pixels**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| getImageData() (µs) | 165.20 | 224.00 | — | — | 347.50 | 363.70 | 317.10 | 368.30 | 355.80 | 370.20 |
| putImageData() (µs) | 14.00 | 234.50 | — | — | 291.20 | 312.20 | 283.20 | 319.40 | 528.80 | 344.00 |

**dom-query**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| individual, total (ms) | 5.76 | 28.93 | — | — | 27.20 | 121.25 | 26.04 | 106.38 | 25.46 | 108.91 |
| bulk, total (ms) | 0.01 | 0.02 | — | — | 13.18 | 19.12 | 11.24 | 19.96 | 11.24 | 17.75 |
| individual: µs/element (µs) | 0.288 | 1.45 | — | — | 1.36 | 6.06 | 1.30 | 5.32 | 1.27 | 5.45 |

**dom-traversal**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| build (ms) | 11.64 | 37.26 | 19.24 | 29.50 | 54.66 | 222.49 | 51.26 | 217.28 | 57.46 | 200.64 |
| traverse (total) (ms) | 0.96 | 24.90 | 4.22 | 7.32 | 15.16 | 114.53 | 13.94 | 101.42 | 18.09 | 125.85 |
| traverse (per node) (µs) | 0.049 | 1.27 | 0.216 | 0.375 | 0.776 | 5.86 | 0.713 | 5.19 | 0.926 | 6.44 |

**string-marshalling**

![Median DOM textContent set and get latency by payload length for each guest and jco version, on logarithmic axes](web/bench/results/strings.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| set 8 B (µs) | 0.18 | 0.787 | 0.337 | 0.547 | 0.868 | 3.44 | 0.873 | 3.16 | 0.915 | 3.18 |
| set 8 B (MB/s) | 44.44 | 10.17 | 23.74 | 14.63 | 9.22 | 2.33 | 9.16 | 2.53 | 8.74 | 2.52 |
| get 8 B (µs) | 0.084 | 0.969 | 0.202 | 0.229 | 2.33 | 5.03 | 2.29 | 5.11 | 2.24 | 5.08 |
| get 8 B (MB/s) | 95.24 | 8.26 | 39.60 | 34.93 | 3.43 | 1.59 | 3.49 | 1.57 | 3.57 | 1.58 |
| set 128 B (µs) | 0.293 | 1.11 | 0.841 | 0.587 | 1.11 | 4.16 | 1.06 | 4.34 | 1.07 | 4.41 |
| set 128 B (MB/s) | 436.86 | 115.00 | 152.20 | 218.06 | 115.00 | 30.78 | 120.87 | 29.50 | 120.08 | 29.05 |
| get 128 B (µs) | 0.082 | 2.30 | 1.46 | 0.893 | 2.75 | 6.50 | 2.40 | 5.93 | 3.38 | 5.17 |
| get 128 B (MB/s) | 1,560.98 | 55.75 | 87.73 | 143.34 | 46.53 | 19.68 | 53.24 | 21.57 | 37.83 | 24.77 |
| set 1024 B (µs) | 1.01 | 1.55 | 2.68 | 0.921 | 1.19 | 4.09 | 1.22 | 4.05 | 1.28 | 3.71 |
| set 1024 B (MB/s) | 1,017.89 | 662.35 | 381.80 | 1,111.83 | 862.68 | 250.61 | 837.29 | 252.71 | 802.51 | 275.94 |
| get 1024 B (µs) | 0.099 | 12.03 | 10.41 | 5.79 | 4.73 | 7.69 | 5.17 | 7.92 | 4.89 | 7.27 |
| get 1024 B (MB/s) | 10,343.43 | 85.09 | 98.34 | 176.80 | 216.35 | 133.14 | 198.22 | 129.21 | 209.54 | 140.87 |
| set 16384 B (µs) | 13.16 | 8.32 | 33.52 | 7.12 | 8.03 | 10.98 | 7.45 | 11.03 | 7.47 | 11.01 |
| set 16384 B (MB/s) | 1,244.61 | 1,968.76 | 488.71 | 2,301.45 | 2,040.09 | 1,491.62 | 2,200.08 | 1,485.67 | 2,194.48 | 1,488.24 |
| get 16384 B (µs) | 0.472 | 164.05 | 156.40 | 88.50 | 55.51 | 57.75 | 50.48 | 60.38 | 39.84 | 54.25 |
| get 16384 B (MB/s) | 34,711.86 | 99.87 | 104.76 | 185.13 | 295.14 | 283.71 | 324.60 | 271.37 | 411.27 | 302.01 |
| set 262144 B (µs) | 182.97 | 115.60 | 531.75 | 252.90 | 270.00 | 286.50 | 270.75 | 288.20 | 270.05 | 269.45 |
| set 262144 B (MB/s) | 1,432.72 | 2,267.68 | 492.98 | 1,036.55 | 970.90 | 914.99 | 968.21 | 909.59 | 970.72 | 972.89 |
| get 262144 B (µs) | 11.88 | 2,505.90 | 2,621.65 | 1,385.35 | 1,025.70 | 802.70 | 944.00 | 818.45 | 961.00 | 777.35 |
| get 262144 B (MB/s) | 22,056.71 | 104.61 | 99.99 | 189.23 | 255.58 | 326.58 | 277.69 | 320.29 | 272.78 | 337.23 |

**table-update**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create, total (ms) | 4.22 | 15.15 | 5.79 | 10.59 | 14.46 | 71.05 | 15.97 | 75.37 | 15.73 | 68.00 |
| create, per row (µs) | 2.11 | 7.58 | 2.89 | 5.29 | 7.23 | 35.52 | 7.99 | 37.69 | 7.87 | 34.00 |
| update (selected), total (ms) | 0.44 | 1.23 | 1.07 | 0.975 | 1.10 | 3.70 | 1.37 | 3.88 | 1.06 | 3.04 |
| update (selected), per row (µs) | 0.22 | 0.615 | 0.537 | 0.488 | 0.553 | 1.85 | 0.685 | 1.94 | 0.532 | 1.52 |
| clear (unselected), total (ms) | 2.16 | 3.81 | 3.23 | 2.83 | 4.28 | 16.31 | 5.12 | 20.64 | 4.12 | 14.99 |
| clear (unselected), per row (µs) | 1.08 | 1.91 | 1.62 | 1.41 | 2.14 | 8.15 | 2.56 | 10.32 | 2.06 | 7.50 |

</details>

<details><summary>Module load and initialization, median milliseconds</summary>

Elapsed browser time for dynamic import through instantiation, with the shared demo host already loaded. The browser process is reused, each page has HTTP caching disabled, and assets are served uncompressed over loopback. These timings include scheduling and local requests. JS is already loaded by the harness.

| Workload | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| attribute-churn | 14.79 | — | — | 13.69 | 23.69 | 12.52 | 23.80 | 11.14 | 25.47 |
| canvas-draw | 14.34 | — | — | 10.53 | 26.48 | 11.13 | 25.63 | 10.85 | 23.18 |
| canvas-pixels | 14.77 | — | — | 13.47 | 31.19 | 12.20 | 27.76 | 11.17 | 29.09 |
| dom-query | 14.47 | — | — | 11.53 | 29.31 | 11.33 | 25.58 | 11.32 | 24.28 |
| dom-traversal | 13.37 | 8.88 | 8.71 | 10.68 | 25.19 | 10.02 | 26.21 | 11.00 | 25.41 |
| string-marshalling | 12.92 | 8.92 | 7.67 | 10.10 | 24.23 | 9.50 | 26.00 | 10.56 | 22.72 |
| table-update | 14.78 | 10.61 | 9.01 | 11.68 | 28.26 | 12.02 | 27.43 | 12.10 | 27.93 |

</details>

<details><summary>Workload parameters and sampling</summary>

| Workload | Arguments |
| --- | ---: |
| attribute-churn | `elements=2000`, `iters=10` |
| canvas-draw | `rects=50000` |
| canvas-pixels | `size=256`, `minMs=10` |
| dom-query | `numElements=2000`, `iters=10` |
| dom-traversal | `depth=6`, `numChildren=5` |
| string-marshalling | `minMs=10` |
| table-update | `rows=2000` |

The regenerated 1.13.0 runtime assets match the checked-in jco output byte for byte for 21 of the 21 timed components.

Each page runs one warm-up, clears the document and performance entries, and runs the same workload again on the initialized module. The runner rotates the implementation order each round and reverses traversal on alternating rounds. Browser timings cover the work instrumented inside the demos. Canvas timings measure the API calls, which can finish before painting. Native Firefox execution was outside this Chromium run. [Individual samples in seconds and load times in milliseconds](web/bench/results/browser.json)

</details>

## Module size

Across 34 component inputs, the median change in gzip payload on main was **+27.8 KiB** per component (range +20.2 to +31.0 KiB). The payload sums the emitted JavaScript and external core Wasm files, including any Wasm inlined into JavaScript. Gzip level 9 and Brotli quality 11 are applied per file. Shared host code, HTML, type declarations and HTTP headers are excluded. The raw JavaScript reference lives in the demo page controller.

All external core Wasm files match byte for byte between the two generators. The size differences come entirely from the emitted JavaScript.

![Gzip payload in KiB for the seven browser workloads, grouped by guest language](web/bench/results/payload.png)

**DOM traversal download size** in KiB, gzip. Each row compares implementations from one guest language.

| Guest | Native component | jco 1.13.0 | jco main | Embind | EM_JS | wasm-bindgen |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| C | 26.4 | 28.5 | 56.2 | — | — | — |
| C++ | 26.9 | 29.0 | 56.7 | 21.4 | 14.2 | — |
| Rust | 50.6 | 52.7 | 80.3 | — | — | 27.0 |

<details><summary>All component sizes, in KiB</summary>

Paired columns list **1.13.0 / main**. Native is the original component binary. Core Wasm counts only separate .wasm files.

| Component | Native | Files | JS | Core Wasm | Raw total | Gzip | Brotli |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| C attribute-churn | 65.1 | 2 / 2 | 19.0 / 177.9 | 61.4 / 61.4 | 80.5 / 239.3 | 28.4 / 56.0 | 23.3 / 46.4 |
| C calculator | 0.9 | 1 / 1 | 2.3 / 101.4 | 0.0 / 0.0 | 2.3 / 101.4 | 1.3 / 21.6 | 1.2 / 18.5 |
| C canvas-draw | 66.5 | 2 / 2 | 22.6 / 192.3 | 61.9 / 61.9 | 84.6 / 254.2 | 28.6 / 56.7 | 23.6 / 46.9 |
| C canvas-pixels | 70.1 | 2 / 2 | 24.2 / 210.8 | 64.7 / 64.7 | 88.9 / 275.5 | 29.7 / 60.7 | 24.5 / 50.2 |
| C dom-query | 68.0 | 2 / 2 | 22.0 / 194.1 | 63.7 / 63.7 | 85.6 / 257.8 | 29.2 / 58.5 | 24.0 / 48.5 |
| C dom-traversal | 66.0 | 2 / 2 | 21.1 / 185.3 | 62.0 / 62.0 | 83.1 / 247.3 | 28.5 / 56.2 | 23.4 / 46.5 |
| C greet-bindgen | 56.3 | 2 / 2 | 2.6 / 108.8 | 55.9 / 55.9 | 58.5 / 164.8 | 24.3 / 46.3 | 20.0 / 38.8 |
| C greet-freestanding | 0.9 | 1 / 1 | 3.0 / 105.9 | 0.0 / 0.0 | 3.0 / 105.9 | 1.6 / 23.2 | 1.5 / 19.9 |
| C greet-libc | 54.9 | 2 / 2 | 2.6 / 108.8 | 54.5 / 54.5 | 57.1 / 163.3 | 23.8 / 45.8 | 19.5 / 38.4 |
| C hello-world | 60.4 | 2 / 2 | 13.8 / 164.1 | 57.8 / 57.8 | 71.6 / 222.0 | 26.7 / 54.6 | 22.0 / 45.5 |
| C string-marshalling | 66.2 | 2 / 2 | 19.4 / 184.9 | 62.6 / 62.6 | 82.0 / 247.5 | 28.9 / 57.9 | 23.9 / 48.2 |
| C table-update | 70.7 | 2 / 2 | 21.2 / 192.3 | 66.6 / 66.6 | 87.8 / 258.9 | 29.3 / 58.5 | 24.2 / 48.6 |
| C++ attribute-churn | 68.9 | 2 / 2 | 19.0 / 177.9 | 65.3 / 65.3 | 84.3 / 243.2 | 29.7 / 57.2 | 24.4 / 47.4 |
| C++ canvas-draw | 68.5 | 2 / 2 | 22.6 / 192.3 | 63.9 / 63.9 | 86.6 / 256.2 | 29.1 / 57.2 | 24.0 / 47.3 |
| C++ canvas-pixels | 73.1 | 2 / 2 | 24.2 / 210.8 | 67.8 / 67.8 | 91.9 / 278.5 | 30.6 / 61.6 | 25.1 / 50.7 |
| C++ dom-query | 71.7 | 2 / 2 | 22.0 / 194.1 | 67.4 / 67.4 | 89.4 / 261.5 | 30.7 / 60.0 | 25.1 / 49.6 |
| C++ dom-traversal | 68.0 | 2 / 2 | 21.1 / 185.3 | 64.0 / 64.0 | 85.1 / 249.3 | 29.0 / 56.7 | 23.8 / 47.0 |
| C++ hello-world | 60.4 | 2 / 2 | 13.8 / 164.1 | 57.8 / 57.8 | 71.6 / 221.9 | 26.6 / 54.5 | 21.9 / 45.4 |
| C++ string-marshalling | 68.3 | 2 / 2 | 19.4 / 184.9 | 64.8 / 64.8 | 84.1 / 249.6 | 29.5 / 58.5 | 24.3 / 48.5 |
| C++ table-update | 74.9 | 2 / 2 | 21.2 / 192.3 | 70.9 / 70.9 | 92.1 / 263.2 | 31.2 / 60.3 | 25.4 / 49.8 |
| Rust attribute-churn | 152.0 | 2 / 2 | 18.8 / 176.5 | 148.5 / 148.5 | 167.3 / 325.0 | 55.8 / 83.2 | 45.9 / 68.8 |
| Rust calculator-raw | 258.7 | 2 / 2 | 1.4 / 101.0 | 258.4 / 258.4 | 259.8 / 359.3 | 85.4 / 105.6 | 72.3 / 89.6 |
| Rust calculator | 258.0 | 2 / 2 | 1.4 / 101.0 | 257.7 / 257.7 | 259.1 / 358.7 | 85.1 / 105.4 | 72.1 / 89.4 |
| Rust canvas-draw | 140.9 | 2 / 2 | 22.4 / 190.9 | 136.4 / 136.4 | 158.8 / 327.3 | 53.0 / 80.9 | 43.8 / 67.1 |
| Rust canvas-pixels | 142.9 | 2 / 2 | 24.0 / 209.4 | 137.7 / 137.7 | 161.6 / 347.0 | 53.7 / 84.4 | 44.2 / 69.7 |
| Rust dom-query | 148.8 | 2 / 2 | 21.7 / 192.7 | 144.7 / 144.7 | 166.4 / 337.4 | 55.9 / 85.1 | 46.0 / 70.4 |
| Rust dom-traversal (dom_traversal.my.component) | 138.7 | 2 / 2 | 20.2 / 183.9 | 135.7 / 135.7 | 155.9 / 319.6 | 52.7 / 80.3 | 43.5 / 66.6 |
| Rust dom-traversal | 138.7 | 2 / 2 | 20.2 / 183.9 | 135.7 / 135.7 | 155.9 / 319.6 | 52.7 / 80.3 | 43.5 / 66.6 |
| Rust hello-world | 17.4 | 2 / 2 | 13.6 / 162.8 | 14.9 / 14.9 | 28.5 / 177.7 | 8.9 / 36.6 | 7.4 / 30.8 |
| Rust string-marshalling | 146.9 | 2 / 2 | 19.1 / 183.5 | 143.4 / 143.4 | 162.5 / 326.9 | 55.2 / 84.0 | 45.6 / 69.7 |
| Rust table-rows | 33.3 | 2 / 2 | 13.1 / 160.2 | 31.1 / 31.1 | 44.2 / 191.3 | 16.2 / 43.1 | 14.0 / 36.7 |
| Rust table-update | 149.5 | 2 / 2 | 20.6 / 191.5 | 146.2 / 146.2 | 166.8 / 337.7 | 56.1 / 85.2 | 46.3 / 70.7 |
| Rust todomvc | 14.4 | 2 / 2 | 15.3 / 164.7 | 11.6 / 11.6 | 26.8 / 176.3 | 7.6 / 34.6 | 6.5 / 29.2 |
| Rust vdom-diff | 40.9 | 2 / 2 | 14.8 / 164.6 | 38.5 / 38.5 | 53.3 / 203.1 | 19.7 / 46.7 | 17.0 / 39.8 |

</details>

<details><summary>Emscripten and wasm-bindgen payloads, in KiB</summary>

| Artifact directory | Files | Raw total | Gzip | Brotli |
| --- | ---: | ---: | ---: | ---: |
| cpp/attribute-churn/emscripten | 2 | 58.7 | 22.1 | 19.5 |
| cpp/canvas-draw/emscripten | 2 | 57.7 | 21.3 | 18.7 |
| cpp/canvas-pixels/emscripten | 2 | 63.8 | 23.4 | 20.4 |
| cpp/dom-query/emscripten | 2 | 60.0 | 22.3 | 19.6 |
| cpp/dom-traversal/em-js | 2 | 31.9 | 14.2 | 12.4 |
| cpp/dom-traversal/emscripten | 2 | 57.4 | 21.4 | 18.8 |
| cpp/string-marshalling/em-js | 2 | 33.4 | 14.8 | 13.0 |
| cpp/string-marshalling/emscripten | 2 | 58.4 | 21.8 | 19.2 |
| cpp/table-update/em-js | 2 | 35.6 | 15.5 | 13.6 |
| cpp/table-update/emscripten | 2 | 63.7 | 23.1 | 20.2 |
| rust/dom-traversal-wasm-bindgen | 2 | 72.0 | 27.0 | 22.6 |
| rust/string-marshalling-wasm-bindgen | 2 | 72.6 | 27.1 | 22.5 |
| rust/table-update-wasm-bindgen | 2 | 77.3 | 28.1 | 23.5 |

</details>

[Per-file byte counts and SHA-256 digests](web/bench/results/sizes.json)

<!-- benchmark:end -->

<details><summary>Earlier UTF-8 measurements</summary>

The performance branch also specializes UTF-8 conversion in both directions. For strings of up to 32 ASCII bytes, the bindings read or write the bytes directly. Non-ASCII text uses the checked codec, including its malformed-input traps. [Short-string changes](https://github.com/vados-cosmonic/jco/compare/ac28d5d481f3cfca94bc4c62f3571511c19386d9...9eeb7f0b9ab82a982810af5cdd1d9035b302aa39)

For longer host-returned strings, the runtime can encode into a reusable buffer before allocating guest memory. On the preceding upstream revision, a 16 KiB read took 26–28 µs across C, C++, and Rust, or 46–50% of the time for 1.13.0. The archived run compares the bindings immediately before and after this change. [UTF-8 benchmark and raw measurements](https://github.com/vados-cosmonic/component-demos/blob/7550fa7523931f918b6bd599174af07e6537961b/README.md#optimized-browser-bindings)

</details>

## Reproduce the comparison

From the repository root, use Node 24 or newer, npm, an authenticated GitHub CLI, Chrome or Chromium, and Python with Matplotlib 3.10.8 for the graphs.

```sh
npm ci --prefix web
web/bench/setup-main.sh
npm run --prefix web bench:sizes
CHROME_BIN=/path/to/chrome npm run --prefix web bench:browser
python3 web/bench/report.py
```

The setup script verifies the upstream CI run against the Git SHA in [pin.json](web/bench/pin.json) before downloading its transpiler. If the artifacts have expired, run `web/bench/setup-main.sh --source` with Git, pnpm 11, and the upstream Rust toolchain available. To measure a newer main, update the SHA and matching Linux test run in the pin, check the transpiler dependencies in `web/bench/main/package.json` against that checkout’s lockfile, and rerun the commands. Set `ROUNDS` to change the sample count.

The size pass reads the committed `web/{c,cpp,rust}/*/native/*.wasm` inputs and emits both browser variants in sibling `jco-baseline/` and `jco-main/` directories. They share the demo’s host mappings, disable Node compatibility, and use each generator’s default browser output. Each asset has a SHA-256 digest and separate raw, gzip, and Brotli byte counts. Generated bindings are local build products.

To run the original interactive demos, use `npm run --prefix web dev` after installing web dependencies. Their native mode requires a Firefox build with experimental WebAssembly Component Model support. The guest sources and their original build scripts remain in `c/`, `cpp/`, and `rust/`.
