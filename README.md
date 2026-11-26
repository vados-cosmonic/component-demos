# Component demos

This fork benchmarks the browser examples from [eqrion/component-demos at d0b9dd1](https://github.com/eqrion/component-demos/tree/d0b9dd1390a300978193adc623838fef4e4b632b). It runs the same compiled C, C++, and Rust WebAssembly components through jco 1.13.0, pinned upstream main, and a branch that optimizes synchronous host imports. The comparison also includes the demos’ JavaScript, Emscripten (Embind and EM_JS), and Rust wasm-bindgen implementations where available.

<!-- candidate:start -->

## Optimized browser bindings

The branch uses js-component-bindgen’s internal Oxc bundler and the checked jco-cm-runtime. [Measured Jco commit `165324dda`](https://github.com/vados-cosmonic/jco/commit/165324dda277eef1407d43b80c19401c2d7de37c) · [Canvas host comparison](#canvas-pixel-transfers-with-the-same-guest-binary) · [Payload and startup](#payload-and-startup) · [First guest result](#time-to-the-first-guest-result) · [Module initialization](#direct-module-initialization) · [Eager compilation](#eager-javascript-compilation) · [Reproduction commands](#reproduce-the-candidate-run)

All Jco builds used the same guest binaries. Each value is the median of 7 fresh-page samples with one warm-up per page. The run collected 728 samples on 2026-11-26 with HeadlessChrome/156.0.8078.47 on Intel(R) Xeon(R) Processor @ 2.60GHz.

Stock main is pinned to `fdbf1ae2d`. [Upstream source](https://github.com/bytecodealliance/jco/commit/fdbf1ae2dbc9469b5c275b5686d8a4c43681618f) · [Transpiler CI build](https://github.com/bytecodealliance/jco/actions/runs/45736422241)

The candidate finished within **10× of the fastest available compiled shim in 21/21** headline comparisons. The largest ratio was **4.14×**. On separate fresh pages it matched or beat **1.13.0 in 14/21** and **stock main in 20/21**. On the same warmed page it matched or beat **1.13.0 in 19/21** headline cases and 80/84 across all phases. The shim comparison selects the lowest median among Embind, EM_JS and wasm-bindgen for each operation, including shims written in a different guest language. The phase tables in the original comparison describe workload differences and include raw JavaScript.

![Candidate runtime relative to the two targets by operation and language](web/bench/results/candidate-runtime.png)

| Operation | Guest | Unit | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Fastest shim | Shim time | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | µs | 1.32 | 3.71 | 0.55 | 0.42× | Embind | 1.31 | 0.42× |
| Attribute write | C++ | µs | 1.41 | 4.04 | 0.66 | 0.47× | Embind | 1.31 | 0.50× |
| Attribute write | Rust | µs | 1.45 | 4.28 | 0.75 | 0.52× | Embind | 1.31 | 0.57× |
| Canvas fillRect | C | µs | 0.95 | 4.07 | 0.97 | 1.03× | Embind | 1.84 | 0.53× |
| Canvas fillRect | C++ | µs | 0.99 | 4.10 | 0.89 | 0.89× | Embind | 1.84 | 0.48× |
| Canvas fillRect | Rust | µs | 1.03 | 3.59 | 1.13 | 1.09× | Embind | 1.84 | 0.61× |
| Canvas pixel read | C | µs | 292.70 | 345.30 | 349.50 | 1.19× | Embind | 210.40 | 1.66× |
| Canvas pixel read | C++ | µs | 337.70 | 327.80 | 275.90 | 0.82× | Embind | 210.40 | 1.31× |
| Canvas pixel read | Rust | µs | 335.00 | 332.20 | 325.30 | 0.97× | Embind | 210.40 | 1.55× |
| DOM ID lookup | C | µs | 1.25 | 5.75 | 0.92 | 0.73× | Embind | 1.31 | 0.70× |
| DOM ID lookup | C++ | µs | 1.29 | 5.21 | 1.20 | 0.93× | Embind | 1.31 | 0.91× |
| DOM ID lookup | Rust | µs | 1.35 | 5.04 | 0.86 | 0.64× | Embind | 1.31 | 0.66× |
| Tree traversal | C | ms | 14.54 | 111.27 | 15.01 | 1.03× | EM_JS | 4.60 | 3.26× |
| Tree traversal | C++ | ms | 14.03 | 102.94 | 15.70 | 1.12× | EM_JS | 4.60 | 3.41× |
| Tree traversal | Rust | ms | 14.81 | 114.47 | 19.05 | 1.29× | EM_JS | 4.60 | 4.14× |
| Read 1 KiB string | C | µs | 4.66 | 6.95 | 2.00 | 0.43× | wasm-bindgen | 5.69 | 0.35× |
| Read 1 KiB string | C++ | µs | 5.61 | 6.93 | 1.93 | 0.34× | wasm-bindgen | 5.69 | 0.34× |
| Read 1 KiB string | Rust | µs | 9.15 | 8.31 | 1.84 | 0.20× | wasm-bindgen | 5.69 | 0.32× |
| Table creation | C | ms | 13.39 | 76.33 | 12.27 | 0.92× | EM_JS | 6.02 | 2.04× |
| Table creation | C++ | ms | 13.79 | 71.64 | 15.23 | 1.10× | EM_JS | 6.02 | 2.53× |
| Table creation | Rust | ms | 16.02 | 65.08 | 14.34 | 0.90× | EM_JS | 6.02 | 2.38× |

Comparing implementations in the same language, the branch stayed within 10× in **13/13** available headline comparisons. Each cell divides the branch’s median by that shim’s median. A dash means the demo has no implementation for that binding. The demos supply compiled shims for C++ and Rust.

| Operation | C++ / Embind | C++ / EM_JS | Rust / wasm-bindgen |
| --- | --- | --- | --- |
| Attribute write | 0.50× | — | — |
| Canvas fillRect | 0.48× | — | — |
| Canvas pixel read | 1.31× | — | — |
| DOM ID lookup | 0.91× | — | — |
| Tree traversal | 0.69× | 3.41× | 3.63× |
| Read 1 KiB string | 0.18× | 0.18× | 0.32× |
| Table creation | 1.03× | 2.53× | 1.48× |

<details><summary>How the synchronous bindings work</summary>

Eligible single-instance, synchronous components reuse the caller’s task for host imports. The adapter keeps direct references to its task stack and instance flags and checks for store interruptions. Oxc removes the asynchronous import fallback and the subtask, waitable, and future constructors. The shutdown path skips creating the two empty stream and future tables. The generator skips asynchronous wrappers for synchronous allocators and post-return hooks. Standalone modules also omit suspension markers on core imports.

In checked standalone bindings, the Oxc linker can put a runtime initializer’s value directly where the module first declares its state. Each declaration still allocates its own maps, arrays or objects in the original order. Calls with arguments, calls inside functions and factories with more complex bodies keep their original implementation.

During a guest allocation, the checked runtime clears the instance’s may-leave flag and restores it on return or throw. Allocators in components with context-slot operations use the general guard to supply fresh slots for each call. The adapter lifts short ASCII strings four bytes at a time. Synchronous UTF-8 results of 256 to 262,144 code units can reuse a per-instance byte buffer capped at 256 KiB. The runtime encodes there before requesting the exact guest allocation. Nested calls and larger results use the ordinary encoder.

Resource drops check the instance flag and record traps. When lifting a borrowed host resource, the adapter validates the handle and reads its 32-bit representation directly. Imported host resources with automatically assigned representations use their guest handle as an array index. Explicit host representations and shared tables use a representation map. Components with async operations, cross-component resource transfers or call tracking use the general adapter.

Earlier runs measured the removal of asynchronous runtime code from synchronous components. [Subtask constructors](https://github.com/vados-cosmonic/component-demos/blob/255eca61b14b5ab63567da558b5f561149cc5163/README.md#change-from-the-previous-branch-revision) · [Future and waitable constructors](https://github.com/vados-cosmonic/component-demos/blob/c25f90d93af43e9261dff31b186d5b01115e8a0f/README.md#change-from-the-previous-branch-revision)

</details>

### Change from the previous branch revision

Both revisions ran on the same guest binaries in the same browser session. Each cell divides the candidate median by the previous revision’s median. Parentheses count the rounds in which the candidate finished faster. [Compare `460032a40` and `165324dda`](https://github.com/vados-cosmonic/jco/compare/460032a40aaa3c56d5846614c04c4903e8bc0dea...165324dda277eef1407d43b80c19401c2d7de37c)

External core Wasm files matched byte for byte for 32/32 inputs that emitted them. Across the 21 timed guest and workload combinations, the median ratio of candidate to previous startup time was 0.94×.

| Payload | Smallest saving (bytes) | Median saving (bytes) | Largest saving (bytes) | Smaller outputs |
| --- | --- | --- | --- | --- |
| JavaScript | 2,224 | 3,563 | 3,760 | 34/34 |
| Total gzip | 253 | 462 | 496 | 34/34 |
| Total Brotli | 213 | 364 | 426 | 34/34 |

Both branch revisions also ran with their default output and caching disabled. The change column takes the difference for each guest and workload first, then the median of those differences.

| Startup interval | Previous (ms) | Candidate (ms) | Median change (ms) | Faster workloads |
| --- | --- | --- | --- | --- |
| Import to ready | 21.70 | 20.24 | -1.34 | 17/21 |
| Import to JS response end | 2.47 | 2.36 | -0.14 | 14/21 |
| JS end to first Wasm request | 12.40 | 11.85 | -1.00 | 18/21 |
| First Wasm request to last Wasm response | 2.36 | 2.30 | -0.03 | 12/21 |
| Last Wasm response to ready | 4.29 | 4.03 | -0.14 | 16/21 |

| Operation | C | C++ | Rust |
| --- | --- | --- | --- |
| Attribute write | 0.94× (4/7) | 0.93× (5/7) | 0.84× (7/7) |
| Canvas fillRect | 0.83× (5/7) | 0.88× (5/7) | 0.99× (4/7) |
| Canvas pixel read | 0.98× (3/7) | 0.85× (5/7) | 0.90× (6/7) |
| DOM ID lookup | 0.98× (5/7) | 1.02× (3/7) | 1.09× (2/7) |
| Tree traversal | 0.93× (6/7) | 0.99× (4/7) | 0.91× (6/7) |
| Read 1 KiB string | 0.97× (2/7) | 0.95× (3/7) | 0.85× (5/7) |
| Table creation | 0.85× (6/7) | 1.09× (3/7) | 0.97× (4/7) |
| Bulk DOM query | 0.90× (5/7) | 0.99× (2/7) | 1.07× (4/7) |
| Tree construction | 1.02× (3/7) | 1.07× (4/7) | 0.92× (5/7) |
| set 8 B | 1.00× (3/7) | 0.86× (5/7) | 1.03× (3/7) |
| get 8 B | 0.91× (4/7) | 0.94× (4/7) | 0.81× (5/7) |
| get 128 B | 0.94× (5/7) | 0.96× (4/7) | 0.94× (4/7) |
| get 16384 B | 1.04× (1/7) | 0.94× (4/7) | 1.00× (4/7) |
| get 262144 B | 1.01× (2/7) | 0.94× (4/7) | 0.95× (4/7) |

### Warm 1.13.0 comparison on the same page

For each guest and workload, both builds run once to warm up, then 4 times each on the same page. Each pair alternates which build runs first. The runner clears the DOM and performance entries before every call. It repeats this on 9 fresh pages. Each page contributes the median of its candidate / 1.13.0 ratios. The median across pages was at or below 1× for **19/21** headline cases. [Raw paired timings](web/bench/results/paired-browser.json)

![Median paired time ratios by workload and guest, with bars spanning the middle half of page ratios](web/bench/results/paired-runtime.png)

The middle 50% describes variation between pages. The median interval uses a two-sided sign test over independent page medians at the 95% level for each phase individually. Measurements on this CPU and browser can share machine load across pages.

| Operation | Guest | Candidate / 1.13.0 | Middle 50% of page ratios | 95% median interval | Pages at or below 1× |
| --- | --- | --- | --- | --- | --- |
| Attribute write | C | 0.51× | 0.50–0.51× | 0.491–0.524× | 9/9 |
| Attribute write | C++ | 0.51× | 0.48–0.52× | 0.480–0.519× | 9/9 |
| Attribute write | Rust | 0.55× | 0.53–0.57× | 0.519–0.589× | 9/9 |
| Canvas fillRect | C | 0.92× | 0.91–0.94× | 0.910–0.968× | 8/9 |
| Canvas fillRect | C++ | 0.93× | 0.90–0.96× | 0.878–0.963× | 8/9 |
| Canvas fillRect | Rust | 0.92× | 0.90–0.96× | 0.884–0.976× | 9/9 |
| Canvas pixel read | C | 1.01× | 0.98–1.08× | 0.964–1.083× | 4/9 |
| Canvas pixel read | C++ | 1.05× | 0.98–1.19× | 0.981–1.620× | 3/9 |
| Canvas pixel read | Rust | 0.99× | 0.94–1.08× | 0.900–1.126× | 5/9 |
| DOM ID lookup | C | 0.60× | 0.57–0.71× | 0.566–0.713× | 9/9 |
| DOM ID lookup | C++ | 0.61× | 0.56–0.67× | 0.534–0.729× | 9/9 |
| DOM ID lookup | Rust | 0.64× | 0.61–0.71× | 0.565–0.714× | 9/9 |
| Tree traversal | C | 0.82× | 0.76–0.85× | 0.754–0.858× | 9/9 |
| Tree traversal | C++ | 0.75× | 0.70–0.84× | 0.688–0.884× | 9/9 |
| Tree traversal | Rust | 0.60× | 0.58–0.99× | 0.578–1.013× | 7/9 |
| Read 1 KiB string | C | 0.46× | 0.43–0.48× | 0.395–0.503× | 9/9 |
| Read 1 KiB string | C++ | 0.49× | 0.45–0.52× | 0.423–0.528× | 9/9 |
| Read 1 KiB string | Rust | 0.45× | 0.43–0.47× | 0.402–0.495× | 9/9 |
| Table creation | C | 0.90× | 0.86–0.96× | 0.838–0.958× | 9/9 |
| Table creation | C++ | 0.94× | 0.85–1.03× | 0.833–1.047× | 6/9 |
| Table creation | Rust | 0.96× | 0.93–1.01× | 0.926–1.054× | 6/9 |

Across all 84 reported phases and string lengths, the same-page comparison matched or beat 1.13.0 in **80/84** cases. The median interval lay entirely above 1× in **0/84** cases. Totals and subphases overlap.

| Slower paired phase | Guest | Metric | Candidate / 1.13.0 | 95% median interval | Pages at or below 1× |
| --- | --- | --- | --- | --- | --- |
| canvas-pixels | C++ | getImageData(): µs/call | 1.049× | 0.981–1.620× | 3/9 |
| string-marshalling | Rust | set 16384 B | 1.025× | 0.975–1.050× | 3/9 |
| canvas-pixels | C | getImageData(): µs/call | 1.010× | 0.964–1.083× | 4/9 |
| string-marshalling | Rust | set 1024 B | 1.007× | 0.820–1.054× | 4/9 |

Across all reported phases and string lengths, 81/84 comparable candidate medians were within 10× of the fastest compiled shim and 64/84 matched or beat 1.13.0. Totals and their subphases overlap. Each ratio compares the same phase on both sides.

| Phases above 10× | Phase | Guest | Shim | Candidate / shim |
| --- | --- | --- | --- | --- |
| dom-query | bulk: total ms | C | Embind | 511.50× |
| dom-query | bulk: total ms | C++ | Embind | 584.00× |
| dom-query | bulk: total ms | Rust | Embind | 525.50× |

The bulk DOM query returns a live collection to Embind, which discards it. The component host materializes the collection with `Array.from`, then the bindings lower every element into a WIT resource handle. The ratio includes that difference in work. [Embind loop](cpp/dom-query/emscripten/main.cpp) · [Component host](web/host/web-host.js) · [C guest loop](c/dom-query/main.c)

### DOM bindings with identical guest code

These 216 fresh-page samples compare each language’s exact core Wasm binary with each set of bindings in the table. The direct JS shim calls the same DOM host, puts owned handles in guest memory and recycles them on guest drops. It implements the synchronous imports used by these guests. Jco also provides Canonical ABI checks, task tracking and instance shutdown. [Direct shim](web/bench/dom-core-shim.mjs) · [Raw timings and correctness checks](web/bench/results/dom-control-browser.json)

The bulk query copies 2,000 handles per call, 10 times. Each traversal visits 19,531 nodes. The runner checks the rendered fixture or node count for each guest and verifies list counts and handle release for the direct shim after warm-up and measurement.

With list materialization on both sides, the candidate took **1.51–1.92×** the direct shim’s bulk-query time across the three guests. Times below are per measured workload, after warm-up.

![DOM phase times for Jco 1.13.0 and the candidate relative to the same-guest direct shim](web/bench/results/dom-control-runtime.png)

| Phase | Guest | Direct (ms) | 1.13.0 (ms) | Candidate (ms) | Candidate / direct | Candidate / 1.13.0 | Rounds at or below 1.13.0 | Candidate / previous | Rounds at or below previous |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DOM ID lookup | C | 16.38 | 27.52 | 18.55 | 1.13× | 0.67× | 8/9 | 1.03× | 4/9 |
| DOM ID lookup | C++ | 15.82 | 26.68 | 22.22 | 1.40× | 0.83× | 6/9 | 1.05× | 3/9 |
| DOM ID lookup | Rust | 14.02 | 22.73 | 17.70 | 1.26× | 0.78× | 9/9 | 1.01× | 2/9 |
| Bulk DOM query | C | 6.83 | 12.73 | 10.34 | 1.51× | 0.81× | 7/9 | 0.90× | 6/9 |
| Bulk DOM query | C++ | 6.42 | 11.32 | 12.34 | 1.92× | 1.09× | 3/9 | 1.03× | 4/9 |
| Bulk DOM query | Rust | 6.44 | 11.02 | 10.57 | 1.64× | 0.96× | 7/9 | 0.99× | 4/9 |
| Tree construction | C | 23.88 | 47.63 | 41.39 | 1.73× | 0.87× | 7/9 | 0.91× | 4/9 |
| Tree construction | C++ | 22.39 | 48.06 | 46.40 | 2.07× | 0.97× | 4/9 | 0.88× | 6/9 |
| Tree construction | Rust | 22.91 | 48.92 | 49.05 | 2.14× | 1.00× | 4/9 | 1.01× | 5/9 |
| Tree traversal | C | 5.94 | 15.24 | 14.47 | 2.44× | 0.95× | 6/9 | 1.09× | 6/9 |
| Tree traversal | C++ | 5.38 | 12.60 | 15.38 | 2.86× | 1.22× | 3/9 | 0.92× | 5/9 |
| Tree traversal | Rust | 7.29 | 16.70 | 17.89 | 2.45× | 1.07× | 3/9 | 0.96× | 7/9 |

On the same guest binaries, initialization took the following times before the first guest call. Each median covers 9 fresh pages and includes importing the binding module, fetching the guest and instantiating it. The direct shim uses `WebAssembly.instantiateStreaming`.

| Workload | Guest | Direct startup (ms) | 1.13.0 (ms) | Candidate (ms) | Candidate / direct | Candidate / 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- |
| ID and bulk query | C | 8.87 | 12.04 | 20.80 | 2.35× | 1.73× |
| ID and bulk query | C++ | 8.91 | 10.60 | 22.40 | 2.51× | 2.11× |
| ID and bulk query | Rust | 8.81 | 11.56 | 18.85 | 2.14× | 1.63× |
| Tree traversal | C | 8.19 | 11.36 | 21.43 | 2.62× | 1.89× |
| Tree traversal | C++ | 8.50 | 11.12 | 21.01 | 2.47× | 1.89× |
| Tree traversal | Rust | 8.89 | 10.78 | 19.50 | 2.19× | 1.81× |

### Cost of a synchronous host import

The scalar, string and resource loops run 131,072 iterations per pass. The string loop changes the first byte before each call. The resource loop acquires a host object, borrows it to read its value, and drops it. The optional-resource loop checks the discriminant in guest memory every time and reads and drops each present handle. Each pass checks its checksum. All four adapters use byte-identical core modules. The direct shim keeps the fixture’s single live handle in one slot.

The byte-list loops copy a 176 × 176 RGBA region (123,904 bytes) 2,048 times per pass in each direction. The host-to-guest case uses a reusable host view and a fixed guest allocation. In the reverse direction the host keeps the final snapshot while the guest changes the source in Wasm. Both cases sum the changing first byte during the loop and verify the whole payload afterward. The canvas demo also measures browser readback, host allocation and guest allocation.

The string-return loops make 32,768 calls per pass for 16-byte results and 1,024 for 16 KiB results. One host returns a repeated ASCII string. The other rotates four strings containing two-, three-, and four-byte UTF-8 sequences. The guest checks each byte length, sums the first bytes, and hashes every distinct result outside the timer.

Times are nanoseconds per guest iteration, including the loop and host work. Each cell is the median of 7 fresh-page medians, with 2 warm-ups and 5 timed passes per page. The runner interleaves the four builds. [Raw timings and digests](web/bench/results/import-loop.json)

| Operation | Direct | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Candidate / direct |
| --- | --- | --- | --- | --- | --- | --- |
| u32 | 14.5 | 13.0 | 1,925.7 | 16.0 | 1.24× | 1.11× |
| 2-byte string | 427.2 | 428.8 | 2,607.7 | 119.8 | 0.28× | 0.28× |
| 9-byte string | 437.9 | 431.8 | 2,538.3 | 187.7 | 0.43× | 0.43× |
| 32-byte string | 433.3 | 425.0 | 2,480.3 | 423.4 | 1.00× | 0.98× |
| Acquire, borrow, drop | 41.2 | 256.3 | 4,480.7 | 124.4 | 0.49× | 3.02× |
| Optional resource, half present | 30.5 | 187.7 | 3,202.8 | 134.3 | 0.72× | 4.40× |
| 121 KiB host-to-guest byte list | 5,078.1 | 5,078.1 | 9,082.0 | 5,419.9 | 1.07× | 1.07× |
| 121 KiB guest-to-host byte list | 98,877.0 | 101,953.1 | 104,150.4 | 100,000.0 | 0.98× | 1.01× |
| 16-byte UTF-8 result, repeated ASCII | 1,730.3 | 1,794.4 | 4,135.1 | 369.3 | 0.21× | 0.21× |
| 16-byte UTF-8 result, rotating Unicode | 1,742.6 | 1,940.9 | 4,299.9 | 933.8 | 0.48× | 0.54× |
| 16 KiB UTF-8 result, repeated ASCII | 33,789.1 | 33,007.8 | 52,734.4 | 17,480.5 | 0.53× | 0.52× |
| 16 KiB UTF-8 result, rotating Unicode | 47,363.3 | 46,093.7 | 76,953.1 | 31,347.7 | 0.68× | 0.66× |

![Time per guest iteration relative to Jco 1.13.0, by import and transfer direction](web/bench/results/import-loop-runtime.png)

### Where the canvas read spends its time

The same-page comparison was repeated with a clock around the demo’s host method. That method reads 176 × 176 pixels from Chromium and creates a JavaScript byte array. The remainder includes guest allocation and freeing, the copy into Wasm, binding checks, the loop and observer overhead. Each cell is a median across 9 page medians. Columns are summarized independently. [Raw instrumented samples](web/bench/results/canvas-control-browser.json)

| Guest | Bindings | Full read (µs) | Inside host (µs) | Remainder (µs) | Inside host (%) |
| --- | --- | --- | --- | --- | --- |
| C | 1.13.0 | 332.7 | 318.4 | 13.0 | 96.2% |
| C | Candidate | 332.5 | 319.6 | 13.1 | 96.0% |
| C++ | 1.13.0 | 361.4 | 346.9 | 13.8 | 96.0% |
| C++ | Candidate | 358.4 | 343.5 | 14.5 | 96.0% |
| Rust | 1.13.0 | 323.8 | 310.8 | 12.5 | 96.1% |
| Rust | Candidate | 322.3 | 307.9 | 14.1 | 95.8% |

The host accounted for 95.8–96.2% of the full read across these builds. The candidate spent 13.1–14.5 µs per read outside the host, compared with 12.5–13.8 µs for 1.13.0.

### Canvas pixel transfers with the same guest binary

Each call transfers a 176 × 176 RGBA region (123,904 bytes). The original browser host copies the pixel array on both read and write. The alternate host creates a typed-array view over the browser’s readback or the binding’s write snapshot, preserving its offset and length. All four implementations still copy the bytes across the Wasm boundary. [View adapter](web/bench/canvas-host.mjs) · [Direct shim](web/bench/dom-core-shim.mjs)

For each guest, all four bindings use identical core Wasm. Each table cell is the median of 9 page medians, with one warm-up and 4 measured passes per page. The runner rotates the four bindings on each page, alternates the host order and checks every pixel on both canvases after each invocation. [Raw timings and pixel checks](web/bench/results/canvas-host.json)

Changing the host reduced the candidate’s read time by **46–48%** and write time by **57–59%**. With the view adapter, its six timings were **0.85–1.04×** the corresponding direct shim times. The headline benchmarks use the original host.

![Canvas read and write times for the candidate with both hosts and the direct shim with pixel views](web/bench/results/canvas-host-runtime.png)

| Guest | Bindings | Original read (µs) | View read (µs) | Original write (µs) | View write (µs) |
| --- | --- | --- | --- | --- | --- |
| C | Direct shim | 337.3 | 177.2 | 266.9 | 100.8 |
| C | 1.13.0 | 344.7 | 178.6 | 246.2 | 111.5 |
| C | Stock main | 362.6 | 203.1 | 304.8 | 160.1 |
| C | Candidate | 335.8 | 179.6 | 246.4 | 103.1 |
| C++ | Direct shim | 331.5 | 215.1 | 270.0 | 105.2 |
| C++ | 1.13.0 | 346.1 | 170.5 | 252.5 | 93.9 |
| C++ | Stock main | 360.4 | 205.3 | 307.6 | 176.4 |
| C++ | Candidate | 351.8 | 182.3 | 249.0 | 107.1 |
| Rust | Direct shim | 349.9 | 192.8 | 258.1 | 99.8 |
| Rust | 1.13.0 | 370.1 | 180.7 | 263.9 | 103.2 |
| Rust | Stock main | 374.0 | 206.3 | 395.6 | 156.8 |
| Rust | Candidate | 333.2 | 180.9 | 255.5 | 103.5 |

<details><summary>All timed phases and string lengths</summary>

| Demo | Phase | Guest | Candidate time | Fresh-page / 1.13.0 | Same-page / 1.13.0 | Candidate / main | Fastest shim | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| attribute-churn | total time | C | 44.05 ms | 0.42× | 0.51× | 0.15× | Embind | 0.42× |
| attribute-churn | total time | C++ | 52.85 ms | 0.47× | 0.51× | 0.16× | Embind | 0.50× |
| attribute-churn | total time | Rust | 60.09 ms | 0.52× | 0.55× | 0.18× | Embind | 0.57× |
| attribute-churn | per setAttribute() | C | 0.55 µs | 0.42× | 0.51× | 0.15× | Embind | 0.42× |
| attribute-churn | per setAttribute() | C++ | 0.66 µs | 0.47× | 0.51× | 0.16× | Embind | 0.50× |
| attribute-churn | per setAttribute() | Rust | 0.75 µs | 0.52× | 0.55× | 0.18× | Embind | 0.57× |
| canvas-draw | total | C | 48.53 ms | 1.03× | 0.92× | 0.24× | Embind | 0.53× |
| canvas-draw | total | C++ | 44.24 ms | 0.89× | 0.93× | 0.22× | Embind | 0.48× |
| canvas-draw | total | Rust | 56.52 ms | 1.09× | 0.92× | 0.32× | Embind | 0.61× |
| canvas-draw | per fill_rect() | C | 0.97 µs | 1.03× | 0.92× | 0.24× | Embind | 0.53× |
| canvas-draw | per fill_rect() | C++ | 0.89 µs | 0.89× | 0.93× | 0.22× | Embind | 0.48× |
| canvas-draw | per fill_rect() | Rust | 1.13 µs | 1.09× | 0.92× | 0.31× | Embind | 0.61× |
| canvas-pixels | getImageData(): µs/call | C | 349.50 µs | 1.19× | 1.01× | 1.01× | Embind | 1.66× |
| canvas-pixels | getImageData(): µs/call | C++ | 275.90 µs | 0.82× | 1.05× | 0.84× | Embind | 1.31× |
| canvas-pixels | getImageData(): µs/call | Rust | 325.30 µs | 0.97× | 0.99× | 0.98× | Embind | 1.55× |
| canvas-pixels | putImageData(): µs/call | C | 273.80 µs | 1.09× | 0.99× | 0.90× | Embind | 1.58× |
| canvas-pixels | putImageData(): µs/call | C++ | 271.60 µs | 0.93× | 0.95× | 0.90× | Embind | 1.56× |
| canvas-pixels | putImageData(): µs/call | Rust | 275.10 µs | 0.87× | 0.91× | 0.83× | Embind | 1.58× |
| dom-query | individual: total ms | C | 18.43 ms | 0.73× | 0.60× | 0.16× | Embind | 0.70× |
| dom-query | individual: total ms | C++ | 23.91 ms | 0.93× | 0.61× | 0.23× | Embind | 0.91× |
| dom-query | individual: total ms | Rust | 17.27 ms | 0.64× | 0.64× | 0.17× | Embind | 0.66× |
| dom-query | bulk: total ms | C | 10.23 ms | 0.86× | 0.75× | 0.58× | Embind | 511.50× |
| dom-query | bulk: total ms | C++ | 11.68 ms | 0.97× | 0.77× | 0.65× | Embind | 584.00× |
| dom-query | bulk: total ms | Rust | 10.51 ms | 0.84× | 0.73× | 0.59× | Embind | 525.50× |
| dom-query | individual: µs/element | C | 0.92 µs | 0.73× | 0.60× | 0.16× | Embind | 0.70× |
| dom-query | individual: µs/element | C++ | 1.20 µs | 0.93× | 0.61× | 0.23× | Embind | 0.91× |
| dom-query | individual: µs/element | Rust | 0.86 µs | 0.64× | 0.64× | 0.17× | Embind | 0.66× |
| dom-traversal | build | C | 48.45 ms | 0.97× | 0.81× | 0.23× | EM_JS | 2.48× |
| dom-traversal | build | C++ | 52.35 ms | 1.09× | 0.74× | 0.25× | EM_JS | 2.68× |
| dom-traversal | build | Rust | 49.04 ms | 1.14× | 0.82× | 0.22× | EM_JS | 2.51× |
| dom-traversal | traverse (total) | C | 15.01 ms | 1.03× | 0.82× | 0.13× | EM_JS | 3.26× |
| dom-traversal | traverse (total) | C++ | 15.70 ms | 1.12× | 0.75× | 0.15× | EM_JS | 3.41× |
| dom-traversal | traverse (total) | Rust | 19.05 ms | 1.29× | 0.60× | 0.17× | EM_JS | 4.14× |
| dom-traversal | traverse (per node) | C | 0.77 µs | 1.03× | 0.82× | 0.13× | EM_JS | 3.27× |
| dom-traversal | traverse (per node) | C++ | 0.80 µs | 1.12× | 0.75× | 0.15× | EM_JS | 3.42× |
| dom-traversal | traverse (per node) | Rust | 0.97 µs | 1.29× | 0.60× | 0.17× | EM_JS | 4.15× |
| string-marshalling | set 8 B | C | 0.44 µs | 0.55× | 0.69× | 0.15× | EM_JS | 1.32× |
| string-marshalling | set 8 B | C++ | 0.40 µs | 0.46× | 0.71× | 0.14× | EM_JS | 1.18× |
| string-marshalling | set 8 B | Rust | 0.45 µs | 0.47× | 0.69× | 0.13× | EM_JS | 1.34× |
| string-marshalling | get 8 B | C | 0.51 µs | 0.21× | 0.24× | 0.11× | EM_JS | 2.50× |
| string-marshalling | get 8 B | C++ | 0.48 µs | 0.19× | 0.24× | 0.07× | EM_JS | 2.35× |
| string-marshalling | get 8 B | Rust | 0.55 µs | 0.22× | 0.22× | 0.11× | EM_JS | 2.70× |
| string-marshalling | set 128 B | C | 0.63 µs | 0.77× | 0.87× | 0.16× | wasm-bindgen | 1.08× |
| string-marshalling | set 128 B | C++ | 0.60 µs | 0.48× | 0.96× | 0.14× | wasm-bindgen | 1.04× |
| string-marshalling | set 128 B | Rust | 0.63 µs | 0.65× | 0.95× | 0.13× | wasm-bindgen | 1.09× |
| string-marshalling | get 128 B | C | 1.79 µs | 0.81× | 0.73× | 0.37× | wasm-bindgen | 2.04× |
| string-marshalling | get 128 B | C++ | 1.80 µs | 0.73× | 0.75× | 0.36× | wasm-bindgen | 2.05× |
| string-marshalling | get 128 B | Rust | 1.77 µs | 0.54× | 0.81× | 0.35× | wasm-bindgen | 2.02× |
| string-marshalling | set 1024 B | C | 1.01 µs | 0.87× | 0.94× | 0.31× | wasm-bindgen | 1.09× |
| string-marshalling | set 1024 B | C++ | 0.94 µs | 0.76× | 0.97× | 0.29× | wasm-bindgen | 1.01× |
| string-marshalling | set 1024 B | Rust | 1.04 µs | 0.95× | 1.01× | 0.26× | wasm-bindgen | 1.12× |
| string-marshalling | get 1024 B | C | 2.00 µs | 0.43× | 0.46× | 0.29× | wasm-bindgen | 0.35× |
| string-marshalling | get 1024 B | C++ | 1.93 µs | 0.34× | 0.49× | 0.28× | wasm-bindgen | 0.34× |
| string-marshalling | get 1024 B | Rust | 1.84 µs | 0.20× | 0.45× | 0.22× | wasm-bindgen | 0.32× |
| string-marshalling | set 16384 B | C | 7.16 µs | 0.98× | 0.99× | 0.66× | wasm-bindgen | 1.03× |
| string-marshalling | set 16384 B | C++ | 7.09 µs | 0.99× | 1.00× | 0.73× | wasm-bindgen | 1.02× |
| string-marshalling | set 16384 B | Rust | 7.01 µs | 1.00× | 1.03× | 0.63× | wasm-bindgen | 1.01× |
| string-marshalling | get 16384 B | C | 19.33 µs | 0.50× | 0.53× | 0.36× | wasm-bindgen | 0.23× |
| string-marshalling | get 16384 B | C++ | 17.95 µs | 0.43× | 0.51× | 0.32× | wasm-bindgen | 0.21× |
| string-marshalling | get 16384 B | Rust | 19.43 µs | 0.60× | 0.51× | 0.32× | wasm-bindgen | 0.23× |
| string-marshalling | set 262144 B | C | 116.15 µs | 0.48× | 0.95× | 0.44× | Embind | 1.02× |
| string-marshalling | set 262144 B | C++ | 105.90 µs | 0.40× | 0.71× | 0.40× | Embind | 0.93× |
| string-marshalling | set 262144 B | Rust | 112.30 µs | 0.47× | 0.94× | 0.39× | Embind | 0.99× |
| string-marshalling | get 262144 B | C | 288.55 µs | 0.31× | 0.29× | 0.38× | wasm-bindgen | 0.21× |
| string-marshalling | get 262144 B | C++ | 267.20 µs | 0.27× | 0.29× | 0.34× | wasm-bindgen | 0.20× |
| string-marshalling | get 262144 B | Rust | 277.70 µs | 0.30× | 0.29× | 0.33× | wasm-bindgen | 0.21× |
| table-update | create: total ms | C | 12.27 ms | 0.92× | 0.90× | 0.16× | EM_JS | 2.04× |
| table-update | create: total ms | C++ | 15.23 ms | 1.10× | 0.94× | 0.21× | EM_JS | 2.53× |
| table-update | create: total ms | Rust | 14.34 ms | 0.90× | 0.96× | 0.22× | EM_JS | 2.38× |
| table-update | create: µs/row | C | 6.13 µs | 0.92× | 0.90× | 0.16× | EM_JS | 2.04× |
| table-update | create: µs/row | C++ | 7.62 µs | 1.10× | 0.94× | 0.21× | EM_JS | 2.53× |
| table-update | create: µs/row | Rust | 7.17 µs | 0.90× | 0.96× | 0.22× | EM_JS | 2.38× |
| table-update | update (selected): total ms | C | 1.08 ms | 1.02× | 0.82× | 0.28× | wasm-bindgen | 1.10× |
| table-update | update (selected): total ms | C++ | 1.06 ms | 1.03× | 0.88× | 0.28× | wasm-bindgen | 1.08× |
| table-update | update (selected): total ms | Rust | 0.85 ms | 0.64× | 0.86× | 0.26× | wasm-bindgen | 0.86× |
| table-update | update (selected): µs/row | C | 0.54 µs | 1.02× | 0.82× | 0.28× | wasm-bindgen | 1.10× |
| table-update | update (selected): µs/row | C++ | 0.53 µs | 1.03× | 0.88× | 0.28× | wasm-bindgen | 1.08× |
| table-update | update (selected): µs/row | Rust | 0.42 µs | 0.64× | 0.86× | 0.26× | wasm-bindgen | 0.86× |
| table-update | clear (unselected): total ms | C | 3.21 ms | 0.68× | 0.70× | 0.19× | wasm-bindgen | 1.19× |
| table-update | clear (unselected): total ms | C++ | 3.83 ms | 0.89× | 0.77× | 0.19× | wasm-bindgen | 1.42× |
| table-update | clear (unselected): total ms | Rust | 3.76 ms | 0.85× | 0.75× | 0.23× | wasm-bindgen | 1.40× |
| table-update | clear (unselected): µs/row | C | 1.60 µs | 0.68× | 0.70× | 0.19× | wasm-bindgen | 1.19× |
| table-update | clear (unselected): µs/row | C++ | 1.92 µs | 0.89× | 0.77× | 0.19× | wasm-bindgen | 1.42× |
| table-update | clear (unselected): µs/row | Rust | 1.88 µs | 0.85× | 0.75× | 0.23× | wasm-bindgen | 1.40× |

</details>

### Payload and startup

Payload medians cover 34 component inputs. Compression is per file. Startup is the median of the 21 per-workload and guest medians, from dynamic import through initialization, with browser caching disabled.

| Build | JS (KiB) | Core Wasm (KiB) | Total (KiB) | Gzip (KiB) | Brotli (KiB) | Startup (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 | 19.4 | 64.4 | 85.4 | 29.3 | 24.1 | 10.78 |
| Stock main | 183.9 | 64.4 | 255.2 | 58.2 | 48.3 | 25.90 |
| Candidate | 132.4 | 64.4 | 199.9 | 50.4 | 41.9 | 20.24 |

### What ships with `--minify`

Each Jco build generated its default and minified distribution from the same 34 components. Jco 1.13.0 uses Terser for its minify option. Stock main and the branch use Oxc. All external Wasm files matched byte for byte across formats. Payloads include JavaScript and external Wasm, compressed per file. Chromium interleaved the six distributions across 630 fresh pages, with 5 rounds for each of the 21 guest and workload combinations. The two ratio columns compare each format to that build’s default for the same guest and workload, then take the median of the 21 ratios. The final column compares workload times to the same format of 1.13.0. [Distribution sizes](web/bench/results/minified-sizes.json) · [Timings and resource requests](web/bench/results/minified-browser.json)

| Distribution | JS (KiB) | Total gzip (KiB) | Total Brotli (KiB) | Startup (ms) | Startup / default | Runtime / default | At or below 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 default | 19.4 | 29.3 | 24.1 | 10.85 | 1.00× | 1.00× | 21/21 |
| 1.13.0 minified | 8.7 | 28.8 | 23.7 | 10.85 | 1.00× | 1.04× | 21/21 |
| Stock main default | 183.9 | 58.2 | 48.3 | 25.98 | 1.00× | 1.00× | 1/21 |
| Stock main minified | 106.9 | 51.2 | 43.2 | 23.30 | 0.90× | 0.99× | 1/21 |
| Candidate default | 132.4 | 50.4 | 41.9 | 20.82 | 1.00× | 1.00× | 17/21 |
| Candidate minified | 73.5 | 44.9 | 38.0 | 19.70 | 0.94× | 1.05× | 17/21 |

Chromium’s Resource Timing entries give four consecutive intervals from the start of dynamic import until the module is ready. The gap before the first Wasm request includes resolving dependencies and executing JavaScript. The local server served uncompressed assets with caching disabled. Browser response-body sizes were checked against the generated file sizes. Each column reports its own median over workload medians.

| Distribution | Import to JS response end (ms) | JS response end to first Wasm request (ms) | First Wasm request to last Wasm response (ms) | Last Wasm response to ready (ms) |
| --- | --- | --- | --- | --- |
| 1.13.0 default | 2.29 | 3.19 | 2.40 | 2.93 |
| 1.13.0 minified | 2.28 | 2.93 | 2.46 | 3.12 |
| Stock main default | 2.61 | 16.56 | 2.40 | 4.20 |
| Stock main minified | 2.45 | 14.06 | 2.43 | 4.21 |
| Candidate default | 2.39 | 11.83 | 2.42 | 4.24 |
| Candidate minified | 2.38 | 10.80 | 2.53 | 4.06 |

Minifying the branch reduced startup by 6% on the median same-workload comparison. Its median import-to-ready time was 19.70 ms, compared with 10.85 ms for minified 1.13.0. Between the end of the entry JavaScript response and the first Wasm request, the corresponding medians were 10.80 and 2.93 ms.

![Default and minified gzip payloads and fresh-page startup for three Jco builds](web/bench/results/minified-startup.png)

### Startup with DevTools disconnected

In 1,470 fresh documents, the page timed its own dynamic import, ran the guest and sent the result to a local server. One browser kept the Puppeteer DevTools connection open. The other disconnected before the first measured navigation. Both navigated the same tab, with matching Chrome flags, no-store responses and verified network transfers. The order of the two browsers alternated over 5 rounds. Each table cell is the median of the 21 workload medians. [Observer timings](web/bench/results/startup-observer.json)

| Distribution | Attached startup (ms) | Detached startup (ms) | Attached JS end to Wasm request (ms) | Detached JS end to Wasm request (ms) |
| --- | --- | --- | --- | --- |
| 1.13.0 default | 8.96 | 6.50 | 2.98 | 1.75 |
| 1.13.0 minified | 8.24 | 6.34 | 2.72 | 1.74 |
| Stock main default | 21.96 | 14.70 | 14.91 | 8.63 |
| Stock main minified | 20.87 | 13.91 | 13.71 | 8.05 |
| Candidate default | 18.20 | 11.98 | 11.06 | 6.26 |
| Candidate minified | 16.67 | 11.27 | 9.74 | 5.61 |
| Previous branch default | 18.64 | 12.30 | 11.33 | 6.59 |

With DevTools disconnected, default-output startup took **0.99×** the previous revision’s time. The candidate was faster in 15/21 workloads. Each workload contributes its median within-round time ratio.

### Time to the first guest result

Each fresh page called the guest immediately after import, using the same workload arguments across builds. The first call includes the complete guest workload and its browser API calls. The final column times both import and execution on one clock. Each column reports the median of the 21 workload medians with DevTools disconnected.

| Distribution | Import (ms) | First guest call (ms) | Time to first result (ms) |
| --- | --- | --- | --- |
| 1.13.0 default | 6.50 | 59.39 | 66.10 |
| 1.13.0 minified | 6.34 | 58.23 | 64.21 |
| Stock main default | 14.70 | 217.61 | 232.84 |
| Stock main minified | 13.91 | 209.88 | 223.81 |
| Candidate default | 11.98 | 55.56 | 68.39 |
| Candidate minified | 11.27 | 57.47 | 68.59 |
| Previous branch default | 12.30 | 57.88 | 70.18 |

The following ratios compare default builds within each round. Each row summarizes the three language medians. A ratio below 1 means the candidate returned the guest result sooner.

| Workload | Candidate / 1.13.0 | Candidate / stock main |
| --- | --- | --- |
| Attribute write | 0.69× | 0.22× |
| Canvas fillRect | 1.14× | 0.31× |
| Canvas pixel read | 1.03× | 0.82× |
| DOM ID lookup | 1.12× | 0.27× |
| Tree traversal | 1.15× | 0.19× |
| Read 1 KiB string | 0.94× | 0.76× |
| Table creation | 1.31× | 0.31× |

The candidate reached the first result at or before 1.13.0 in **8/21** language/workload pairs and at or before stock main in **21/21**.

![Time to the first guest result for each workload and language relative to 1.13.0 and stock main. Points left of 1 favor the candidate.](web/bench/results/first-result.png)

### Eager JavaScript compilation

The branch exposes `jco transpile --eager-compile` and the JS API option `eagerCompile: true`. The option reproduced all 21 hinted candidate modules served in these trials. Verification also checked 68 ordinary and minified JS outputs after removing the hint, and all 64 accompanying Wasm outputs against their original hashes. [Jco transpile options at the verified revision](https://github.com/vados-cosmonic/jco/blob/165324dda277eef1407d43b80c19401c2d7de37c/docs/src/transpiling.md) · [Verification](web/bench/verify-compile-hint.mjs)

The server prepended `//# allFunctionsCalledOnLoad` and a newline to each ordinary entry module. Chromium can use these 29 bytes to compile functions while the module loads. Each guest used identical Wasm and the same browser host. DevTools was disconnected. The full run used the headline workloads. A second run measured a first call that writes attributes on eight elements twice, draws 16 rectangles, queries eight elements twice, traverses a seven-node tree, or creates and updates eight table rows. [V8 compile hints](https://v8.dev/blog/explicit-compile-hints) · [Full workload timings](web/bench/results/compile-hint.json) · [Small workload timings](web/bench/results/compile-hint-small.json)

Each cell summarizes the median hinted / ordinary ratio within rounds, then takes the median across language/workload pairs. A ratio below 1 favors eager compilation. The last column counts pairs for which the guest returned its first result sooner.

| Workload | Build | Rounds | Import | First guest call | Time to first result | Pairs with earlier first result |
| --- | --- | --- | --- | --- | --- | --- |
| Full | 1.13.0 | 9 | 1.12× | 0.89× | 0.90× | 18/21 |
| Full | Stock main | 9 | 1.32× | 0.98× | 1.01× | 9/21 |
| Full | Candidate | 9 | 1.30× | 0.91× | 0.98× | 13/21 |
| Small | 1.13.0 | 15 | 1.06× | 0.35× | 0.82× | 15/15 |
| Small | Stock main | 15 | 1.25× | 0.48× | 0.90× | 15/15 |
| Small | Candidate | 15 | 1.29× | 0.28× | 0.95× | 14/15 |

For applications that import the component ahead of an interaction, the first-call column measures the remaining wait. Applications that import on demand also pay the import time. The absolute times below are candidate medians across workload medians, with each column summarized independently.

| Workload | Candidate output | Import (ms) | First guest call (ms) | Time to first result (ms) |
| --- | --- | --- | --- | --- |
| Full | Ordinary | 12.23 | 59.66 | 71.33 |
| Full | Eager | 15.83 | 53.18 | 69.66 |
| Small | Ordinary | 13.04 | 6.48 | 19.62 |
| Small | Eager | 16.54 | 1.92 | 18.22 |

| Eager candidate first result at or before release | Ordinary 1.13.0 | Eager 1.13.0 |
| --- | --- | --- |
| Full | 10/21 | 8/21 |
| Small | 0/15 | 0/15 |

Each pair also has a two-sided 95% sign-test interval for its median first-result ratio across fresh-browser rounds. The counts below show how often the interval establishes a direction on this machine. Coverage applies to each comparison individually.

| Candidate workload | Interval favors eager | Interval includes 1 | Interval favors ordinary |
| --- | --- | --- | --- |
| Full | 1 | 20 | 0 |
| Small | 3 | 12 | 0 |

| Candidate first result | Small workload | Full workload |
| --- | --- | --- |
| Attribute write | 0.95× | 0.99× |
| Canvas fillRect | 0.94× | 0.93× |
| Canvas pixel read | — | 1.00× |
| DOM ID lookup | 0.96× | 0.90× |
| Tree traversal | 0.98× | 0.98× |
| Read 1 KiB string | — | 0.98× |
| Table creation | 0.94× | 1.07× |

![Time to the first result with eager compilation relative to ordinary candidate bindings. Each marker shows the median of three languages and the line spans their range.](web/bench/results/compile-hint.png)

### Direct module initialization

The same detached runs included ordinary output from the previous generator `460032a40`. The table compares the two default builds, using the same component binaries and workload arguments in each round. For each language/workload pair, it divides candidate time by previous time and takes the median across rounds. Each timing column summarizes those pair medians. The last columns count the two-sided 95% sign-test intervals for time to first result that lie wholly below or above parity.

| Workload | Rounds | Import | First call | Time to first result | Pairs with earlier first result | Interval favors candidate | Interval favors previous |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Full | 9 | 0.93× | 0.98× | 0.97× | 15/21 | 0 | 0 |
| Small | 15 | 0.97× | 0.93× | 0.94× | 15/15 | 1 | 0 |

### Generated JavaScript reached by each demo

Chromium recorded block coverage on 126 fresh pages in a separate run. One page imported each module and finished initialization. A second also ran the demo once and checked its output. The table reports medians over the 21 guest and workload combinations. Sizes count UTF-8 bytes in V8’s covered source ranges. A demo can leave error handling, shutdown or other supported operations unexercised. [Per-module coverage and hashes](web/bench/results/js-coverage.json)

| Build | Reached at init (KiB) | Reached through first run (KiB) | Share through first run | Unreached through first run (KiB) |
| --- | --- | --- | --- | --- |
| 1.13.0 | 4.8 | 16.3 | 76.6% | 5.0 |
| Stock main | 54.6 | 97.4 | 50.9% | 93.3 |
| Candidate | 35.3 | 59.6 | 44.4% | 75.1 |

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
| Attribute write | C | 21.71 | 0.55 | 0.55 | 0.69 | µs | 0.49× | 7/7 |
| Attribute write | C++ | 20.23 | 0.62 | 0.66 | 0.68 | µs | 0.47× | 7/7 |
| Attribute write | Rust | 17.05 | 0.69 | 0.75 | 0.82 | µs | 0.49× | 7/7 |
| Canvas fillRect | C | 20.19 | 0.84 | 0.97 | 1.08 | µs | 1.03× | 3/7 |
| Canvas fillRect | C++ | 19.31 | 0.86 | 0.89 | 0.92 | µs | 0.90× | 4/7 |
| Canvas fillRect | Rust | 20.23 | 1.03 | 1.13 | 1.18 | µs | 1.04× | 2/7 |
| Canvas pixel read | C | 22.39 | 346.45 | 349.50 | 384.45 | µs | 1.30× | 1/7 |
| Canvas pixel read | C++ | 21.23 | 265.35 | 275.90 | 309.10 | µs | 0.86× | 5/7 |
| Canvas pixel read | Rust | 20.23 | 314.75 | 325.30 | 342.35 | µs | 1.01× | 3/7 |
| DOM ID lookup | C | 18.89 | 0.79 | 0.92 | 1.13 | µs | 0.78× | 7/7 |
| DOM ID lookup | C++ | 20.24 | 1.10 | 1.20 | 1.24 | µs | 0.93× | 6/7 |
| DOM ID lookup | Rust | 19.48 | 0.81 | 0.86 | 0.93 | µs | 0.64× | 7/7 |
| Tree traversal | C | 21.07 | 13.88 | 15.01 | 15.42 | ms | 0.97× | 4/7 |
| Tree traversal | C++ | 21.78 | 14.28 | 15.70 | 15.82 | ms | 1.11× | 1/7 |
| Tree traversal | Rust | 21.10 | 16.97 | 19.05 | 21.30 | ms | 1.25× | 1/7 |
| Read 1 KiB string | C | 21.04 | 1.88 | 2.00 | 2.32 | µs | 0.41× | 7/7 |
| Read 1 KiB string | C++ | 18.84 | 1.90 | 1.93 | 2.59 | µs | 0.32× | 7/7 |
| Read 1 KiB string | Rust | 18.50 | 1.81 | 1.84 | 2.04 | µs | 0.21× | 7/7 |
| Table creation | C | 21.72 | 11.83 | 12.27 | 13.71 | ms | 0.90× | 4/7 |
| Table creation | C++ | 20.81 | 13.32 | 15.23 | 16.05 | ms | 1.07× | 2/7 |
| Table creation | Rust | 21.70 | 12.31 | 14.34 | 15.70 | ms | 0.87× | 6/7 |

</details>

[Raw browser timings](web/bench/results/candidate-browser.json) · [File sizes, digests and generator revision](web/bench/results/candidate-sizes.json)

### Reproduce the candidate run

Run the dependency installation, main setup and size commands in [Reproduce the comparison](#reproduce-the-comparison), then run the following from the repository root. Cargo uses the Jco checkout’s pinned toolchain and lockfile.

```sh
git clone https://github.com/vados-cosmonic/jco ../jco-candidate
git -C ../jco-candidate checkout 165324dda277eef1407d43b80c19401c2d7de37c
node web/bench/candidate.mjs ../jco-candidate
git -C ../jco-candidate worktree add --detach ../jco-reference 460032a40aaa3c56d5846614c04c4903e8bc0dea
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

Across the seven operations below and three guest languages, main took longer in **18 of 21** median comparisons. The highest ratio was **7.73×** for the Rust guest in `dom-traversal`.

For 256 KiB string reads, the median time on main changed by -20% to -9% across the three guest languages. The phase tables below include every tested string size.

Each cell is the median of 7 fresh-page samples. The chart divides main’s median time by 1.13.0’s for the same guest and operation. A value below 1× means main finished faster.

![Median time on main divided by baseline time for seven operations and three guest languages](web/bench/results/runtime.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 0.285 | 1.31 | — | — | 1.32 | 3.71 | 1.41 | 4.04 | 1.45 | 4.28 |
| Canvas fillRect (µs) | 0.835 | 1.84 | — | — | 0.946 | 4.07 | 0.992 | 4.10 | 1.03 | 3.59 |
| Canvas pixel read (µs) | 167.60 | 210.40 | — | — | 292.70 | 345.30 | 337.70 | 327.80 | 335.00 | 332.20 |
| DOM ID lookup (µs) | 0.286 | 1.31 | — | — | 1.25 | 5.75 | 1.29 | 5.21 | 1.35 | 5.04 |
| Tree traversal (ms) | 0.925 | 22.87 | 4.60 | 5.25 | 14.54 | 111.27 | 14.03 | 102.94 | 14.81 | 114.47 |
| Read 1 KiB string (µs) | 0.091 | 10.85 | 10.92 | 5.69 | 4.66 | 6.95 | 5.61 | 6.93 | 9.15 | 8.31 |
| Table creation (ms) | 3.31 | 14.84 | 6.02 | 9.67 | 13.39 | 76.33 | 13.79 | 71.64 | 16.02 | 65.08 |

Embind and EM_JS are the C++ Emscripten variants. An em dash marks an unavailable combination. Across toolchains, the upstream implementations can do different amounts of work. For example, the JavaScript bulk DOM query obtains a live collection while the component host materializes a list.

<details><summary>Run-to-run variation for the two jco versions</summary>

Each cell spans the 25th to 75th percentile of measured times, using linear interpolation between sorted samples.

| Operation | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 1.14–1.49 | 3.61–4.16 | 1.30–1.46 | 3.89–4.15 | 1.36–1.61 | 4.17–4.48 |
| Canvas fillRect (µs) | 0.855–1.02 | 3.85–4.11 | 0.875–1.09 | 3.71–4.18 | 0.939–1.16 | 3.50–3.77 |
| Canvas pixel read (µs) | 269.60–316.80 | 325.70–367.00 | 299.15–348.85 | 319.45–413.75 | 304.15–348.55 | 307.85–387.45 |
| DOM ID lookup (µs) | 1.08–1.38 | 5.51–6.22 | 1.25–1.48 | 4.98–5.42 | 1.26–1.35 | 4.70–5.61 |
| Tree traversal (ms) | 13.46–15.54 | 101.20–112.78 | 12.26–14.25 | 94.02–106.88 | 13.75–16.66 | 104.86–127.84 |
| Read 1 KiB string (µs) | 4.33–9.78 | 6.78–7.77 | 5.46–13.13 | 6.82–7.27 | 4.87–17.09 | 7.38–8.65 |
| Table creation (ms) | 12.39–14.61 | 70.53–77.75 | 12.73–14.65 | 62.40–75.66 | 14.51–16.28 | 62.75–75.25 |

</details>

<details><summary>All workload phases, per-call timings, and string transfer rates</summary>

Times come from the tables rendered by the demos and retain their original reporting precision. Effective string throughput uses the ASCII payload length divided by median call time (decimal MB/s).

**attribute-churn**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total time (ms) | 22.79 | 104.75 | — | — | 106.02 | 297.13 | 112.98 | 323.09 | 115.98 | 342.17 |
| per setAttribute() (µs) | 0.285 | 1.31 | — | — | 1.32 | 3.71 | 1.41 | 4.04 | 1.45 | 4.28 |

**canvas-draw**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total (ms) | 41.76 | 92.14 | — | — | 47.28 | 203.26 | 49.60 | 204.92 | 51.62 | 179.41 |
| per fill_rect() (µs) | 0.835 | 1.84 | — | — | 0.946 | 4.07 | 0.992 | 4.10 | 1.03 | 3.59 |

**canvas-pixels**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| getImageData() (µs) | 167.60 | 210.40 | — | — | 292.70 | 345.30 | 337.70 | 327.80 | 335.00 | 332.20 |
| putImageData() (µs) | 13.00 | 173.80 | — | — | 250.20 | 303.10 | 293.60 | 301.90 | 315.90 | 330.60 |

**dom-query**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| individual, total (ms) | 5.71 | 26.22 | — | — | 25.09 | 115.03 | 25.77 | 104.22 | 26.91 | 100.75 |
| bulk, total (ms) | 0.01 | 0.02 | — | — | 11.86 | 17.62 | 12.01 | 17.86 | 12.54 | 17.79 |
| individual: µs/element (µs) | 0.286 | 1.31 | — | — | 1.25 | 5.75 | 1.29 | 5.21 | 1.35 | 5.04 |

**dom-traversal**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| build (ms) | 11.62 | 39.70 | 19.53 | 24.58 | 49.70 | 211.78 | 47.82 | 205.39 | 43.10 | 221.72 |
| traverse (total) (ms) | 0.925 | 22.87 | 4.60 | 5.25 | 14.54 | 111.27 | 14.03 | 102.94 | 14.81 | 114.47 |
| traverse (per node) (µs) | 0.047 | 1.17 | 0.235 | 0.269 | 0.744 | 5.70 | 0.719 | 5.27 | 0.758 | 5.86 |

**string-marshalling**

![Median DOM textContent set and get latency by payload length for each guest and jco version, on logarithmic axes](web/bench/results/strings.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| set 8 B (µs) | 0.18 | 0.851 | 0.336 | 0.561 | 0.809 | 3.00 | 0.861 | 2.94 | 0.959 | 3.44 |
| set 8 B (MB/s) | 44.44 | 9.40 | 23.81 | 14.26 | 9.89 | 2.67 | 9.29 | 2.72 | 8.34 | 2.33 |
| get 8 B (µs) | 0.083 | 0.97 | 0.205 | 0.239 | 2.40 | 4.63 | 2.49 | 6.55 | 2.54 | 4.94 |
| get 8 B (MB/s) | 96.39 | 8.25 | 39.02 | 33.47 | 3.34 | 1.73 | 3.21 | 1.22 | 3.15 | 1.62 |
| set 128 B (µs) | 0.311 | 1.14 | 0.825 | 0.579 | 0.812 | 3.81 | 1.26 | 4.18 | 0.969 | 4.82 |
| set 128 B (MB/s) | 411.58 | 112.48 | 155.15 | 221.07 | 157.64 | 33.58 | 101.75 | 30.61 | 132.09 | 26.56 |
| get 128 B (µs) | 0.081 | 2.24 | 1.50 | 0.877 | 2.21 | 4.88 | 2.46 | 5.03 | 3.26 | 5.04 |
| get 128 B (MB/s) | 1,580.25 | 57.25 | 85.05 | 145.95 | 57.79 | 26.22 | 52.07 | 25.44 | 39.24 | 25.39 |
| set 1024 B (µs) | 0.956 | 1.47 | 2.84 | 0.929 | 1.16 | 3.28 | 1.23 | 3.26 | 1.10 | 4.04 |
| set 1024 B (MB/s) | 1,071.13 | 698.98 | 360.44 | 1,102.26 | 879.73 | 312.39 | 831.17 | 313.92 | 931.76 | 253.15 |
| get 1024 B (µs) | 0.091 | 10.85 | 10.92 | 5.69 | 4.66 | 6.95 | 5.61 | 6.93 | 9.15 | 8.31 |
| get 1024 B (MB/s) | 11,252.75 | 94.35 | 93.81 | 179.93 | 219.60 | 147.34 | 182.69 | 147.81 | 111.85 | 123.18 |
| set 16384 B (µs) | 12.07 | 7.67 | 36.99 | 6.92 | 7.27 | 10.88 | 7.17 | 9.67 | 7.02 | 11.19 |
| set 16384 B (MB/s) | 1,356.85 | 2,136.39 | 442.95 | 2,366.95 | 2,253.96 | 1,505.33 | 2,284.44 | 1,694.49 | 2,333.24 | 1,463.64 |
| get 16384 B (µs) | 0.456 | 162.80 | 170.45 | 85.10 | 38.62 | 53.70 | 41.42 | 55.45 | 32.25 | 60.90 |
| get 16384 B (MB/s) | 35,929.82 | 100.64 | 96.12 | 192.53 | 424.18 | 305.10 | 395.51 | 295.47 | 508.03 | 269.03 |
| set 262144 B (µs) | 160.39 | 113.55 | 563.85 | 245.80 | 243.10 | 265.45 | 262.65 | 264.00 | 241.35 | 284.85 |
| set 262144 B (MB/s) | 1,634.41 | 2,308.62 | 464.92 | 1,066.49 | 1,078.34 | 987.55 | 998.07 | 992.97 | 1,086.16 | 920.29 |
| get 262144 B (µs) | 11.43 | 2,569.45 | 2,690.00 | 1,353.35 | 932.65 | 757.65 | 981.50 | 783.40 | 916.75 | 836.25 |
| get 262144 B (MB/s) | 22,932.73 | 102.02 | 97.45 | 193.70 | 281.07 | 346.00 | 267.09 | 334.62 | 285.95 | 313.48 |

**table-update**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create, total (ms) | 3.31 | 14.84 | 6.02 | 9.67 | 13.39 | 76.33 | 13.79 | 71.64 | 16.02 | 65.08 |
| create, per row (µs) | 1.66 | 7.42 | 3.01 | 4.83 | 6.70 | 38.17 | 6.89 | 35.82 | 8.01 | 32.54 |
| update (selected), total (ms) | 0.38 | 1.28 | 1.14 | 0.985 | 1.06 | 3.83 | 1.03 | 3.73 | 1.32 | 3.33 |
| update (selected), per row (µs) | 0.19 | 0.64 | 0.57 | 0.492 | 0.532 | 1.91 | 0.515 | 1.86 | 0.662 | 1.66 |
| clear (unselected), total (ms) | 1.41 | 3.74 | 4.32 | 2.69 | 4.69 | 17.02 | 4.32 | 20.07 | 4.43 | 16.46 |
| clear (unselected), per row (µs) | 0.702 | 1.87 | 2.16 | 1.35 | 2.35 | 8.51 | 2.16 | 10.04 | 2.21 | 8.23 |

</details>

<details><summary>Module load and initialization, median milliseconds</summary>

Elapsed browser time for dynamic import through instantiation, with the shared demo host already loaded. The browser process is reused, each page has HTTP caching disabled, and assets are served uncompressed over loopback. These timings include scheduling and local requests. JS is already loaded by the harness.

| Workload | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| attribute-churn | 14.99 | — | — | 9.48 | 26.45 | 10.78 | 24.10 | 10.92 | 23.21 |
| canvas-draw | 13.88 | — | — | 10.12 | 25.09 | 10.05 | 24.85 | 11.33 | 24.98 |
| canvas-pixels | 14.33 | — | — | 10.86 | 27.70 | 11.71 | 27.96 | 11.31 | 27.83 |
| dom-query | 14.56 | — | — | 11.68 | 27.70 | 10.58 | 26.10 | 10.57 | 25.26 |
| dom-traversal | 15.22 | 8.96 | 9.17 | 10.24 | 26.40 | 10.60 | 25.54 | 11.31 | 26.03 |
| string-marshalling | 12.46 | 8.65 | 7.98 | 10.43 | 24.31 | 10.00 | 25.61 | 9.93 | 22.33 |
| table-update | 14.00 | 9.85 | 9.39 | 11.17 | 27.57 | 11.55 | 25.90 | 10.89 | 27.20 |

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
