# Component demos

This fork benchmarks the browser examples from [eqrion/component-demos at d0b9dd1](https://github.com/eqrion/component-demos/tree/d0b9dd1390a300978193adc623838fef4e4b632b). It runs the same compiled C, C++, and Rust WebAssembly components through jco 1.13.0, pinned upstream main, and a branch that optimizes synchronous host imports. The comparison also includes the demos’ JavaScript, Emscripten (Embind and EM_JS), and Rust wasm-bindgen implementations where available.

<!-- candidate:start -->

## Optimized browser bindings

The branch uses js-component-bindgen’s internal Oxc bundler and the checked jco-cm-runtime. [Measured Jco commit `460032a40`](https://github.com/vados-cosmonic/jco/commit/460032a40aaa3c56d5846614c04c4903e8bc0dea) · [Canvas host comparison](#canvas-pixel-transfers-with-the-same-guest-binary) · [Payload and startup](#payload-and-startup) · [Reproduction commands](#reproduce-the-candidate-run)

All Jco builds used the same guest binaries. Each value is the median of 7 fresh-page samples with one warm-up per page. The run collected 728 samples on 2026-11-26 with HeadlessChrome/156.0.8078.47 on Intel(R) Xeon(R) Processor @ 2.60GHz.

Stock main is pinned to `fdbf1ae2d`. [Upstream source](https://github.com/bytecodealliance/jco/commit/fdbf1ae2dbc9469b5c275b5686d8a4c43681618f) · [Transpiler CI build](https://github.com/bytecodealliance/jco/actions/runs/45736422241)

The candidate finished within **10× of the fastest available compiled shim in 21/21** headline comparisons. The largest ratio was **3.87×**. On separate fresh pages it matched or beat **1.13.0 in 17/21** and **stock main in 21/21**. On the same warmed page it matched or beat **1.13.0 in 20/21** headline cases and 80/84 across all phases. The shim comparison selects the lowest median among Embind, EM_JS and wasm-bindgen for each operation, including shims written in a different guest language. The phase tables in the original comparison describe workload differences and include raw JavaScript.

![Candidate runtime relative to the two targets by operation and language](web/bench/results/candidate-runtime.png)

| Operation | Guest | Unit | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Fastest shim | Shim time | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | µs | 1.34 | 3.93 | 0.63 | 0.47× | Embind | 1.16 | 0.54× |
| Attribute write | C++ | µs | 1.34 | 3.96 | 0.62 | 0.46× | Embind | 1.16 | 0.54× |
| Attribute write | Rust | µs | 1.47 | 4.47 | 0.84 | 0.57× | Embind | 1.16 | 0.73× |
| Canvas fillRect | C | µs | 1.10 | 3.63 | 1.11 | 1.01× | Embind | 1.92 | 0.58× |
| Canvas fillRect | C++ | µs | 1.12 | 3.50 | 1.02 | 0.91× | Embind | 1.92 | 0.53× |
| Canvas fillRect | Rust | µs | 1.02 | 3.85 | 1.01 | 0.99× | Embind | 1.92 | 0.53× |
| Canvas pixel read | C | µs | 345.20 | 334.00 | 330.20 | 0.96× | Embind | 213.00 | 1.55× |
| Canvas pixel read | C++ | µs | 350.30 | 354.20 | 323.00 | 0.92× | Embind | 213.00 | 1.52× |
| Canvas pixel read | Rust | µs | 322.80 | 383.30 | 288.40 | 0.89× | Embind | 213.00 | 1.35× |
| DOM ID lookup | C | µs | 1.11 | 5.67 | 1.07 | 0.96× | Embind | 1.22 | 0.88× |
| DOM ID lookup | C++ | µs | 1.36 | 4.93 | 1.02 | 0.75× | Embind | 1.22 | 0.84× |
| DOM ID lookup | Rust | µs | 1.17 | 4.85 | 0.76 | 0.65× | Embind | 1.22 | 0.62× |
| Tree traversal | C | ms | 11.72 | 96.56 | 13.25 | 1.13× | EM_JS | 4.09 | 3.24× |
| Tree traversal | C++ | ms | 12.56 | 101.75 | 15.38 | 1.22× | EM_JS | 4.09 | 3.76× |
| Tree traversal | Rust | ms | 15.53 | 110.10 | 15.82 | 1.02× | EM_JS | 4.09 | 3.87× |
| Read 1 KiB string | C | µs | 5.32 | 6.56 | 2.04 | 0.38× | wasm-bindgen | 5.84 | 0.35× |
| Read 1 KiB string | C++ | µs | 6.90 | 7.41 | 2.01 | 0.29× | wasm-bindgen | 5.84 | 0.34× |
| Read 1 KiB string | Rust | µs | 5.30 | 7.30 | 2.06 | 0.39× | wasm-bindgen | 5.84 | 0.35× |
| Table creation | C | ms | 14.96 | 68.33 | 13.73 | 0.92× | EM_JS | 5.06 | 2.71× |
| Table creation | C++ | ms | 13.91 | 71.16 | 12.65 | 0.91× | EM_JS | 5.06 | 2.50× |
| Table creation | Rust | ms | 14.21 | 68.96 | 12.90 | 0.91× | EM_JS | 5.06 | 2.55× |

Comparing implementations in the same language, the branch stayed within 10× in **13/13** available headline comparisons. Each cell divides the branch’s median by that shim’s median. A dash means the demo has no implementation for that binding. The demos supply compiled shims for C++ and Rust.

| Operation | C++ / Embind | C++ / EM_JS | Rust / wasm-bindgen |
| --- | --- | --- | --- |
| Attribute write | 0.54× | — | — |
| Canvas fillRect | 0.53× | — | — |
| Canvas pixel read | 1.52× | — | — |
| DOM ID lookup | 0.84× | — | — |
| Tree traversal | 0.67× | 3.76× | 2.57× |
| Read 1 KiB string | 0.18× | 0.20× | 0.35× |
| Table creation | 0.76× | 2.50× | 1.47× |

<details><summary>How the synchronous bindings work</summary>

Eligible single-instance, synchronous components reuse the caller’s task for host imports. The adapter keeps direct references to its task stack and instance flags and checks for store interruptions. Oxc removes the asynchronous import fallback and the subtask, waitable, and future constructors. The shutdown path skips creating the two empty stream and future tables. The generator skips asynchronous wrappers for synchronous allocators and post-return hooks. Standalone modules also omit suspension markers on core imports.

During a guest allocation, the checked runtime clears the instance’s may-leave flag and restores it on return or throw. Allocators in components with context-slot operations use the general guard to supply fresh slots for each call. The adapter lifts short ASCII strings four bytes at a time. Synchronous UTF-8 results of 256 to 262,144 code units can reuse a per-instance byte buffer capped at 256 KiB. The runtime encodes there before requesting the exact guest allocation. Nested calls and larger results use the ordinary encoder.

Resource drops check the instance flag and record traps. When lifting a borrowed host resource, the adapter validates the handle and reads its 32-bit representation directly. Imported host resources with automatically assigned representations use their guest handle as an array index. Explicit host representations and shared tables use a representation map. Components with async operations, cross-component resource transfers or call tracking use the general adapter.

An earlier run measures the change from removing the subtask constructor from synchronous components. [Archived report](https://github.com/vados-cosmonic/component-demos/blob/255eca61b14b5ab63567da558b5f561149cc5163/README.md#change-from-the-previous-branch-revision)

</details>

### Change from the previous branch revision

Both revisions ran on the same guest binaries in the same browser session. Each cell divides the candidate median by the previous revision’s median. Parentheses count the rounds in which the candidate finished faster. [Compare `a079ad6da` and `460032a40`](https://github.com/vados-cosmonic/jco/compare/a079ad6dace2af014cf63554e9b9cfef4291c363...460032a40aaa3c56d5846614c04c4903e8bc0dea)

Generated JavaScript was smaller for 34/34 inputs. External core Wasm files matched byte for byte for 32/32 inputs that emitted them. The median per-input change was -6,132 bytes of JavaScript and -1,384 bytes of total gzip payload. Across the 21 timed guest and workload combinations, the median ratio of candidate to previous startup time was 0.97×.

Both branch revisions also ran with their default output and caching disabled. The change column takes the difference for each guest and workload first, then the median of those differences.

| Startup interval | Previous (ms) | Candidate (ms) | Median change (ms) | Faster workloads |
| --- | --- | --- | --- | --- |
| Import to ready | 21.38 | 20.50 | -0.70 | 17/21 |
| Import to JS response end | 2.34 | 2.31 | -0.02 | 11/21 |
| JS end to first Wasm request | 12.51 | 11.62 | -1.04 | 20/21 |
| First Wasm request to last Wasm response | 2.36 | 2.26 | -0.07 | 13/21 |
| Last Wasm response to ready | 4.06 | 3.99 | -0.13 | 14/21 |

| Operation | C | C++ | Rust |
| --- | --- | --- | --- |
| Attribute write | 0.94× (4/7) | 1.00× (4/7) | 0.95× (4/7) |
| Canvas fillRect | 1.40× (1/7) | 1.15× (1/7) | 1.25× (1/7) |
| Canvas pixel read | 1.03× (2/7) | 1.02× (5/7) | 0.87× (4/7) |
| DOM ID lookup | 1.35× (2/7) | 1.00× (3/7) | 1.04× (3/7) |
| Tree traversal | 0.83× (3/7) | 1.01× (3/7) | 0.94× (5/7) |
| Read 1 KiB string | 0.98× (4/7) | 0.97× (5/7) | 0.93× (4/7) |
| Table creation | 1.07× (4/7) | 1.08× (1/7) | 0.93× (5/7) |
| Bulk DOM query | 1.08× (2/7) | 0.90× (2/7) | 0.84× (6/7) |
| Tree construction | 0.87× (5/7) | 0.85× (4/7) | 1.02× (4/7) |
| set 8 B | 0.83× (3/7) | 0.83× (6/7) | 1.02× (4/7) |
| get 8 B | 1.09× (3/7) | 0.87× (5/7) | 0.97× (4/7) |
| get 128 B | 0.87× (5/7) | 0.95× (4/7) | 0.98× (4/7) |
| get 16384 B | 0.96× (3/7) | 0.90× (6/7) | 0.98× (5/7) |
| get 262144 B | 0.97× (4/7) | 0.92× (4/7) | 0.99× (5/7) |

### Warm 1.13.0 comparison on the same page

For each guest and workload, both builds run once to warm up, then 4 times each on the same page. Each pair alternates which build runs first. The runner clears the DOM and performance entries before every call. It repeats this on 9 fresh pages. Each page contributes the median of its candidate / 1.13.0 ratios. The median across pages was at or below 1× for **20/21** headline cases. [Raw paired timings](web/bench/results/paired-browser.json)

![Median paired time ratios by workload and guest, with bars spanning the middle half of page ratios](web/bench/results/paired-runtime.png)

The middle 50% describes variation between pages. The median interval uses a two-sided sign test over independent page medians at the 95% level for each phase individually. Measurements on this CPU and browser can share machine load across pages.

| Operation | Guest | Candidate / 1.13.0 | Middle 50% of page ratios | 95% median interval | Pages at or below 1× |
| --- | --- | --- | --- | --- | --- |
| Attribute write | C | 0.49× | 0.49–0.50× | 0.482–0.520× | 9/9 |
| Attribute write | C++ | 0.50× | 0.49–0.51× | 0.483–0.523× | 9/9 |
| Attribute write | Rust | 0.56× | 0.55–0.57× | 0.545–0.571× | 9/9 |
| Canvas fillRect | C | 0.93× | 0.89–0.95× | 0.838–0.950× | 9/9 |
| Canvas fillRect | C++ | 0.92× | 0.91–0.94× | 0.877–0.978× | 9/9 |
| Canvas fillRect | Rust | 0.93× | 0.91–0.97× | 0.899–0.968× | 9/9 |
| Canvas pixel read | C | 1.06× | 0.92–1.21× | 0.889–1.286× | 4/9 |
| Canvas pixel read | C++ | 0.98× | 0.95–1.04× | 0.941–1.126× | 5/9 |
| Canvas pixel read | Rust | 0.98× | 0.92–1.09× | 0.807–1.106× | 5/9 |
| DOM ID lookup | C | 0.63× | 0.61–0.72× | 0.580–0.739× | 9/9 |
| DOM ID lookup | C++ | 0.65× | 0.59–0.71× | 0.569–0.731× | 9/9 |
| DOM ID lookup | Rust | 0.65× | 0.60–0.75× | 0.578–0.752× | 9/9 |
| Tree traversal | C | 0.79× | 0.79–0.92× | 0.742–1.000× | 8/9 |
| Tree traversal | C++ | 0.80× | 0.75–0.82× | 0.728–0.840× | 9/9 |
| Tree traversal | Rust | 0.62× | 0.57–0.95× | 0.551–1.030× | 7/9 |
| Read 1 KiB string | C | 0.45× | 0.40–0.45× | 0.396–0.516× | 9/9 |
| Read 1 KiB string | C++ | 0.40× | 0.40–0.44× | 0.363–0.498× | 9/9 |
| Read 1 KiB string | Rust | 0.45× | 0.38–0.49× | 0.346–0.498× | 9/9 |
| Table creation | C | 0.91× | 0.88–1.00× | 0.847–1.013× | 7/9 |
| Table creation | C++ | 0.99× | 0.81–1.09× | 0.775–1.100× | 5/9 |
| Table creation | Rust | 0.93× | 0.92–0.97× | 0.884–0.982× | 8/9 |

Across all 84 reported phases and string lengths, the same-page comparison matched or beat 1.13.0 in **80/84** cases. The median interval lay entirely above 1× in **0/84** cases. Totals and subphases overlap.

| Slower paired phase | Guest | Metric | Candidate / 1.13.0 | 95% median interval | Pages at or below 1× |
| --- | --- | --- | --- | --- | --- |
| canvas-pixels | C | getImageData(): µs/call | 1.055× | 0.889–1.286× | 4/9 |
| canvas-pixels | C | putImageData(): µs/call | 1.013× | 0.838–1.232× | 3/9 |
| canvas-pixels | C++ | putImageData(): µs/call | 1.009× | 0.882–1.022× | 2/9 |
| string-marshalling | C | set 1024 B | 1.008× | 0.878–1.058× | 4/9 |

Across all reported phases and string lengths, 81/84 comparable candidate medians were within 10× of the fastest compiled shim and 72/84 matched or beat 1.13.0. Totals and their subphases overlap. Each ratio compares the same phase on both sides.

| Phases above 10× | Phase | Guest | Shim | Candidate / shim |
| --- | --- | --- | --- | --- |
| dom-query | bulk: total ms | C | Embind | 431.20× |
| dom-query | bulk: total ms | C++ | Embind | 438.20× |
| dom-query | bulk: total ms | Rust | Embind | 334.60× |

The bulk DOM query returns a live collection to Embind, which discards it. The component host materializes the collection with `Array.from`, then the bindings lower every element into a WIT resource handle. The ratio includes that difference in work. [Embind loop](cpp/dom-query/emscripten/main.cpp) · [Component host](web/host/web-host.js) · [C guest loop](c/dom-query/main.c)

### DOM bindings with identical guest code

These 216 fresh-page samples compare each language’s exact core Wasm binary with each set of bindings in the table. The direct JS shim calls the same DOM host, puts owned handles in guest memory and recycles them on guest drops. It implements the synchronous imports used by these guests. Jco also provides Canonical ABI checks, task tracking and instance shutdown. [Direct shim](web/bench/dom-core-shim.mjs) · [Raw timings and correctness checks](web/bench/results/dom-control-browser.json)

The bulk query copies 2,000 handles per call, 10 times. Each traversal visits 19,531 nodes. The runner checks the rendered fixture or node count for each guest and verifies list counts and handle release for the direct shim after warm-up and measurement.

With list materialization on both sides, the candidate took **1.65–1.71×** the direct shim’s bulk-query time across the three guests. Times below are per measured workload, after warm-up.

![DOM phase times for Jco 1.13.0 and the candidate relative to the same-guest direct shim](web/bench/results/dom-control-runtime.png)

| Phase | Guest | Direct (ms) | 1.13.0 (ms) | Candidate (ms) | Candidate / direct | Candidate / 1.13.0 | Rounds at or below 1.13.0 | Candidate / previous | Rounds at or below previous |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DOM ID lookup | C | 15.03 | 24.16 | 20.52 | 1.37× | 0.85× | 7/9 | 1.18× | 4/9 |
| DOM ID lookup | C++ | 14.76 | 26.09 | 18.87 | 1.28× | 0.72× | 8/9 | 0.87× | 6/9 |
| DOM ID lookup | Rust | 13.33 | 23.63 | 17.19 | 1.29× | 0.73× | 9/9 | 0.96× | 6/9 |
| Bulk DOM query | C | 6.32 | 11.24 | 10.61 | 1.68× | 0.94× | 6/9 | 1.08× | 2/9 |
| Bulk DOM query | C++ | 6.19 | 10.86 | 10.58 | 1.71× | 0.97× | 6/9 | 0.94× | 6/9 |
| Bulk DOM query | Rust | 6.46 | 10.54 | 10.64 | 1.65× | 1.01× | 5/9 | 1.00× | 4/9 |
| Tree construction | C | 23.20 | 42.48 | 47.09 | 2.03× | 1.11× | 4/9 | 0.91× | 6/9 |
| Tree construction | C++ | 23.26 | 47.21 | 50.14 | 2.16× | 1.06× | 5/9 | 1.07× | 5/9 |
| Tree construction | Rust | 25.22 | 44.24 | 44.47 | 1.76× | 1.01× | 4/9 | 0.96× | 4/9 |
| Tree traversal | C | 5.89 | 12.15 | 13.69 | 2.32× | 1.13× | 2/9 | 0.88× | 7/9 |
| Tree traversal | C++ | 5.69 | 13.88 | 15.32 | 2.69× | 1.10× | 3/9 | 1.06× | 5/9 |
| Tree traversal | Rust | 7.94 | 14.31 | 17.81 | 2.24× | 1.24× | 3/9 | 1.01× | 5/9 |

On the same guest binaries, initialization took the following times before the first guest call. Each median covers 9 fresh pages and includes importing the binding module, fetching the guest and instantiating it. The direct shim uses `WebAssembly.instantiateStreaming`.

| Workload | Guest | Direct startup (ms) | 1.13.0 (ms) | Candidate (ms) | Candidate / direct | Candidate / 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- |
| ID and bulk query | C | 8.04 | 10.47 | 20.97 | 2.61× | 2.00× |
| ID and bulk query | C++ | 7.71 | 10.90 | 21.52 | 2.79× | 1.97× |
| ID and bulk query | Rust | 8.56 | 10.57 | 20.28 | 2.37× | 1.92× |
| Tree traversal | C | 7.80 | 10.12 | 20.08 | 2.57× | 1.98× |
| Tree traversal | C++ | 7.45 | 10.59 | 20.25 | 2.72× | 1.91× |
| Tree traversal | Rust | 8.64 | 10.24 | 20.31 | 2.35× | 1.98× |

### Cost of a synchronous host import

The scalar, string and resource loops run 131,072 iterations per pass. The string loop changes the first byte before each call. The resource loop acquires a host object, borrows it to read its value, and drops it. The optional-resource loop checks the discriminant in guest memory every time and reads and drops each present handle. Each pass checks its checksum. All four adapters use byte-identical core modules. The direct shim keeps the fixture’s single live handle in one slot.

The byte-list loops copy a 176 × 176 RGBA region (123,904 bytes) 2,048 times per pass in each direction. The host-to-guest case uses a reusable host view and a fixed guest allocation. In the reverse direction the host keeps the final snapshot while the guest changes the source in Wasm. Both cases sum the changing first byte during the loop and verify the whole payload afterward. The canvas demo also measures browser readback, host allocation and guest allocation.

The string-return loops make 32,768 calls per pass for 16-byte results and 1,024 for 16 KiB results. One host returns a repeated ASCII string. The other rotates four strings containing two-, three-, and four-byte UTF-8 sequences. The guest checks each byte length, sums the first bytes, and hashes every distinct result outside the timer.

Times are nanoseconds per guest iteration, including the loop and host work. Each cell is the median of 7 fresh-page medians, with 2 warm-ups and 5 timed passes per page. The runner interleaves the four builds. [Raw timings and digests](web/bench/results/import-loop.json)

| Operation | Direct | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Candidate / direct |
| --- | --- | --- | --- | --- | --- | --- |
| u32 | 14.5 | 12.2 | 1,761.6 | 15.3 | 1.25× | 1.05× |
| 2-byte string | 443.3 | 449.4 | 2,554.3 | 115.2 | 0.26× | 0.26× |
| 9-byte string | 405.1 | 408.9 | 2,377.3 | 185.4 | 0.45× | 0.46× |
| 32-byte string | 411.2 | 412.8 | 2,412.4 | 428.8 | 1.04× | 1.04× |
| Acquire, borrow, drop | 42.0 | 244.1 | 4,122.9 | 117.5 | 0.48× | 2.80× |
| Optional resource, half present | 31.3 | 164.0 | 3,060.9 | 128.9 | 0.79× | 4.12× |
| 121 KiB host-to-guest byte list | 4,541.0 | 4,687.5 | 8,203.1 | 4,736.3 | 1.01× | 1.04× |
| 121 KiB guest-to-host byte list | 92,675.8 | 93,115.2 | 96,044.9 | 93,310.5 | 1.00× | 1.01× |
| 16-byte UTF-8 result, repeated ASCII | 1,638.8 | 1,525.9 | 3,720.1 | 311.3 | 0.20× | 0.19× |
| 16-byte UTF-8 result, rotating Unicode | 1,626.6 | 1,672.4 | 4,361.0 | 912.5 | 0.55× | 0.56× |
| 16 KiB UTF-8 result, repeated ASCII | 32,031.3 | 33,789.1 | 49,316.4 | 16,601.6 | 0.49× | 0.52× |
| 16 KiB UTF-8 result, rotating Unicode | 42,187.5 | 41,503.9 | 72,851.6 | 28,515.6 | 0.69× | 0.68× |

![Time per guest iteration relative to Jco 1.13.0, by import and transfer direction](web/bench/results/import-loop-runtime.png)

### Where the canvas read spends its time

The same-page comparison was repeated with a clock around the demo’s host method. That method reads 176 × 176 pixels from Chromium and creates a JavaScript byte array. The remainder includes guest allocation and freeing, the copy into Wasm, binding checks, the loop and observer overhead. Each cell is a median across 9 page medians. Columns are summarized independently. [Raw instrumented samples](web/bench/results/canvas-control-browser.json)

| Guest | Bindings | Full read (µs) | Inside host (µs) | Remainder (µs) | Inside host (%) |
| --- | --- | --- | --- | --- | --- |
| C | 1.13.0 | 340.1 | 326.3 | 13.4 | 96.1% |
| C | Candidate | 341.4 | 327.1 | 14.5 | 95.9% |
| C++ | 1.13.0 | 341.0 | 326.4 | 13.6 | 96.1% |
| C++ | Candidate | 326.7 | 312.7 | 13.2 | 95.9% |
| Rust | 1.13.0 | 328.6 | 312.7 | 14.8 | 95.9% |
| Rust | Candidate | 329.2 | 315.9 | 13.2 | 96.1% |

The host accounted for 95.9–96.1% of the full read across these builds. The candidate spent 13.2–14.5 µs per read outside the host, compared with 13.4–14.8 µs for 1.13.0.

### Canvas pixel transfers with the same guest binary

Each call transfers a 176 × 176 RGBA region (123,904 bytes). The original browser host copies the pixel array on both read and write. The alternate host creates a typed-array view over the browser’s readback or the binding’s write snapshot, preserving its offset and length. All four implementations still copy the bytes across the Wasm boundary. [View adapter](web/bench/canvas-host.mjs) · [Direct shim](web/bench/dom-core-shim.mjs)

For each guest, all four bindings use identical core Wasm. Each table cell is the median of 9 page medians, with one warm-up and 4 measured passes per page. The runner rotates the four bindings on each page, alternates the host order and checks every pixel on both canvases after each invocation. [Raw timings and pixel checks](web/bench/results/canvas-host.json)

Changing the host reduced the candidate’s read time by **41–47%** and write time by **55–60%**. With the view adapter, its six timings were **0.99–1.04×** the corresponding direct shim times. The headline benchmarks use the original host.

![Canvas read and write times for the candidate with both hosts and the direct shim with pixel views](web/bench/results/canvas-host-runtime.png)

| Guest | Bindings | Original read (µs) | View read (µs) | Original write (µs) | View write (µs) |
| --- | --- | --- | --- | --- | --- |
| C | Direct shim | 353.1 | 176.8 | 241.8 | 101.2 |
| C | 1.13.0 | 333.9 | 185.6 | 247.3 | 105.1 |
| C | Stock main | 335.4 | 206.6 | 307.1 | 236.4 |
| C | Candidate | 339.5 | 184.2 | 235.8 | 104.6 |
| C++ | Direct shim | 315.1 | 186.2 | 232.9 | 101.9 |
| C++ | 1.13.0 | 351.2 | 178.3 | 233.6 | 101.1 |
| C++ | Stock main | 339.6 | 195.4 | 337.9 | 178.7 |
| C++ | Candidate | 315.4 | 185.1 | 222.7 | 100.8 |
| Rust | Direct shim | 320.2 | 180.2 | 253.5 | 98.0 |
| Rust | 1.13.0 | 336.4 | 176.1 | 242.2 | 105.5 |
| Rust | Stock main | 348.6 | 202.3 | 300.4 | 138.3 |
| Rust | Candidate | 334.5 | 178.8 | 256.6 | 102.0 |

<details><summary>All timed phases and string lengths</summary>

| Demo | Phase | Guest | Candidate time | Fresh-page / 1.13.0 | Same-page / 1.13.0 | Candidate / main | Fastest shim | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| attribute-churn | total time | C | 50.63 ms | 0.47× | 0.49× | 0.16× | Embind | 0.54× |
| attribute-churn | total time | C++ | 49.93 ms | 0.46× | 0.50× | 0.16× | Embind | 0.54× |
| attribute-churn | total time | Rust | 67.50 ms | 0.57× | 0.56× | 0.19× | Embind | 0.73× |
| attribute-churn | per setAttribute() | C | 0.63 µs | 0.47× | 0.49× | 0.16× | Embind | 0.54× |
| attribute-churn | per setAttribute() | C++ | 0.62 µs | 0.46× | 0.50× | 0.16× | Embind | 0.54× |
| attribute-churn | per setAttribute() | Rust | 0.84 µs | 0.57× | 0.56× | 0.19× | Embind | 0.73× |
| canvas-draw | total | C | 55.37 ms | 1.01× | 0.93× | 0.31× | Embind | 0.58× |
| canvas-draw | total | C++ | 51.10 ms | 0.91× | 0.92× | 0.29× | Embind | 0.53× |
| canvas-draw | total | Rust | 50.38 ms | 0.99× | 0.93× | 0.26× | Embind | 0.52× |
| canvas-draw | per fill_rect() | C | 1.11 µs | 1.01× | 0.93× | 0.31× | Embind | 0.58× |
| canvas-draw | per fill_rect() | C++ | 1.02 µs | 0.91× | 0.92× | 0.29× | Embind | 0.53× |
| canvas-draw | per fill_rect() | Rust | 1.01 µs | 0.99× | 0.93× | 0.26× | Embind | 0.53× |
| canvas-pixels | getImageData(): µs/call | C | 330.20 µs | 0.96× | 1.06× | 0.99× | Embind | 1.55× |
| canvas-pixels | getImageData(): µs/call | C++ | 323.00 µs | 0.92× | 0.98× | 0.91× | Embind | 1.52× |
| canvas-pixels | getImageData(): µs/call | Rust | 288.40 µs | 0.89× | 0.98× | 0.75× | Embind | 1.35× |
| canvas-pixels | putImageData(): µs/call | C | 263.10 µs | 1.06× | 1.01× | 0.81× | Embind | 1.21× |
| canvas-pixels | putImageData(): µs/call | C++ | 261.40 µs | 0.93× | 1.01× | 0.89× | Embind | 1.20× |
| canvas-pixels | putImageData(): µs/call | Rust | 243.80 µs | 0.77× | 0.93× | 0.79× | Embind | 1.12× |
| dom-query | individual: total ms | C | 21.47 ms | 0.97× | 0.63× | 0.19× | Embind | 0.88× |
| dom-query | individual: total ms | C++ | 20.45 ms | 0.75× | 0.65× | 0.21× | Embind | 0.84× |
| dom-query | individual: total ms | Rust | 15.12 ms | 0.64× | 0.65× | 0.16× | Embind | 0.62× |
| dom-query | bulk: total ms | C | 10.78 ms | 1.08× | 0.83× | 0.57× | Embind | 431.20× |
| dom-query | bulk: total ms | C++ | 10.96 ms | 0.88× | 0.79× | 0.65× | Embind | 438.20× |
| dom-query | bulk: total ms | Rust | 8.37 ms | 0.71× | 0.73× | 0.56× | Embind | 334.60× |
| dom-query | individual: µs/element | C | 1.07 µs | 0.96× | 0.63× | 0.19× | Embind | 0.88× |
| dom-query | individual: µs/element | C++ | 1.02 µs | 0.75× | 0.65× | 0.21× | Embind | 0.84× |
| dom-query | individual: µs/element | Rust | 0.76 µs | 0.65× | 0.65× | 0.16× | Embind | 0.62× |
| dom-traversal | build | C | 45.20 ms | 0.86× | 0.75× | 0.22× | EM_JS | 2.50× |
| dom-traversal | build | C++ | 45.13 ms | 0.94× | 0.84× | 0.22× | EM_JS | 2.50× |
| dom-traversal | build | Rust | 41.54 ms | 0.89× | 0.85× | 0.20× | EM_JS | 2.30× |
| dom-traversal | traverse (total) | C | 13.25 ms | 1.13× | 0.79× | 0.14× | EM_JS | 3.24× |
| dom-traversal | traverse (total) | C++ | 15.38 ms | 1.22× | 0.80× | 0.15× | EM_JS | 3.76× |
| dom-traversal | traverse (total) | Rust | 15.82 ms | 1.02× | 0.62× | 0.14× | EM_JS | 3.87× |
| dom-traversal | traverse (per node) | C | 0.68 µs | 1.13× | 0.80× | 0.14× | EM_JS | 3.23× |
| dom-traversal | traverse (per node) | C++ | 0.79 µs | 1.23× | 0.80× | 0.15× | EM_JS | 3.75× |
| dom-traversal | traverse (per node) | Rust | 0.81 µs | 1.02× | 0.62× | 0.14× | EM_JS | 3.86× |
| string-marshalling | set 8 B | C | 0.35 µs | 0.42× | 0.67× | 0.12× | EM_JS | 1.16× |
| string-marshalling | set 8 B | C++ | 0.37 µs | 0.44× | 0.66× | 0.11× | EM_JS | 1.20× |
| string-marshalling | set 8 B | Rust | 0.42 µs | 0.38× | 0.65× | 0.15× | EM_JS | 1.39× |
| string-marshalling | get 8 B | C | 0.55 µs | 0.24× | 0.26× | 0.10× | EM_JS | 2.87× |
| string-marshalling | get 8 B | C++ | 0.49 µs | 0.22× | 0.24× | 0.10× | EM_JS | 2.58× |
| string-marshalling | get 8 B | Rust | 0.51 µs | 0.23× | 0.24× | 0.10× | EM_JS | 2.68× |
| string-marshalling | set 128 B | C | 0.59 µs | 0.71× | 0.87× | 0.16× | wasm-bindgen | 1.06× |
| string-marshalling | set 128 B | C++ | 0.57 µs | 0.59× | 0.92× | 0.14× | wasm-bindgen | 1.03× |
| string-marshalling | set 128 B | Rust | 0.64 µs | 0.71× | 0.90× | 0.17× | wasm-bindgen | 1.14× |
| string-marshalling | get 128 B | C | 1.72 µs | 0.76× | 0.67× | 0.37× | wasm-bindgen | 1.97× |
| string-marshalling | get 128 B | C++ | 1.73 µs | 0.74× | 0.79× | 0.35× | wasm-bindgen | 1.99× |
| string-marshalling | get 128 B | Rust | 1.88 µs | 0.82× | 0.76× | 0.39× | wasm-bindgen | 2.16× |
| string-marshalling | set 1024 B | C | 0.99 µs | 0.88× | 1.01× | 0.28× | wasm-bindgen | 1.08× |
| string-marshalling | set 1024 B | C++ | 0.91 µs | 0.79× | 0.96× | 0.25× | wasm-bindgen | 1.00× |
| string-marshalling | set 1024 B | Rust | 0.98 µs | 0.90× | 0.94× | 0.29× | wasm-bindgen | 1.07× |
| string-marshalling | get 1024 B | C | 2.04 µs | 0.38× | 0.45× | 0.31× | wasm-bindgen | 0.35× |
| string-marshalling | get 1024 B | C++ | 2.01 µs | 0.29× | 0.40× | 0.27× | wasm-bindgen | 0.34× |
| string-marshalling | get 1024 B | Rust | 2.06 µs | 0.39× | 0.45× | 0.28× | wasm-bindgen | 0.35× |
| string-marshalling | set 16384 B | C | 6.99 µs | 1.01× | 1.00× | 0.71× | wasm-bindgen | 0.99× |
| string-marshalling | set 16384 B | C++ | 6.41 µs | 0.88× | 1.00× | 0.65× | wasm-bindgen | 0.91× |
| string-marshalling | set 16384 B | Rust | 7.36 µs | 1.07× | 1.00× | 0.71× | wasm-bindgen | 1.04× |
| string-marshalling | get 16384 B | C | 18.34 µs | 0.38× | 0.54× | 0.33× | wasm-bindgen | 0.21× |
| string-marshalling | get 16384 B | C++ | 17.40 µs | 0.48× | 0.50× | 0.31× | wasm-bindgen | 0.20× |
| string-marshalling | get 16384 B | Rust | 18.64 µs | 0.32× | 0.55× | 0.33× | wasm-bindgen | 0.21× |
| string-marshalling | set 262144 B | C | 105.65 µs | 0.42× | 0.72× | 0.39× | Embind | 0.90× |
| string-marshalling | set 262144 B | C++ | 101.45 µs | 0.39× | 0.73× | 0.39× | Embind | 0.86× |
| string-marshalling | set 262144 B | Rust | 114.60 µs | 0.45× | 0.96× | 0.41× | Embind | 0.98× |
| string-marshalling | get 262144 B | C | 271.85 µs | 0.28× | 0.29× | 0.35× | wasm-bindgen | 0.20× |
| string-marshalling | get 262144 B | C++ | 261.85 µs | 0.28× | 0.30× | 0.35× | wasm-bindgen | 0.20× |
| string-marshalling | get 262144 B | Rust | 283.85 µs | 0.31× | 0.29× | 0.35× | wasm-bindgen | 0.21× |
| table-update | create: total ms | C | 13.73 ms | 0.92× | 0.91× | 0.20× | EM_JS | 2.71× |
| table-update | create: total ms | C++ | 12.65 ms | 0.91× | 0.99× | 0.18× | EM_JS | 2.50× |
| table-update | create: total ms | Rust | 12.90 ms | 0.91× | 0.93× | 0.19× | EM_JS | 2.55× |
| table-update | create: µs/row | C | 6.87 µs | 0.92× | 0.91× | 0.20× | EM_JS | 2.71× |
| table-update | create: µs/row | C++ | 6.33 µs | 0.91× | 0.99× | 0.18× | EM_JS | 2.50× |
| table-update | create: µs/row | Rust | 6.45 µs | 0.91× | 0.93× | 0.19× | EM_JS | 2.55× |
| table-update | update (selected): total ms | C | 0.92 ms | 0.88× | 0.82× | 0.25× | wasm-bindgen | 1.14× |
| table-update | update (selected): total ms | C++ | 1.01 ms | 0.91× | 0.90× | 0.31× | wasm-bindgen | 1.27× |
| table-update | update (selected): total ms | Rust | 0.95 ms | 0.94× | 0.83× | 0.32× | wasm-bindgen | 1.19× |
| table-update | update (selected): µs/row | C | 0.46 µs | 0.87× | 0.82× | 0.25× | wasm-bindgen | 1.14× |
| table-update | update (selected): µs/row | C++ | 0.51 µs | 0.92× | 0.89× | 0.31× | wasm-bindgen | 1.27× |
| table-update | update (selected): µs/row | Rust | 0.47 µs | 0.94× | 0.83× | 0.32× | wasm-bindgen | 1.19× |
| table-update | clear (unselected): total ms | C | 3.45 ms | 0.86× | 0.78× | 0.19× | wasm-bindgen | 1.73× |
| table-update | clear (unselected): total ms | C++ | 3.08 ms | 0.68× | 0.82× | 0.16× | wasm-bindgen | 1.54× |
| table-update | clear (unselected): total ms | Rust | 3.11 ms | 0.80× | 0.79× | 0.20× | wasm-bindgen | 1.56× |
| table-update | clear (unselected): µs/row | C | 1.73 µs | 0.86× | 0.78× | 0.19× | wasm-bindgen | 1.73× |
| table-update | clear (unselected): µs/row | C++ | 1.54 µs | 0.68× | 0.82× | 0.16× | wasm-bindgen | 1.54× |
| table-update | clear (unselected): µs/row | Rust | 1.55 µs | 0.80× | 0.79× | 0.20× | wasm-bindgen | 1.56× |

</details>

### Payload and startup

Payload medians cover 34 component inputs. Compression is per file. Startup is the median of the 21 per-workload and guest medians, from dynamic import through initialization, with browser caching disabled.

| Build | JS (KiB) | Core Wasm (KiB) | Total (KiB) | Gzip (KiB) | Brotli (KiB) | Startup (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 | 19.4 | 64.4 | 85.4 | 29.3 | 24.1 | 10.58 |
| Stock main | 183.9 | 64.4 | 255.2 | 58.2 | 48.3 | 25.12 |
| Candidate | 135.9 | 64.4 | 203.4 | 50.8 | 42.3 | 20.50 |

### What ships with `--minify`

Each Jco build generated its default and minified distribution from the same 34 components. Jco 1.13.0 uses Terser for its minify option. Stock main and the branch use Oxc. All external Wasm files matched byte for byte across formats. Payloads include JavaScript and external Wasm, compressed per file. Chromium interleaved the six distributions across 630 fresh pages, with 5 rounds for each of the 21 guest and workload combinations. The two ratio columns compare each format to that build’s default for the same guest and workload, then take the median of the 21 ratios. The final column compares workload times to the same format of 1.13.0. [Distribution sizes](web/bench/results/minified-sizes.json) · [Timings and resource requests](web/bench/results/minified-browser.json)

| Distribution | JS (KiB) | Total gzip (KiB) | Total Brotli (KiB) | Startup (ms) | Startup / default | Runtime / default | At or below 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 default | 19.4 | 29.3 | 24.1 | 10.42 | 1.00× | 1.00× | 21/21 |
| 1.13.0 minified | 8.7 | 28.8 | 23.7 | 10.23 | 0.97× | 0.95× | 21/21 |
| Stock main default | 183.9 | 58.2 | 48.3 | 25.21 | 1.00× | 1.00× | 4/21 |
| Stock main minified | 106.9 | 51.2 | 43.2 | 23.22 | 0.94× | 0.99× | 0/21 |
| Candidate default | 135.9 | 50.8 | 42.3 | 20.64 | 1.00× | 1.00× | 15/21 |
| Candidate minified | 75.5 | 45.2 | 38.3 | 18.44 | 0.92× | 1.05× | 15/21 |

Chromium’s Resource Timing entries give four consecutive intervals from the start of dynamic import until the module is ready. The gap before the first Wasm request includes resolving dependencies and executing JavaScript. The local server served uncompressed assets with caching disabled. Browser response-body sizes were checked against the generated file sizes. Each column reports its own median over workload medians.

| Distribution | Import to JS response end (ms) | JS response end to first Wasm request (ms) | First Wasm request to last Wasm response (ms) | Last Wasm response to ready (ms) |
| --- | --- | --- | --- | --- |
| 1.13.0 default | 2.24 | 3.15 | 2.39 | 2.83 |
| 1.13.0 minified | 2.13 | 2.81 | 2.27 | 2.87 |
| Stock main default | 2.41 | 15.86 | 2.37 | 4.12 |
| Stock main minified | 2.36 | 14.25 | 2.37 | 4.08 |
| Candidate default | 2.37 | 11.83 | 2.33 | 3.94 |
| Candidate minified | 2.28 | 10.12 | 2.35 | 3.94 |

Minifying the branch reduced startup by 8% on the median same-workload comparison. Its median import-to-ready time was 18.44 ms, compared with 10.23 ms for minified 1.13.0. Between the end of the entry JavaScript response and the first Wasm request, the corresponding medians were 10.12 and 2.81 ms.

![Default and minified gzip payloads and fresh-page startup for three Jco builds](web/bench/results/minified-startup.png)

### Startup with DevTools disconnected

In 1,470 fresh documents, the page timed its own dynamic import, ran the guest and sent the result to a local server. One browser kept the Puppeteer DevTools connection open. The other disconnected before the first measured navigation. Both navigated the same tab, with matching Chrome flags, no-store responses and verified network transfers. The order of the two browsers alternated over 5 rounds. Each table cell is the median of the 21 workload medians. [Observer timings](web/bench/results/startup-observer.json)

| Distribution | Attached startup (ms) | Detached startup (ms) | Attached JS end to Wasm request (ms) | Detached JS end to Wasm request (ms) |
| --- | --- | --- | --- | --- |
| 1.13.0 default | 8.41 | 6.07 | 3.01 | 1.71 |
| 1.13.0 minified | 7.84 | 6.00 | 2.53 | 1.66 |
| Stock main default | 22.10 | 14.42 | 14.82 | 8.39 |
| Stock main minified | 19.92 | 13.31 | 12.94 | 7.89 |
| Candidate default | 17.29 | 12.01 | 11.12 | 6.14 |
| Candidate minified | 16.18 | 11.18 | 9.44 | 5.80 |
| Previous branch default | 18.40 | 12.27 | 11.27 | 6.71 |

With DevTools disconnected, default-output startup took **0.99×** the previous revision’s time. The candidate was faster in 12/21 workloads. Each workload contributes its median within-round time ratio.

### Generated JavaScript reached by each demo

Chromium recorded block coverage on 126 fresh pages in a separate run. One page imported each module and finished initialization. A second also ran the demo once and checked its output. The table reports medians over the 21 guest and workload combinations. Sizes count UTF-8 bytes in V8’s covered source ranges. A demo can leave error handling, shutdown or other supported operations unexercised. [Per-module coverage and hashes](web/bench/results/js-coverage.json)

| Build | Reached at init (KiB) | Reached through first run (KiB) | Share through first run | Unreached through first run (KiB) |
| --- | --- | --- | --- | --- |
| 1.13.0 | 4.8 | 16.3 | 76.6% | 5.0 |
| Stock main | 54.6 | 97.4 | 50.9% | 93.3 |
| Candidate | 39.0 | 63.3 | 45.8% | 75.1 |

V8 also identified the functions that define the candidate’s shared runtime classes. Each row counts the function and its nested methods in the generated JavaScript. Reached bytes come from V8 block coverage on the same pages. The values are medians across modules containing that function.

| Runtime class | Modules | Emitted (KiB) | Reached at init (KiB) | Through first run (KiB) | Unreached through first run (KiB) |
| --- | --- | --- | --- | --- | --- |
| `AsyncTask` | 21 | 26.0 | 5.9 | 7.4 | 18.5 |
| `ComponentAsyncState` | 21 | 18.6 | 1.9 | 2.9 | 15.7 |
| `AsyncThread` | 21 | 3.6 | 0.9 | 0.9 | 2.8 |
| `RepTable` | 21 | 3.0 | 1.1 | 1.4 | 1.7 |

<details><summary>Candidate startup, variation and paired comparison to 1.13.0</summary>

The paired ratio divides the candidate time by the 1.13.0 time within each round, then takes the median. The final column counts rounds where the candidate was at least as fast.

| Operation | Guest | Startup median (ms) | Warm phase p25 | Warm phase p50 | Warm phase p75 | Phase unit | Paired ratio to 1.13.0 | Rounds at or below 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | 19.58 | 0.49 | 0.63 | 0.66 | µs | 0.46× | 7/7 |
| Attribute write | C++ | 20.11 | 0.57 | 0.62 | 0.71 | µs | 0.49× | 7/7 |
| Attribute write | Rust | 18.72 | 0.79 | 0.84 | 0.89 | µs | 0.59× | 7/7 |
| Canvas fillRect | C | 21.03 | 0.93 | 1.11 | 1.17 | µs | 1.02× | 3/7 |
| Canvas fillRect | C++ | 21.06 | 0.98 | 1.02 | 1.11 | µs | 0.98× | 5/7 |
| Canvas fillRect | Rust | 17.29 | 0.89 | 1.01 | 1.06 | µs | 1.00× | 4/7 |
| Canvas pixel read | C | 21.23 | 302.40 | 330.20 | 332.90 | µs | 0.94× | 5/7 |
| Canvas pixel read | C++ | 21.33 | 255.30 | 323.00 | 328.85 | µs | 1.02× | 3/7 |
| Canvas pixel read | Rust | 21.06 | 280.75 | 288.40 | 324.30 | µs | 0.83× | 6/7 |
| DOM ID lookup | C | 22.30 | 0.97 | 1.07 | 1.16 | µs | 0.93× | 4/7 |
| DOM ID lookup | C++ | 19.48 | 0.84 | 1.02 | 1.21 | µs | 0.75× | 5/7 |
| DOM ID lookup | Rust | 20.18 | 0.74 | 0.76 | 0.82 | µs | 0.71× | 7/7 |
| Tree traversal | C | 22.92 | 12.71 | 13.25 | 14.12 | ms | 1.05× | 3/7 |
| Tree traversal | C++ | 19.72 | 14.26 | 15.38 | 16.06 | ms | 1.25× | 1/7 |
| Tree traversal | Rust | 20.87 | 15.00 | 15.82 | 16.86 | ms | 1.00× | 2/7 |
| Read 1 KiB string | C | 19.14 | 1.89 | 2.04 | 2.08 | µs | 0.39× | 7/7 |
| Read 1 KiB string | C++ | 17.68 | 1.88 | 2.01 | 2.04 | µs | 0.29× | 7/7 |
| Read 1 KiB string | Rust | 18.85 | 1.81 | 2.06 | 2.10 | µs | 0.34× | 7/7 |
| Table creation | C | 20.50 | 12.64 | 13.73 | 14.06 | ms | 0.89× | 4/7 |
| Table creation | C++ | 22.11 | 11.97 | 12.65 | 13.09 | ms | 0.91× | 6/7 |
| Table creation | Rust | 20.75 | 11.51 | 12.90 | 14.24 | ms | 0.91× | 6/7 |

</details>

[Raw browser timings](web/bench/results/candidate-browser.json) · [File sizes, digests and generator revision](web/bench/results/candidate-sizes.json)

### Reproduce the candidate run

Run the dependency installation, main setup and size commands in [Reproduce the comparison](#reproduce-the-comparison), then run the following from the repository root. Cargo uses the Jco checkout’s pinned toolchain and lockfile.

```sh
git clone https://github.com/vados-cosmonic/jco ../jco-candidate
git -C ../jco-candidate checkout 460032a40aaa3c56d5846614c04c4903e8bc0dea
node web/bench/candidate.mjs ../jco-candidate
git -C ../jco-candidate worktree add --detach ../jco-reference a079ad6dace2af014cf63554e9b9cfef4291c363
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
CHROME_BIN=/path/to/chrome BENCH_MINIFIED=1 ROUNDS=5 node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome ROUNDS=5 node web/bench/startup-observer.mjs
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
  test/sync-host-import.ts test/p3/canonical-abi-traps.ts test/p3/task-return-memory.ts \
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

Across the seven operations below and three guest languages, main took longer in **20 of 21** median comparisons. The highest ratio was **8.24×** for the C guest in `dom-traversal`.

For 256 KiB string reads, the median time on main changed by -19% to -10% across the three guest languages. The phase tables below include every tested string size.

Each cell is the median of 7 fresh-page samples. The chart divides main’s median time by 1.13.0’s for the same guest and operation. A value below 1× means main finished faster.

![Median time on main divided by baseline time for seven operations and three guest languages](web/bench/results/runtime.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 0.241 | 1.16 | — | — | 1.34 | 3.93 | 1.34 | 3.96 | 1.47 | 4.47 |
| Canvas fillRect (µs) | 0.845 | 1.92 | — | — | 1.10 | 3.63 | 1.12 | 3.50 | 1.02 | 3.85 |
| Canvas pixel read (µs) | 174.40 | 213.00 | — | — | 345.20 | 334.00 | 350.30 | 354.20 | 322.80 | 383.30 |
| DOM ID lookup (µs) | 0.281 | 1.22 | — | — | 1.11 | 5.67 | 1.36 | 4.93 | 1.17 | 4.85 |
| Tree traversal (ms) | 0.845 | 22.84 | 4.09 | 6.15 | 11.72 | 96.56 | 12.56 | 101.75 | 15.53 | 110.10 |
| Read 1 KiB string (µs) | 0.099 | 11.42 | 10.01 | 5.84 | 5.32 | 6.56 | 6.90 | 7.41 | 5.30 | 7.30 |
| Table creation (ms) | 3.93 | 16.67 | 5.06 | 8.79 | 14.96 | 68.33 | 13.91 | 71.16 | 14.21 | 68.96 |

Embind and EM_JS are the C++ Emscripten variants. An em dash marks an unavailable combination. Across toolchains, the upstream implementations can do different amounts of work. For example, the JavaScript bulk DOM query obtains a live collection while the component host materializes a list.

<details><summary>Run-to-run variation for the two jco versions</summary>

Each cell spans the 25th to 75th percentile of measured times, using linear interpolation between sorted samples.

| Operation | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 1.30–1.38 | 3.77–4.12 | 1.29–1.43 | 3.63–4.21 | 1.42–1.50 | 4.40–4.60 |
| Canvas fillRect (µs) | 0.948–1.15 | 3.43–3.74 | 1.03–1.16 | 3.35–3.95 | 0.958–1.06 | 3.54–3.92 |
| Canvas pixel read (µs) | 316.85–365.40 | 326.10–373.20 | 305.25–361.85 | 344.05–373.85 | 294.60–584.30 | 366.60–384.40 |
| DOM ID lookup (µs) | 0.944–1.34 | 5.42–6.19 | 1.18–1.44 | 4.73–5.51 | 1.09–1.19 | 4.58–4.94 |
| Tree traversal (ms) | 11.46–15.44 | 87.31–101.15 | 12.24–13.08 | 94.48–107.13 | 14.45–16.50 | 109.70–123.38 |
| Read 1 KiB string (µs) | 4.02–14.97 | 6.47–8.08 | 4.21–13.51 | 7.14–9.27 | 4.29–15.94 | 6.92–7.52 |
| Table creation (ms) | 11.34–16.01 | 65.63–72.27 | 13.46–14.44 | 66.84–71.40 | 12.98–15.74 | 64.45–70.05 |

</details>

<details><summary>All workload phases, per-call timings, and string transfer rates</summary>

Times come from the tables rendered by the demos and retain their original reporting precision. Effective string throughput uses the ASCII payload length divided by median call time (decimal MB/s).

**attribute-churn**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total time (ms) | 19.28 | 93.08 | — | — | 107.02 | 314.25 | 107.47 | 316.95 | 117.78 | 357.27 |
| per setAttribute() (µs) | 0.241 | 1.16 | — | — | 1.34 | 3.93 | 1.34 | 3.96 | 1.47 | 4.47 |

**canvas-draw**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total (ms) | 42.23 | 95.98 | — | — | 54.95 | 181.46 | 56.23 | 174.94 | 50.86 | 192.63 |
| per fill_rect() (µs) | 0.845 | 1.92 | — | — | 1.10 | 3.63 | 1.12 | 3.50 | 1.02 | 3.85 |

**canvas-pixels**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| getImageData() (µs) | 174.40 | 213.00 | — | — | 345.20 | 334.00 | 350.30 | 354.20 | 322.80 | 383.30 |
| putImageData() (µs) | 13.90 | 217.20 | — | — | 248.90 | 325.40 | 281.10 | 293.30 | 314.90 | 309.30 |

**dom-query**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| individual, total (ms) | 5.62 | 24.40 | — | — | 22.24 | 113.29 | 27.16 | 98.64 | 23.45 | 96.92 |
| bulk, total (ms) | 0.01 | 0.025 | — | — | 9.98 | 19.07 | 12.52 | 16.84 | 11.78 | 15.02 |
| individual: µs/element (µs) | 0.281 | 1.22 | — | — | 1.11 | 5.67 | 1.36 | 4.93 | 1.17 | 4.85 |

**dom-traversal**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| build (ms) | 11.18 | 37.24 | 18.05 | 25.18 | 52.58 | 206.85 | 48.03 | 203.31 | 46.69 | 207.82 |
| traverse (total) (ms) | 0.845 | 22.84 | 4.09 | 6.15 | 11.72 | 96.56 | 12.56 | 101.75 | 15.53 | 110.10 |
| traverse (per node) (µs) | 0.043 | 1.17 | 0.21 | 0.315 | 0.6 | 4.94 | 0.643 | 5.21 | 0.795 | 5.64 |

**string-marshalling**

![Median DOM textContent set and get latency by payload length for each guest and jco version, on logarithmic axes](web/bench/results/strings.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| set 8 B (µs) | 0.171 | 0.803 | 0.305 | 0.504 | 0.834 | 2.98 | 0.838 | 3.21 | 1.12 | 2.88 |
| set 8 B (MB/s) | 46.78 | 9.96 | 26.23 | 15.87 | 9.59 | 2.69 | 9.55 | 2.49 | 7.11 | 2.78 |
| get 8 B (µs) | 0.083 | 0.983 | 0.191 | 0.226 | 2.29 | 5.51 | 2.21 | 5.08 | 2.27 | 5.31 |
| get 8 B (MB/s) | 96.39 | 8.14 | 41.88 | 35.40 | 3.49 | 1.45 | 3.62 | 1.57 | 3.53 | 1.51 |
| set 128 B (µs) | 0.296 | 1.10 | 0.821 | 0.557 | 0.828 | 3.63 | 0.966 | 4.08 | 0.89 | 3.67 |
| set 128 B (MB/s) | 432.43 | 116.36 | 155.91 | 229.80 | 154.59 | 35.28 | 132.51 | 31.41 | 143.82 | 34.83 |
| get 128 B (µs) | 0.08 | 2.18 | 1.43 | 0.87 | 2.27 | 4.64 | 2.33 | 4.95 | 2.29 | 4.80 |
| get 128 B (MB/s) | 1,600.00 | 58.72 | 89.70 | 147.13 | 56.34 | 27.58 | 54.94 | 25.87 | 55.77 | 26.67 |
| set 1024 B (µs) | 0.942 | 1.49 | 2.58 | 0.911 | 1.13 | 3.53 | 1.16 | 3.66 | 1.08 | 3.40 |
| set 1024 B (MB/s) | 1,087.05 | 685.87 | 396.28 | 1,124.04 | 908.61 | 290.08 | 883.52 | 280.09 | 948.15 | 300.73 |
| get 1024 B (µs) | 0.099 | 11.42 | 10.01 | 5.84 | 5.32 | 6.56 | 6.90 | 7.41 | 5.30 | 7.30 |
| get 1024 B (MB/s) | 10,343.43 | 89.70 | 102.28 | 175.37 | 192.37 | 156.19 | 148.34 | 138.21 | 193.21 | 140.27 |
| set 16384 B (µs) | 12.46 | 7.89 | 33.25 | 7.08 | 6.95 | 9.90 | 7.31 | 9.86 | 6.91 | 10.30 |
| set 16384 B (MB/s) | 1,314.82 | 2,077.08 | 492.75 | 2,315.76 | 2,357.41 | 1,655.45 | 2,242.54 | 1,662.34 | 2,372.43 | 1,590.22 |
| get 16384 B (µs) | 0.436 | 166.55 | 168.30 | 86.97 | 47.90 | 54.77 | 36.38 | 55.50 | 59.05 | 56.38 |
| get 16384 B (MB/s) | 37,577.98 | 98.37 | 97.35 | 188.38 | 342.05 | 299.11 | 450.42 | 295.21 | 277.46 | 290.63 |
| set 262144 B (µs) | 159.69 | 117.45 | 539.05 | 252.95 | 254.25 | 268.25 | 258.00 | 261.90 | 256.25 | 277.90 |
| set 262144 B (MB/s) | 1,641.61 | 2,231.96 | 486.31 | 1,036.35 | 1,031.05 | 977.24 | 1,016.06 | 1,000.93 | 1,023.00 | 943.30 |
| get 262144 B (µs) | 11.63 | 2,638.15 | 2,527.05 | 1,326.20 | 962.60 | 776.90 | 930.30 | 756.70 | 914.00 | 822.30 |
| get 262144 B (MB/s) | 22,548.08 | 99.37 | 103.74 | 197.67 | 272.33 | 337.42 | 281.78 | 346.43 | 286.81 | 318.79 |

**table-update**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create, total (ms) | 3.93 | 16.67 | 5.06 | 8.79 | 14.96 | 68.33 | 13.91 | 71.16 | 14.21 | 68.96 |
| create, per row (µs) | 1.97 | 8.34 | 2.53 | 4.40 | 7.48 | 34.17 | 6.96 | 35.58 | 7.11 | 34.48 |
| update (selected), total (ms) | 0.565 | 1.26 | 0.93 | 0.8 | 1.04 | 3.73 | 1.11 | 3.30 | 1.01 | 3.00 |
| update (selected), per row (µs) | 0.282 | 0.632 | 0.465 | 0.4 | 0.523 | 1.86 | 0.555 | 1.65 | 0.507 | 1.50 |
| clear (unselected), total (ms) | 1.78 | 4.04 | 3.34 | 2.00 | 4.03 | 18.23 | 4.53 | 19.11 | 3.90 | 15.89 |
| clear (unselected), per row (µs) | 0.893 | 2.02 | 1.67 | 0.998 | 2.02 | 9.12 | 2.27 | 9.56 | 1.95 | 7.95 |

</details>

<details><summary>Module load and initialization, median milliseconds</summary>

Elapsed browser time for dynamic import through instantiation, with the shared demo host already loaded. The browser process is reused, each page has HTTP caching disabled, and assets are served uncompressed over loopback. These timings include scheduling and local requests. JS is already loaded by the harness.

| Workload | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| attribute-churn | 13.93 | — | — | 10.58 | 25.12 | 9.83 | 24.60 | 10.75 | 22.38 |
| canvas-draw | 13.54 | — | — | 10.49 | 25.07 | 10.02 | 23.44 | 10.76 | 25.50 |
| canvas-pixels | 13.08 | — | — | 10.34 | 25.54 | 10.86 | 26.45 | 10.89 | 26.62 |
| dom-query | 14.99 | — | — | 10.18 | 25.34 | 10.98 | 26.06 | 11.88 | 24.24 |
| dom-traversal | 13.19 | 9.19 | 8.57 | 10.41 | 24.48 | 10.80 | 26.05 | 11.31 | 24.33 |
| string-marshalling | 12.84 | 8.38 | 8.12 | 9.67 | 22.82 | 9.16 | 24.05 | 9.81 | 20.26 |
| table-update | 13.74 | 8.94 | 7.95 | 11.14 | 27.16 | 9.88 | 25.19 | 11.78 | 26.10 |

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
