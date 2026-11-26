# Component demos

This fork benchmarks the browser examples from [eqrion/component-demos at d0b9dd1](https://github.com/eqrion/component-demos/tree/d0b9dd1390a300978193adc623838fef4e4b632b). It runs the same compiled C, C++, and Rust WebAssembly components through jco 1.13.0, pinned upstream main, and a branch that optimizes synchronous host imports. The comparison also includes the demos’ JavaScript, Emscripten (Embind and EM_JS), and Rust wasm-bindgen implementations where available.

The performance branch also specializes UTF-8 conversion in both directions. For strings of up to 32 ASCII bytes, the bindings read or write the bytes directly. Non-ASCII text uses the checked codec, including its malformed-input traps. [Short-string changes](https://github.com/vados-cosmonic/jco/compare/ac28d5d481f3cfca94bc4c62f3571511c19386d9...9eeb7f0b9ab82a982810af5cdd1d9035b302aa39)

For longer host-returned strings, the runtime can encode into a reusable buffer before allocating guest memory. On the preceding upstream revision, a 16 KiB read took 26–28 µs across C, C++, and Rust, or 46–50% of the time for 1.13.0. The archived run compares the bindings immediately before and after this change. [UTF-8 benchmark and raw measurements](https://github.com/vados-cosmonic/component-demos/blob/7550fa7523931f918b6bd599174af07e6537961b/README.md#optimized-browser-bindings)

<!-- candidate:start -->

## Optimized browser bindings

The branch uses js-component-bindgen’s internal Oxc bundler and the checked jco-cm-runtime. [Measured Jco commit `d21cb546b`](https://github.com/vados-cosmonic/jco/commit/d21cb546b5013233b3036937794968b0ac8161f5) · [Canvas host comparison](#canvas-pixel-transfers-with-the-same-guest-binary) · [Payload and startup](#payload-and-startup) · [Reproduction commands](#reproduce-the-candidate-run)

All Jco builds used the same guest binaries. Each value is the median of 7 fresh-page samples with one warm-up per page. The run collected 581 samples on 2026-11-26 with HeadlessChrome/156.0.8078.47 on Intel(R) Xeon(R) Processor @ 2.60GHz.

Stock main is pinned to `3e5c52279`. [Upstream source](https://github.com/bytecodealliance/jco/commit/3e5c52279b7ad45b8f15a2bca07569364c8d0c3f) · [Transpiler CI build](https://github.com/bytecodealliance/jco/actions/runs/45731701560)

The candidate finished within **10× of the fastest available compiled shim in 21/21** headline comparisons. The largest ratio was **4.37×**. On separate fresh pages it matched or beat **1.13.0 in 15/21** and **stock main in 20/21**. On the same warmed page it matched or beat **1.13.0 in 18/21** headline cases and 76/84 across all phases. The shim comparison selects the lowest median among Embind, EM_JS and wasm-bindgen for each operation, including shims written in a different guest language. The phase tables in the original comparison describe workload differences and include raw JavaScript.

![Candidate runtime relative to the two targets by operation and language](web/bench/results/candidate-runtime.png)

| Operation | Guest | Unit | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Fastest shim | Shim time | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | µs | 1.24 | 3.72 | 0.63 | 0.51× | Embind | 1.27 | 0.50× |
| Attribute write | C++ | µs | 1.14 | 3.72 | 0.56 | 0.49× | Embind | 1.27 | 0.44× |
| Attribute write | Rust | µs | 1.35 | 4.10 | 0.80 | 0.59× | Embind | 1.27 | 0.63× |
| Canvas fillRect | C | µs | 0.95 | 3.37 | 1.01 | 1.06× | Embind | 1.76 | 0.57× |
| Canvas fillRect | C++ | µs | 0.94 | 3.77 | 0.99 | 1.05× | Embind | 1.76 | 0.56× |
| Canvas fillRect | Rust | µs | 0.87 | 3.70 | 0.83 | 0.95× | Embind | 1.76 | 0.47× |
| Canvas pixel read | C | µs | 322.30 | 304.60 | 312.50 | 0.97× | Embind | 186.80 | 1.67× |
| Canvas pixel read | C++ | µs | 342.30 | 339.40 | 317.90 | 0.93× | Embind | 186.80 | 1.70× |
| Canvas pixel read | Rust | µs | 301.50 | 334.10 | 330.50 | 1.10× | Embind | 186.80 | 1.77× |
| DOM ID lookup | C | µs | 1.42 | 5.08 | 0.93 | 0.65× | Embind | 1.34 | 0.69× |
| DOM ID lookup | C++ | µs | 1.31 | 4.75 | 1.17 | 0.89× | Embind | 1.34 | 0.87× |
| DOM ID lookup | Rust | µs | 1.09 | 4.33 | 0.95 | 0.87× | Embind | 1.34 | 0.71× |
| Tree traversal | C | ms | 12.50 | 86.78 | 14.74 | 1.18× | EM_JS | 4.17 | 3.53× |
| Tree traversal | C++ | ms | 14.91 | 108.51 | 13.90 | 0.93× | EM_JS | 4.17 | 3.33× |
| Tree traversal | Rust | ms | 15.37 | 110.99 | 18.24 | 1.19× | EM_JS | 4.17 | 4.37× |
| Read 1 KiB string | C | µs | 11.65 | 6.43 | 1.73 | 0.15× | wasm-bindgen | 5.29 | 0.33× |
| Read 1 KiB string | C++ | µs | 10.96 | 6.74 | 1.95 | 0.18× | wasm-bindgen | 5.29 | 0.37× |
| Read 1 KiB string | Rust | µs | 5.19 | 6.95 | 1.90 | 0.37× | wasm-bindgen | 5.29 | 0.36× |
| Table creation | C | ms | 12.07 | 73.43 | 13.76 | 1.14× | EM_JS | 5.61 | 2.45× |
| Table creation | C++ | ms | 13.60 | 67.84 | 13.26 | 0.97× | EM_JS | 5.61 | 2.36× |
| Table creation | Rust | ms | 14.42 | 62.40 | 13.90 | 0.96× | EM_JS | 5.61 | 2.48× |

Comparing implementations in the same language, the branch stayed within 10× in **13/13** available headline comparisons. Each cell divides the branch’s median by that shim’s median. A dash means the demo has no implementation for that binding. The demos supply compiled shims for C++ and Rust.

| Operation | C++ / Embind | C++ / EM_JS | Rust / wasm-bindgen |
| --- | --- | --- | --- |
| Attribute write | 0.44× | — | — |
| Canvas fillRect | 0.56× | — | — |
| Canvas pixel read | 1.70× | — | — |
| DOM ID lookup | 0.87× | — | — |
| Tree traversal | 0.57× | 3.33× | 3.44× |
| Read 1 KiB string | 0.17× | 0.21× | 0.36× |
| Table creation | 0.79× | 2.36× | 1.53× |

<details><summary>How the synchronous bindings work</summary>

Eligible single-instance, synchronous components reuse the caller’s task for host imports. The adapter keeps direct references to its task stack and instance flags and checks for store interruptions. Oxc removes the asynchronous import fallback and the subtask constructor, which these imports never use. The generator skips asynchronous wrappers for synchronous allocators and post-return hooks. Standalone modules also omit suspension markers on core imports.

During a guest allocation, the checked runtime clears the instance’s may-leave flag and restores it on return or throw. Allocators in components with context-slot operations use the general guard to supply fresh slots for each call. The adapter lifts short ASCII strings four bytes at a time. Synchronous UTF-8 results of 256 to 262,144 code units can reuse a per-instance byte buffer capped at 256 KiB. The runtime encodes there before requesting the exact guest allocation. Nested calls and larger results use the ordinary encoder.

Resource drops check the instance flag and record traps. When lifting a borrowed host resource, the adapter validates the handle and reads its 32-bit representation directly. Imported host resources with automatically assigned representations use their guest handle as an array index. Explicit host representations and shared tables use a representation map. Components with async operations, cross-component resource transfers or call tracking use the general adapter.

The preceding run measures the change from removing the subtask constructor from synchronous components. [Archived report](https://github.com/vados-cosmonic/component-demos/blob/255eca61b14b5ab63567da558b5f561149cc5163/README.md#change-from-the-previous-branch-revision)

</details>

### Warm 1.13.0 comparison on the same page

For each guest and workload, both builds run once to warm up, then 4 times each on the same page. Each pair alternates which build runs first. The runner clears the DOM and performance entries before every call. It repeats this on 9 fresh pages. Each page contributes the median of its candidate / 1.13.0 ratios. The median across pages was at or below 1× for **18/21** headline cases. [Raw paired timings](web/bench/results/paired-browser.json)

![Median paired time ratios by workload and guest, with bars spanning the middle half of page ratios](web/bench/results/paired-runtime.png)

The middle 50% describes variation between pages. The median interval uses a two-sided sign test over independent page medians at the 95% level for each phase individually. Measurements on this CPU and browser can share machine load across pages.

| Operation | Guest | Candidate / 1.13.0 | Middle 50% of page ratios | 95% median interval | Pages at or below 1× |
| --- | --- | --- | --- | --- | --- |
| Attribute write | C | 0.51× | 0.50–0.52× | 0.493–0.540× | 9/9 |
| Attribute write | C++ | 0.51× | 0.50–0.51× | 0.498–0.524× | 9/9 |
| Attribute write | Rust | 0.57× | 0.55–0.58× | 0.546–0.601× | 9/9 |
| Canvas fillRect | C | 0.93× | 0.92–0.96× | 0.913–1.005× | 7/9 |
| Canvas fillRect | C++ | 0.96× | 0.93–0.98× | 0.909–0.991× | 8/9 |
| Canvas fillRect | Rust | 0.95× | 0.91–0.96× | 0.874–0.958× | 8/9 |
| Canvas pixel read | C | 0.94× | 0.66–1.04× | 0.663–1.058× | 6/9 |
| Canvas pixel read | C++ | 1.04× | 0.97–1.07× | 0.934–1.252× | 4/9 |
| Canvas pixel read | Rust | 1.00× | 0.87–1.04× | 0.805–1.128× | 4/9 |
| DOM ID lookup | C | 0.59× | 0.58–0.71× | 0.556–0.722× | 9/9 |
| DOM ID lookup | C++ | 0.66× | 0.59–0.70× | 0.537–0.731× | 9/9 |
| DOM ID lookup | Rust | 0.61× | 0.57–0.77× | 0.564–0.770× | 9/9 |
| Tree traversal | C | 0.83× | 0.79–0.85× | 0.774–0.872× | 9/9 |
| Tree traversal | C++ | 0.77× | 0.75–0.79× | 0.726–0.916× | 9/9 |
| Tree traversal | Rust | 0.68× | 0.57–0.95× | 0.563–0.958× | 9/9 |
| Read 1 KiB string | C | 0.45× | 0.39–0.48× | 0.368–0.505× | 9/9 |
| Read 1 KiB string | C++ | 0.45× | 0.43–0.48× | 0.397–0.495× | 9/9 |
| Read 1 KiB string | Rust | 0.48× | 0.39–0.52× | 0.336–0.529× | 9/9 |
| Table creation | C | 1.01× | 0.95–1.03× | 0.923–1.097× | 4/9 |
| Table creation | C++ | 0.94× | 0.82–0.97× | 0.803–1.023× | 7/9 |
| Table creation | Rust | 0.95× | 0.88–0.97× | 0.865–0.994× | 8/9 |

Across all 84 reported phases and string lengths, the same-page comparison matched or beat 1.13.0 in **76/84** cases. The median interval lay entirely above 1× in **0/84** cases. Totals and subphases overlap.

| Slower paired phase | Guest | Metric | Candidate / 1.13.0 | 95% median interval | Pages at or below 1× |
| --- | --- | --- | --- | --- | --- |
| canvas-pixels | C | putImageData(): µs/call | 1.085× | 0.986–1.208× | 3/9 |
| canvas-pixels | C++ | getImageData(): µs/call | 1.041× | 0.934–1.252× | 4/9 |
| string-marshalling | Rust | set 128 B | 1.039× | 0.861–1.157× | 4/9 |
| table-update | C | create: total ms | 1.009× | 0.923–1.097× | 4/9 |
| table-update | C | create: µs/row | 1.009× | 0.923–1.097× | 4/9 |
| string-marshalling | C++ | set 16384 B | 1.008× | 0.958–1.034× | 4/9 |
| string-marshalling | C | set 16384 B | 1.002× | 0.982–1.055× | 3/9 |
| canvas-pixels | Rust | getImageData(): µs/call | 1.000× | 0.805–1.128× | 4/9 |

Across all reported phases and string lengths, 81/84 comparable candidate medians were within 10× of the fastest compiled shim and 62/84 matched or beat 1.13.0. Totals and their subphases overlap. Each ratio compares the same phase on both sides.

| Phases above 10× | Phase | Guest | Shim | Candidate / shim |
| --- | --- | --- | --- | --- |
| dom-query | bulk: total ms | C | Embind | 569.75× |
| dom-query | bulk: total ms | C++ | Embind | 713.00× |
| dom-query | bulk: total ms | Rust | Embind | 509.75× |

The bulk DOM query returns a live collection to Embind, which discards it. The component host materializes the collection with `Array.from`, then the bindings lower every element into a WIT resource handle. The ratio includes that difference in work. [Embind loop](cpp/dom-query/emscripten/main.cpp) · [Component host](web/host/web-host.js) · [C guest loop](c/dom-query/main.c)

### DOM bindings with identical guest code

These 162 fresh-page samples compare each language’s exact core Wasm binary with each set of bindings in the table. The direct JS shim calls the same DOM host, puts owned handles in guest memory and recycles them on guest drops. It implements the synchronous imports used by these guests. Jco also provides Canonical ABI checks, task tracking and instance shutdown. [Direct shim](web/bench/dom-core-shim.mjs) · [Raw timings and correctness checks](web/bench/results/dom-control-browser.json)

The bulk query copies 2,000 handles per call, 10 times. Each traversal visits 19,531 nodes. The runner checks the rendered fixture or node count for each guest and verifies list counts and handle release for the direct shim after warm-up and measurement.

With list materialization on both sides, the candidate took **1.48–1.67×** the direct shim’s bulk-query time across the three guests. Times below are per measured workload, after warm-up.

![DOM phase times for Jco 1.13.0 and the candidate relative to the same-guest direct shim](web/bench/results/dom-control-runtime.png)

| Phase | Guest | Direct (ms) | 1.13.0 (ms) | Candidate (ms) | Candidate / direct | Candidate / 1.13.0 | Rounds at or below 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DOM ID lookup | C | 12.56 | 25.48 | 19.02 | 1.51× | 0.75× | 7/9 |
| DOM ID lookup | C++ | 15.59 | 25.41 | 23.41 | 1.50× | 0.92× | 9/9 |
| DOM ID lookup | Rust | 12.67 | 22.42 | 16.75 | 1.32× | 0.75× | 8/9 |
| Bulk DOM query | C | 5.79 | 11.03 | 9.67 | 1.67× | 0.88× | 7/9 |
| Bulk DOM query | C++ | 6.82 | 11.97 | 11.30 | 1.66× | 0.94× | 4/9 |
| Bulk DOM query | Rust | 6.12 | 11.26 | 9.07 | 1.48× | 0.81× | 8/9 |
| Tree construction | C | 24.97 | 45.18 | 45.77 | 1.83× | 1.01× | 5/9 |
| Tree construction | C++ | 24.27 | 43.79 | 46.40 | 1.91× | 1.06× | 3/9 |
| Tree construction | Rust | 22.18 | 48.60 | 41.62 | 1.88× | 0.86× | 7/9 |
| Tree traversal | C | 6.34 | 12.44 | 13.18 | 2.08× | 1.06× | 2/9 |
| Tree traversal | C++ | 6.34 | 13.14 | 13.75 | 2.17× | 1.05× | 4/9 |
| Tree traversal | Rust | 6.97 | 15.90 | 16.94 | 2.43× | 1.07× | 4/9 |

On the same guest binaries, initialization took the following times before the first guest call. Each median covers 9 fresh pages and includes importing the binding module, fetching the guest and instantiating it. The direct shim uses `WebAssembly.instantiateStreaming`.

| Workload | Guest | Direct startup (ms) | 1.13.0 (ms) | Candidate (ms) | Candidate / direct | Candidate / 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- |
| ID and bulk query | C | 7.61 | 11.41 | 20.48 | 2.69× | 1.80× |
| ID and bulk query | C++ | 8.51 | 10.09 | 22.89 | 2.69× | 2.27× |
| ID and bulk query | Rust | 8.28 | 10.84 | 19.80 | 2.39× | 1.83× |
| Tree traversal | C | 7.58 | 10.93 | 20.68 | 2.73× | 1.89× |
| Tree traversal | C++ | 7.92 | 10.25 | 21.05 | 2.66× | 2.05× |
| Tree traversal | Rust | 8.06 | 11.18 | 20.71 | 2.57× | 1.85× |

### Cost of a synchronous host import

The scalar, string and resource loops run 131,072 iterations per pass. The string loop changes the first byte before each call. The resource loop acquires a host object, borrows it to read its value, and drops it. The optional-resource loop checks the discriminant in guest memory every time and reads and drops each present handle. Each pass checks its checksum. All four adapters use byte-identical core modules. The direct shim keeps the fixture’s single live handle in one slot.

The byte-list loops copy a 176 × 176 RGBA region (123,904 bytes) 2,048 times per pass in each direction. The host-to-guest case uses a reusable host view and a fixed guest allocation. In the reverse direction the host keeps the final snapshot while the guest changes the source in Wasm. Both cases sum the changing first byte during the loop and verify the whole payload afterward. The canvas demo also measures browser readback, host allocation and guest allocation.

The string-return loops make 32,768 calls per pass for 16-byte results and 1,024 for 16 KiB results. One host returns a repeated ASCII string. The other rotates four strings containing two-, three-, and four-byte UTF-8 sequences. The guest checks each byte length, sums the first bytes, and hashes every distinct result outside the timer.

Times are nanoseconds per guest iteration, including the loop and host work. Each cell is the median of 7 fresh-page medians, with 2 warm-ups and 5 timed passes per page. The runner interleaves the four builds. [Raw timings and digests](web/bench/results/import-loop.json)

| Operation | Direct | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Candidate / direct |
| --- | --- | --- | --- | --- | --- | --- |
| u32 | 13.0 | 11.4 | 1,587.7 | 13.7 | 1.20× | 1.06× |
| 2-byte string | 389.9 | 408.2 | 2,313.2 | 106.8 | 0.26× | 0.27× |
| 9-byte string | 387.6 | 383.0 | 2,169.8 | 166.3 | 0.43× | 0.43× |
| 32-byte string | 402.1 | 415.0 | 2,272.8 | 418.1 | 1.01× | 1.04× |
| Acquire, borrow, drop | 38.9 | 225.1 | 4,124.5 | 116.7 | 0.52× | 3.00× |
| Optional resource, half present | 32.0 | 189.2 | 3,009.8 | 135.0 | 0.71× | 4.21× |
| 121 KiB host-to-guest byte list | 4,638.7 | 4,931.6 | 8,496.1 | 4,931.6 | 1.00× | 1.06× |
| 121 KiB guest-to-host byte list | 97,168.0 | 93,310.5 | 101,171.9 | 97,705.1 | 1.05× | 1.01× |
| 16-byte UTF-8 result, repeated ASCII | 1,647.9 | 1,718.1 | 3,677.4 | 375.4 | 0.22× | 0.23× |
| 16-byte UTF-8 result, rotating Unicode | 1,644.9 | 1,760.9 | 3,930.7 | 875.9 | 0.50× | 0.53× |
| 16 KiB UTF-8 result, repeated ASCII | 34,082.0 | 33,789.1 | 49,511.7 | 17,773.4 | 0.53× | 0.52× |
| 16 KiB UTF-8 result, rotating Unicode | 42,968.8 | 43,066.4 | 70,996.1 | 29,687.5 | 0.69× | 0.69× |

![Time per guest iteration relative to Jco 1.13.0, by import and transfer direction](web/bench/results/import-loop-runtime.png)

### Where the canvas read spends its time

The same-page comparison was repeated with a clock around the demo’s host method. That method reads 176 × 176 pixels from Chromium and creates a JavaScript byte array. The remainder includes guest allocation and freeing, the copy into Wasm, binding checks, the loop and observer overhead. Each cell is a median across 9 page medians. Columns are summarized independently. [Raw instrumented samples](web/bench/results/canvas-control-browser.json)

| Guest | Bindings | Full read (µs) | Inside host (µs) | Remainder (µs) | Inside host (%) |
| --- | --- | --- | --- | --- | --- |
| C | 1.13.0 | 332.0 | 319.5 | 12.9 | 96.3% |
| C | Candidate | 334.8 | 320.5 | 13.9 | 96.0% |
| C++ | 1.13.0 | 324.3 | 311.6 | 12.7 | 96.0% |
| C++ | Candidate | 379.6 | 363.4 | 16.2 | 95.7% |
| Rust | 1.13.0 | 355.3 | 337.7 | 14.8 | 95.9% |
| Rust | Candidate | 337.8 | 323.6 | 14.9 | 95.8% |

The host accounted for 95.7–96.3% of the full read across these builds. The candidate spent 13.9–16.2 µs per read outside the host, compared with 12.7–14.8 µs for 1.13.0.

### Canvas pixel transfers with the same guest binary

Each call transfers a 176 × 176 RGBA region (123,904 bytes). The original browser host copies the pixel array on both read and write. The alternate host creates a typed-array view over the browser’s readback or the binding’s write snapshot, preserving its offset and length. All four implementations still copy the bytes across the Wasm boundary. [View adapter](web/bench/canvas-host.mjs) · [Direct shim](web/bench/dom-core-shim.mjs)

For each guest, all four bindings use identical core Wasm. Each table cell is the median of 9 page medians, with one warm-up and 4 measured passes per page. The runner rotates the four bindings on each page, alternates the host order and checks every pixel on both canvases after each invocation. [Raw timings and pixel checks](web/bench/results/canvas-host.json)

Changing the host reduced the candidate’s read time by **45–49%** and write time by **57–61%**. With the view adapter, its six timings were **0.93–1.05×** the corresponding direct shim times. The headline benchmarks use the original host.

![Canvas read and write times for the candidate with both hosts and the direct shim with pixel views](web/bench/results/canvas-host-runtime.png)

| Guest | Bindings | Original read (µs) | View read (µs) | Original write (µs) | View write (µs) |
| --- | --- | --- | --- | --- | --- |
| C | Direct shim | 340.1 | 167.6 | 243.9 | 99.7 |
| C | 1.13.0 | 334.6 | 177.2 | 237.7 | 98.0 |
| C | Stock main | 346.9 | 195.2 | 314.1 | 146.6 |
| C | Candidate | 333.2 | 171.6 | 250.5 | 98.8 |
| C++ | Direct shim | 314.1 | 173.6 | 242.3 | 98.7 |
| C++ | 1.13.0 | 327.4 | 182.2 | 250.2 | 98.0 |
| C++ | Stock main | 348.0 | 195.7 | 293.7 | 156.9 |
| C++ | Candidate | 318.1 | 176.5 | 242.4 | 103.2 |
| Rust | Direct shim | 339.9 | 178.8 | 237.6 | 96.6 |
| Rust | 1.13.0 | 315.8 | 176.5 | 246.4 | 138.4 |
| Rust | Stock main | 338.9 | 191.3 | 323.6 | 142.9 |
| Rust | Candidate | 327.9 | 166.8 | 244.4 | 101.6 |

<details><summary>All timed phases and string lengths</summary>

| Demo | Phase | Guest | Candidate time | Fresh-page / 1.13.0 | Same-page / 1.13.0 | Candidate / main | Fastest shim | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| attribute-churn | total time | C | 50.62 ms | 0.51× | 0.51× | 0.17× | Embind | 0.50× |
| attribute-churn | total time | C++ | 44.73 ms | 0.49× | 0.51× | 0.15× | Embind | 0.44× |
| attribute-churn | total time | Rust | 63.98 ms | 0.59× | 0.57× | 0.20× | Embind | 0.63× |
| attribute-churn | per setAttribute() | C | 0.63 µs | 0.51× | 0.51× | 0.17× | Embind | 0.50× |
| attribute-churn | per setAttribute() | C++ | 0.56 µs | 0.49× | 0.51× | 0.15× | Embind | 0.44× |
| attribute-churn | per setAttribute() | Rust | 0.80 µs | 0.59× | 0.57× | 0.20× | Embind | 0.63× |
| canvas-draw | total | C | 50.42 ms | 1.06× | 0.93× | 0.30× | Embind | 0.57× |
| canvas-draw | total | C++ | 49.30 ms | 1.05× | 0.97× | 0.26× | Embind | 0.56× |
| canvas-draw | total | Rust | 41.37 ms | 0.95× | 0.95× | 0.22× | Embind | 0.47× |
| canvas-draw | per fill_rect() | C | 1.01 µs | 1.06× | 0.93× | 0.30× | Embind | 0.57× |
| canvas-draw | per fill_rect() | C++ | 0.99 µs | 1.05× | 0.96× | 0.26× | Embind | 0.56× |
| canvas-draw | per fill_rect() | Rust | 0.83 µs | 0.95× | 0.95× | 0.22× | Embind | 0.47× |
| canvas-pixels | getImageData(): µs/call | C | 312.50 µs | 0.97× | 0.94× | 1.03× | Embind | 1.67× |
| canvas-pixels | getImageData(): µs/call | C++ | 317.90 µs | 0.93× | 1.04× | 0.94× | Embind | 1.70× |
| canvas-pixels | getImageData(): µs/call | Rust | 330.50 µs | 1.10× | 1.00× | 0.99× | Embind | 1.77× |
| canvas-pixels | putImageData(): µs/call | C | 236.40 µs | 0.95× | 1.08× | 0.84× | Embind | 1.31× |
| canvas-pixels | putImageData(): µs/call | C++ | 274.60 µs | 1.18× | 0.93× | 0.99× | Embind | 1.52× |
| canvas-pixels | putImageData(): µs/call | Rust | 243.80 µs | 0.94× | 0.93× | 0.75× | Embind | 1.35× |
| dom-query | individual: total ms | C | 18.57 ms | 0.65× | 0.59× | 0.18× | Embind | 0.69× |
| dom-query | individual: total ms | C++ | 23.33 ms | 0.89× | 0.66× | 0.25× | Embind | 0.87× |
| dom-query | individual: total ms | Rust | 18.93 ms | 0.87× | 0.61× | 0.22× | Embind | 0.71× |
| dom-query | bulk: total ms | C | 11.39 ms | 1.01× | 0.76× | 0.61× | Embind | 569.75× |
| dom-query | bulk: total ms | C++ | 14.26 ms | 1.30× | 0.79× | 0.80× | Embind | 713.00× |
| dom-query | bulk: total ms | Rust | 10.20 ms | 0.93× | 0.73× | 0.59× | Embind | 509.75× |
| dom-query | individual: µs/element | C | 0.93 µs | 0.65× | 0.59× | 0.18× | Embind | 0.69× |
| dom-query | individual: µs/element | C++ | 1.17 µs | 0.89× | 0.66× | 0.25× | Embind | 0.87× |
| dom-query | individual: µs/element | Rust | 0.95 µs | 0.87× | 0.61× | 0.22× | Embind | 0.71× |
| dom-traversal | build | C | 50.52 ms | 1.12× | 0.83× | 0.26× | EM_JS | 2.63× |
| dom-traversal | build | C++ | 43.49 ms | 0.90× | 0.77× | 0.21× | EM_JS | 2.26× |
| dom-traversal | build | Rust | 44.09 ms | 0.92× | 0.84× | 0.21× | EM_JS | 2.30× |
| dom-traversal | traverse (total) | C | 14.74 ms | 1.18× | 0.83× | 0.17× | EM_JS | 3.53× |
| dom-traversal | traverse (total) | C++ | 13.90 ms | 0.93× | 0.77× | 0.13× | EM_JS | 3.33× |
| dom-traversal | traverse (total) | Rust | 18.24 ms | 1.19× | 0.68× | 0.16× | EM_JS | 4.37× |
| dom-traversal | traverse (per node) | C | 0.75 µs | 1.18× | 0.83× | 0.17× | EM_JS | 3.54× |
| dom-traversal | traverse (per node) | C++ | 0.71 µs | 0.93× | 0.77× | 0.13× | EM_JS | 3.34× |
| dom-traversal | traverse (per node) | Rust | 0.93 µs | 1.19× | 0.68× | 0.16× | EM_JS | 4.38× |
| string-marshalling | set 8 B | C | 0.40 µs | 0.47× | 0.66× | 0.14× | EM_JS | 1.23× |
| string-marshalling | set 8 B | C++ | 0.44 µs | 0.54× | 0.67× | 0.17× | EM_JS | 1.36× |
| string-marshalling | set 8 B | Rust | 0.36 µs | 0.42× | 0.76× | 0.12× | EM_JS | 1.13× |
| string-marshalling | get 8 B | C | 0.59 µs | 0.28× | 0.25× | 0.12× | EM_JS | 3.27× |
| string-marshalling | get 8 B | C++ | 0.50 µs | 0.20× | 0.24× | 0.11× | EM_JS | 2.75× |
| string-marshalling | get 8 B | Rust | 0.54 µs | 0.24× | 0.25× | 0.11× | EM_JS | 2.96× |
| string-marshalling | set 128 B | C | 0.58 µs | 0.78× | 0.90× | 0.16× | wasm-bindgen | 1.09× |
| string-marshalling | set 128 B | C++ | 0.62 µs | 0.98× | 0.88× | 0.17× | wasm-bindgen | 1.17× |
| string-marshalling | set 128 B | Rust | 0.57 µs | 0.74× | 1.04× | 0.16× | wasm-bindgen | 1.08× |
| string-marshalling | get 128 B | C | 1.76 µs | 0.75× | 0.67× | 0.42× | wasm-bindgen | 2.00× |
| string-marshalling | get 128 B | C++ | 1.77 µs | 0.71× | 0.73× | 0.40× | wasm-bindgen | 2.01× |
| string-marshalling | get 128 B | Rust | 1.71 µs | 0.68× | 0.71× | 0.37× | wasm-bindgen | 1.94× |
| string-marshalling | set 1024 B | C | 0.93 µs | 0.90× | 0.99× | 0.31× | wasm-bindgen | 1.09× |
| string-marshalling | set 1024 B | C++ | 0.98 µs | 0.92× | 0.96× | 0.31× | wasm-bindgen | 1.15× |
| string-marshalling | set 1024 B | Rust | 0.97 µs | 0.86× | 0.96× | 0.27× | wasm-bindgen | 1.13× |
| string-marshalling | get 1024 B | C | 1.73 µs | 0.15× | 0.45× | 0.27× | wasm-bindgen | 0.33× |
| string-marshalling | get 1024 B | C++ | 1.95 µs | 0.18× | 0.45× | 0.29× | wasm-bindgen | 0.37× |
| string-marshalling | get 1024 B | Rust | 1.90 µs | 0.37× | 0.48× | 0.27× | wasm-bindgen | 0.36× |
| string-marshalling | set 16384 B | C | 6.40 µs | 0.91× | 1.00× | 0.73× | wasm-bindgen | 0.94× |
| string-marshalling | set 16384 B | C++ | 6.93 µs | 0.96× | 1.01× | 0.78× | wasm-bindgen | 1.02× |
| string-marshalling | set 16384 B | Rust | 7.02 µs | 1.01× | 1.00× | 0.66× | wasm-bindgen | 1.03× |
| string-marshalling | get 16384 B | C | 16.73 µs | 0.48× | 0.53× | 0.36× | wasm-bindgen | 0.20× |
| string-marshalling | get 16384 B | C++ | 17.89 µs | 0.50× | 0.51× | 0.37× | wasm-bindgen | 0.21× |
| string-marshalling | get 16384 B | Rust | 17.41 µs | 0.29× | 0.55× | 0.31× | wasm-bindgen | 0.21× |
| string-marshalling | set 262144 B | C | 100.90 µs | 0.40× | 0.71× | 0.43× | Embind | 0.90× |
| string-marshalling | set 262144 B | C++ | 108.10 µs | 0.43× | 0.70× | 0.44× | Embind | 0.96× |
| string-marshalling | set 262144 B | Rust | 104.15 µs | 0.42× | 0.95× | 0.37× | Embind | 0.93× |
| string-marshalling | get 262144 B | C | 254.70 µs | 0.26× | 0.29× | 0.37× | wasm-bindgen | 0.20× |
| string-marshalling | get 262144 B | C++ | 276.15 µs | 0.28× | 0.30× | 0.39× | wasm-bindgen | 0.22× |
| string-marshalling | get 262144 B | Rust | 263.50 µs | 0.30× | 0.29× | 0.32× | wasm-bindgen | 0.21× |
| table-update | create: total ms | C | 13.76 ms | 1.14× | 1.01× | 0.19× | EM_JS | 2.45× |
| table-update | create: total ms | C++ | 13.26 ms | 0.97× | 0.94× | 0.20× | EM_JS | 2.36× |
| table-update | create: total ms | Rust | 13.90 ms | 0.96× | 0.95× | 0.22× | EM_JS | 2.48× |
| table-update | create: µs/row | C | 6.88 µs | 1.14× | 1.01× | 0.19× | EM_JS | 2.45× |
| table-update | create: µs/row | C++ | 6.63 µs | 0.97× | 0.94× | 0.20× | EM_JS | 2.36× |
| table-update | create: µs/row | Rust | 6.95 µs | 0.96× | 0.95× | 0.22× | EM_JS | 2.48× |
| table-update | update (selected): total ms | C | 1.02 ms | 1.16× | 0.89× | 0.30× | wasm-bindgen | 1.08× |
| table-update | update (selected): total ms | C++ | 1.24 ms | 1.10× | 0.89× | 0.36× | wasm-bindgen | 1.31× |
| table-update | update (selected): total ms | Rust | 1.02 ms | 0.94× | 0.97× | 0.35× | wasm-bindgen | 1.08× |
| table-update | update (selected): µs/row | C | 0.51 µs | 1.16× | 0.89× | 0.30× | wasm-bindgen | 1.08× |
| table-update | update (selected): µs/row | C++ | 0.62 µs | 1.10× | 0.89× | 0.36× | wasm-bindgen | 1.31× |
| table-update | update (selected): µs/row | Rust | 0.51 µs | 0.94× | 0.97× | 0.35× | wasm-bindgen | 1.09× |
| table-update | clear (unselected): total ms | C | 3.71 ms | 1.06× | 0.75× | 0.22× | wasm-bindgen | 1.62× |
| table-update | clear (unselected): total ms | C++ | 2.71 ms | 0.65× | 0.75× | 0.16× | wasm-bindgen | 1.18× |
| table-update | clear (unselected): total ms | Rust | 3.55 ms | 0.90× | 0.83× | 0.26× | wasm-bindgen | 1.55× |
| table-update | clear (unselected): µs/row | C | 1.86 µs | 1.06× | 0.75× | 0.22× | wasm-bindgen | 1.62× |
| table-update | clear (unselected): µs/row | C++ | 1.35 µs | 0.65× | 0.75× | 0.16× | wasm-bindgen | 1.18× |
| table-update | clear (unselected): µs/row | Rust | 1.77 µs | 0.90× | 0.83× | 0.26× | wasm-bindgen | 1.55× |

</details>

### Payload and startup

Payload medians cover 34 component inputs. Compression is per file. Startup is the median of the 21 per-workload and guest medians, from dynamic import through initialization, with browser caching disabled.

| Build | JS (KiB) | Core Wasm (KiB) | Total (KiB) | Gzip (KiB) | Brotli (KiB) | Startup (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 | 19.4 | 64.4 | 85.4 | 29.3 | 24.1 | 10.31 |
| Stock main | 180.9 | 64.4 | 252.3 | 57.7 | 47.8 | 24.42 |
| Candidate | 139.0 | 64.4 | 206.5 | 51.6 | 42.9 | 21.00 |

### What ships with `--minify`

Each Jco build generated its default and minified distribution from the same 34 components. Jco 1.13.0 uses Terser for its minify option. Stock main and the branch use Oxc. All external Wasm files matched byte for byte across formats. Payloads include JavaScript and external Wasm, compressed per file. Chromium interleaved the six distributions across 630 fresh pages, with 5 rounds for each of the 21 guest and workload combinations. The two ratio columns compare each format to that build’s default for the same guest and workload, then take the median of the 21 ratios. The final column compares workload times to the same format of 1.13.0. [Distribution sizes](web/bench/results/minified-sizes.json) · [Timings and resource requests](web/bench/results/minified-browser.json)

| Distribution | JS (KiB) | Total gzip (KiB) | Total Brotli (KiB) | Startup (ms) | Startup / default | Runtime / default | At or below 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 default | 19.4 | 29.3 | 24.1 | 10.32 | 1.00× | 1.00× | 21/21 |
| 1.13.0 minified | 8.7 | 28.8 | 23.7 | 10.24 | 0.98× | 0.94× | 21/21 |
| Stock main default | 180.9 | 57.7 | 47.8 | 23.88 | 1.00× | 1.00× | 2/21 |
| Stock main minified | 105.0 | 50.8 | 42.8 | 21.33 | 0.91× | 1.02× | 4/21 |
| Candidate default | 139.0 | 51.6 | 42.9 | 20.66 | 1.00× | 1.00× | 15/21 |
| Candidate minified | 77.0 | 45.7 | 38.7 | 18.73 | 0.90× | 1.00× | 16/21 |

Chromium’s Resource Timing entries give four consecutive intervals from the start of dynamic import until the module is ready. The gap before the first Wasm request includes resolving dependencies and executing JavaScript. The local server served uncompressed assets with caching disabled. Browser response-body sizes were checked against the generated file sizes. Each column reports its own median over workload medians.

| Distribution | Import to JS response end (ms) | JS response end to first Wasm request (ms) | First Wasm request to last Wasm response (ms) | Last Wasm response to ready (ms) |
| --- | --- | --- | --- | --- |
| 1.13.0 default | 2.12 | 3.08 | 2.22 | 2.86 |
| 1.13.0 minified | 2.14 | 2.74 | 2.27 | 2.87 |
| Stock main default | 2.30 | 15.07 | 2.29 | 3.93 |
| Stock main minified | 2.25 | 13.02 | 2.28 | 3.92 |
| Candidate default | 2.34 | 12.24 | 2.19 | 3.97 |
| Candidate minified | 2.17 | 10.21 | 2.25 | 3.82 |

Minifying the branch reduced startup by 10% on the median same-workload comparison. Its median import-to-ready time was 18.73 ms, compared with 10.24 ms for minified 1.13.0. Between the end of the entry JavaScript response and the first Wasm request, the corresponding medians were 10.21 and 2.74 ms.

![Default and minified gzip payloads and fresh-page startup for three Jco builds](web/bench/results/minified-startup.png)

### Startup with DevTools disconnected

In 1,260 fresh documents, the page timed its own dynamic import, ran the guest and sent the result to a local server. One browser kept the Puppeteer DevTools connection open. The other disconnected before the first measured navigation. Both navigated the same tab, with matching Chrome flags, no-store responses and verified network transfers. The order of the two browsers alternated over 5 rounds. Each table cell is the median of the 21 workload medians. [Observer timings](web/bench/results/startup-observer.json)

| Distribution | Attached startup (ms) | Detached startup (ms) | Attached JS end to Wasm request (ms) | Detached JS end to Wasm request (ms) |
| --- | --- | --- | --- | --- |
| 1.13.0 default | 8.70 | 6.14 | 3.07 | 1.69 |
| 1.13.0 minified | 7.79 | 6.06 | 2.57 | 1.66 |
| Stock main default | 21.81 | 14.56 | 14.92 | 8.62 |
| Stock main minified | 20.38 | 13.41 | 13.19 | 7.49 |
| Candidate default | 18.02 | 12.21 | 11.13 | 6.56 |
| Candidate minified | 16.09 | 11.59 | 9.67 | 6.12 |

### Generated JavaScript reached by each demo

Chromium recorded block coverage on 126 fresh pages in a separate run. One page imported each module and finished initialization. A second also ran the demo once and checked its output. The table reports medians over the 21 guest and workload combinations. Sizes count UTF-8 bytes in V8’s covered source ranges. A demo can leave error handling, shutdown or other supported operations unexercised. [Per-module coverage and hashes](web/bench/results/js-coverage.json)

| Build | Reached at init (KiB) | Reached through first run (KiB) | Share through first run | Unreached through first run (KiB) |
| --- | --- | --- | --- | --- |
| 1.13.0 | 4.8 | 16.3 | 76.6% | 5.0 |
| Stock main | 54.0 | 96.4 | 51.2% | 91.3 |
| Candidate | 40.1 | 64.4 | 45.6% | 77.0 |

<details><summary>Candidate startup, variation and paired comparison to 1.13.0</summary>

The paired ratio divides the candidate time by the 1.13.0 time within each round, then takes the median. The final column counts rounds where the candidate was at least as fast.

| Operation | Guest | Startup median (ms) | Warm phase p25 | Warm phase p50 | Warm phase p75 | Phase unit | Paired ratio to 1.13.0 | Rounds at or below 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | 20.78 | 0.55 | 0.63 | 0.74 | µs | 0.58× | 7/7 |
| Attribute write | C++ | 18.28 | 0.52 | 0.56 | 0.58 | µs | 0.49× | 7/7 |
| Attribute write | Rust | 18.48 | 0.74 | 0.80 | 0.81 | µs | 0.57× | 7/7 |
| Canvas fillRect | C | 22.17 | 0.98 | 1.01 | 1.22 | µs | 1.08× | 2/7 |
| Canvas fillRect | C++ | 21.54 | 0.88 | 0.99 | 1.15 | µs | 1.02× | 3/7 |
| Canvas fillRect | Rust | 20.97 | 0.77 | 0.83 | 0.93 | µs | 0.96× | 5/7 |
| Canvas pixel read | C | 21.54 | 280.30 | 312.50 | 324.90 | µs | 0.96× | 5/7 |
| Canvas pixel read | C++ | 21.25 | 312.75 | 317.90 | 347.35 | µs | 1.01× | 2/7 |
| Canvas pixel read | Rust | 19.99 | 321.00 | 330.50 | 346.55 | µs | 1.08× | 3/7 |
| DOM ID lookup | C | 21.00 | 0.90 | 0.93 | 1.22 | µs | 0.84× | 5/7 |
| DOM ID lookup | C++ | 21.64 | 1.09 | 1.17 | 1.30 | µs | 0.91× | 6/7 |
| DOM ID lookup | Rust | 20.37 | 0.86 | 0.95 | 0.98 | µs | 0.79× | 6/7 |
| Tree traversal | C | 21.92 | 14.52 | 14.74 | 16.01 | ms | 1.17× | 2/7 |
| Tree traversal | C++ | 20.57 | 13.54 | 13.90 | 14.62 | ms | 1.01× | 3/7 |
| Tree traversal | Rust | 23.03 | 16.58 | 18.24 | 18.70 | ms | 1.22× | 2/7 |
| Read 1 KiB string | C | 19.12 | 1.67 | 1.73 | 1.81 | µs | 0.16× | 7/7 |
| Read 1 KiB string | C++ | 18.74 | 1.88 | 1.95 | 2.03 | µs | 0.17× | 7/7 |
| Read 1 KiB string | Rust | 19.59 | 1.80 | 1.90 | 2.05 | µs | 0.37× | 7/7 |
| Table creation | C | 22.06 | 11.99 | 13.76 | 14.56 | ms | 1.12× | 3/7 |
| Table creation | C++ | 21.49 | 10.80 | 13.26 | 15.04 | ms | 0.91× | 4/7 |
| Table creation | Rust | 21.48 | 13.70 | 13.90 | 16.13 | ms | 1.07× | 3/7 |

</details>

[Raw browser timings](web/bench/results/candidate-browser.json) · [File sizes, digests and generator revision](web/bench/results/candidate-sizes.json)

### Reproduce the candidate run

Run the dependency installation, main setup and size commands in [Reproduce the comparison](#reproduce-the-comparison), then run the following from the repository root. Cargo uses the Jco checkout’s pinned toolchain and lockfile.

```sh
git clone https://github.com/vados-cosmonic/jco ../jco-candidate
git -C ../jco-candidate checkout d21cb546b5013233b3036937794968b0ac8161f5
node web/bench/candidate.mjs ../jco-candidate
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

<!-- candidate:end -->

<!-- benchmark:start -->

## Browser performance

**jco 1.13.0 vs. main at `3e5c5227`** · 2026-11-26 · HeadlessChrome/156.0.8078.47 · Intel(R) Xeon(R) Processor @ 2.60GHz · linux 6.12.111 x64 · Node v26.13.0. [Upstream commit](https://github.com/bytecodealliance/jco/commit/3e5c52279b7ad45b8f15a2bca07569364c8d0c3f) · [Transpiler build](https://github.com/bytecodealliance/jco/actions/runs/45731701560)

These stock and shim timings come from the same interleaved fresh-page trial as the performance branch. [Full trial](web/bench/results/candidate-browser.json) · [Stock and shim samples](web/bench/results/browser.json)

Across the seven operations below and three guest languages, main took longer in **17 of 21** median comparisons. The highest ratio was **7.28×** for the C++ guest in `dom-traversal`.

For 256 KiB string reads, the median time on main changed by -31% to -7% across the three guest languages. The phase tables below include every tested string size.

Each cell is the median of 7 fresh-page samples. The chart divides main’s median time by 1.13.0’s for the same guest and operation. A value below 1× means main finished faster.

![Median time on main divided by baseline time for seven operations and three guest languages](web/bench/results/runtime.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 0.281 | 1.27 | — | — | 1.24 | 3.72 | 1.14 | 3.72 | 1.35 | 4.10 |
| Canvas fillRect (µs) | 0.762 | 1.76 | — | — | 0.948 | 3.37 | 0.943 | 3.77 | 0.87 | 3.70 |
| Canvas pixel read (µs) | 167.30 | 186.80 | — | — | 322.30 | 304.60 | 342.30 | 339.40 | 301.50 | 334.10 |
| DOM ID lookup (µs) | 0.289 | 1.34 | — | — | 1.42 | 5.08 | 1.31 | 4.75 | 1.09 | 4.33 |
| Tree traversal (ms) | 0.875 | 24.26 | 4.17 | 5.31 | 12.50 | 86.78 | 14.91 | 108.51 | 15.37 | 110.99 |
| Read 1 KiB string (µs) | 0.105 | 11.66 | 9.31 | 5.29 | 11.65 | 6.43 | 10.96 | 6.74 | 5.19 | 6.95 |
| Table creation (ms) | 3.56 | 16.84 | 5.61 | 9.09 | 12.07 | 73.43 | 13.60 | 67.84 | 14.42 | 62.40 |

Embind and EM_JS are the C++ Emscripten variants. An em dash marks an unavailable combination. Across toolchains, the upstream implementations can do different amounts of work. For example, the JavaScript bulk DOM query obtains a live collection while the component host materializes a list.

<details><summary>Run-to-run variation for the two jco versions</summary>

Each cell spans the 25th to 75th percentile of measured times, using linear interpolation between sorted samples.

| Operation | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 1.22–1.31 | 3.53–3.85 | 1.12–1.27 | 3.63–3.90 | 1.31–1.38 | 3.80–4.35 |
| Canvas fillRect (µs) | 0.934–1.10 | 3.24–3.67 | 0.87–0.986 | 3.28–4.04 | 0.804–1.05 | 3.11–3.82 |
| Canvas pixel read (µs) | 300.35–325.85 | 299.10–321.35 | 284.90–344.30 | 318.00–347.85 | 293.75–420.95 | 327.70–352.80 |
| DOM ID lookup (µs) | 1.05–1.51 | 4.92–5.24 | 1.20–1.37 | 4.42–5.29 | 1.03–1.24 | 4.21–4.59 |
| Tree traversal (ms) | 10.65–15.71 | 84.45–101.73 | 13.93–15.21 | 103.91–111.65 | 13.92–16.43 | 106.67–112.98 |
| Read 1 KiB string (µs) | 4.01–15.78 | 6.39–7.36 | 4.75–18.92 | 6.44–7.08 | 4.45–29.99 | 6.55–7.81 |
| Table creation (ms) | 11.60–13.28 | 68.41–74.45 | 11.74–14.23 | 65.92–69.68 | 13.38–15.32 | 58.54–66.85 |

</details>

<details><summary>All workload phases, per-call timings, and string transfer rates</summary>

Times come from the tables rendered by the demos and retain their original reporting precision. Effective string throughput uses the ASCII payload length divided by median call time (decimal MB/s).

**attribute-churn**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total time (ms) | 22.46 | 101.55 | — | — | 98.98 | 297.42 | 90.92 | 297.62 | 108.38 | 327.87 |
| per setAttribute() (µs) | 0.281 | 1.27 | — | — | 1.24 | 3.72 | 1.14 | 3.72 | 1.35 | 4.10 |

**canvas-draw**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total (ms) | 38.12 | 87.81 | — | — | 47.39 | 168.41 | 47.16 | 188.25 | 43.49 | 184.93 |
| per fill_rect() (µs) | 0.762 | 1.76 | — | — | 0.948 | 3.37 | 0.943 | 3.77 | 0.87 | 3.70 |

**canvas-pixels**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| getImageData() (µs) | 167.30 | 186.80 | — | — | 322.30 | 304.60 | 342.30 | 339.40 | 301.50 | 334.10 |
| putImageData() (µs) | 12.60 | 180.90 | — | — | 248.60 | 280.50 | 233.20 | 278.30 | 258.30 | 324.50 |

**dom-query**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| individual, total (ms) | 5.77 | 26.85 | — | — | 28.39 | 101.58 | 26.18 | 94.99 | 21.77 | 86.52 |
| bulk, total (ms) | 0.01 | 0.02 | — | — | 11.30 | 18.54 | 11.00 | 17.79 | 11.02 | 17.27 |
| individual: µs/element (µs) | 0.289 | 1.34 | — | — | 1.42 | 5.08 | 1.31 | 4.75 | 1.09 | 4.33 |

**dom-traversal**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| build (ms) | 9.66 | 37.81 | 19.21 | 25.64 | 45.30 | 195.63 | 48.42 | 210.86 | 47.93 | 208.38 |
| traverse (total) (ms) | 0.875 | 24.26 | 4.17 | 5.31 | 12.50 | 86.78 | 14.91 | 108.51 | 15.37 | 110.99 |
| traverse (per node) (µs) | 0.045 | 1.24 | 0.213 | 0.272 | 0.64 | 4.44 | 0.763 | 5.56 | 0.787 | 5.68 |

**string-marshalling**

![Median DOM textContent set and get latency by payload length for each guest and jco version, on logarithmic axes](web/bench/results/strings.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| set 8 B (µs) | 0.176 | 0.762 | 0.323 | 0.522 | 0.851 | 2.79 | 0.818 | 2.58 | 0.869 | 3.17 |
| set 8 B (MB/s) | 45.45 | 10.50 | 24.77 | 15.33 | 9.40 | 2.87 | 9.78 | 3.10 | 9.21 | 2.52 |
| get 8 B (µs) | 0.082 | 0.909 | 0.182 | 0.216 | 2.14 | 5.06 | 2.53 | 4.41 | 2.23 | 5.09 |
| get 8 B (MB/s) | 97.56 | 8.80 | 43.96 | 37.04 | 3.74 | 1.58 | 3.16 | 1.81 | 3.59 | 1.57 |
| set 128 B (µs) | 0.297 | 1.06 | 0.704 | 0.53 | 0.74 | 3.56 | 0.636 | 3.59 | 0.782 | 3.61 |
| set 128 B (MB/s) | 430.98 | 120.41 | 181.82 | 241.51 | 172.97 | 36.01 | 201.26 | 35.63 | 163.68 | 35.43 |
| get 128 B (µs) | 0.089 | 2.25 | 1.24 | 0.881 | 2.37 | 4.17 | 2.48 | 4.45 | 2.51 | 4.56 |
| get 128 B (MB/s) | 1,438.20 | 57.02 | 103.06 | 145.29 | 54.10 | 30.70 | 51.53 | 28.78 | 51.02 | 28.05 |
| set 1024 B (µs) | 0.963 | 1.47 | 2.62 | 0.854 | 1.03 | 2.97 | 1.07 | 3.13 | 1.13 | 3.64 |
| set 1024 B (MB/s) | 1,063.34 | 696.60 | 390.69 | 1,199.06 | 990.33 | 344.90 | 955.22 | 326.74 | 906.19 | 281.24 |
| get 1024 B (µs) | 0.105 | 11.66 | 9.31 | 5.29 | 11.65 | 6.43 | 10.96 | 6.74 | 5.19 | 6.95 |
| get 1024 B (MB/s) | 9,752.38 | 87.83 | 110.00 | 193.39 | 87.92 | 159.15 | 93.42 | 151.91 | 197.15 | 147.34 |
| set 16384 B (µs) | 12.18 | 7.90 | 30.85 | 6.79 | 7.07 | 8.73 | 7.20 | 8.84 | 6.97 | 10.67 |
| set 16384 B (MB/s) | 1,345.38 | 2,074.71 | 531.09 | 2,411.54 | 2,317.73 | 1,876.53 | 2,276.50 | 1,854.02 | 2,349.97 | 1,536.10 |
| get 16384 B (µs) | 0.443 | 158.25 | 145.75 | 83.70 | 34.86 | 47.06 | 35.52 | 48.21 | 59.05 | 57.05 |
| get 16384 B (MB/s) | 36,984.20 | 103.53 | 112.41 | 195.75 | 469.97 | 348.13 | 461.20 | 339.83 | 277.46 | 287.19 |
| set 262144 B (µs) | 167.97 | 112.55 | 496.80 | 243.85 | 252.05 | 234.40 | 251.70 | 243.00 | 246.10 | 277.90 |
| set 262144 B (MB/s) | 1,560.67 | 2,329.13 | 527.67 | 1,075.02 | 1,040.05 | 1,118.36 | 1,041.49 | 1,078.78 | 1,065.19 | 943.30 |
| get 262144 B (µs) | 11.55 | 2,535.15 | 2,314.55 | 1,281.70 | 985.25 | 682.60 | 980.35 | 704.25 | 892.90 | 830.95 |
| get 262144 B (MB/s) | 22,700.38 | 103.40 | 113.26 | 204.53 | 266.07 | 384.04 | 267.40 | 372.23 | 293.59 | 315.48 |

**table-update**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create, total (ms) | 3.56 | 16.84 | 5.61 | 9.09 | 12.07 | 73.43 | 13.60 | 67.84 | 14.42 | 62.40 |
| create, per row (µs) | 1.78 | 8.42 | 2.81 | 4.54 | 6.04 | 36.72 | 6.80 | 33.92 | 7.21 | 31.20 |
| update (selected), total (ms) | 0.435 | 1.18 | 1.00 | 0.945 | 0.885 | 3.42 | 1.12 | 3.43 | 1.09 | 2.90 |
| update (selected), per row (µs) | 0.218 | 0.588 | 0.502 | 0.472 | 0.443 | 1.71 | 0.56 | 1.72 | 0.545 | 1.45 |
| clear (unselected), total (ms) | 1.61 | 4.00 | 3.40 | 2.29 | 3.49 | 16.66 | 4.16 | 17.33 | 3.94 | 13.87 |
| clear (unselected), per row (µs) | 0.805 | 2.00 | 1.70 | 1.15 | 1.75 | 8.33 | 2.08 | 8.66 | 1.97 | 6.93 |

</details>

<details><summary>Module load and initialization, median milliseconds</summary>

Elapsed browser time for dynamic import through instantiation, with the shared demo host already loaded. The browser process is reused, each page has HTTP caching disabled, and assets are served uncompressed over loopback. These timings include scheduling and local requests. JS is already loaded by the harness.

| Workload | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| attribute-churn | 13.52 | — | — | 10.69 | 26.31 | 10.47 | 24.81 | 10.31 | 22.20 |
| canvas-draw | 13.01 | — | — | 9.96 | 24.42 | 10.22 | 26.00 | 10.52 | 24.11 |
| canvas-pixels | 13.62 | — | — | 10.26 | 26.36 | 10.66 | 26.27 | 10.52 | 24.59 |
| dom-query | 13.81 | — | — | 9.45 | 22.96 | 10.22 | 23.56 | 11.30 | 23.11 |
| dom-traversal | 13.60 | 8.73 | 8.67 | 10.66 | 27.41 | 10.48 | 22.81 | 10.16 | 25.57 |
| string-marshalling | 11.93 | 8.21 | 7.33 | 9.57 | 21.94 | 9.61 | 24.26 | 9.24 | 22.06 |
| table-update | 14.50 | 8.66 | 8.44 | 10.75 | 26.54 | 10.26 | 24.26 | 10.31 | 25.02 |

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

Across 34 component inputs, the median change in gzip payload on main was **+27.2 KiB** per component (range +19.8 to +30.4 KiB). The payload sums the emitted JavaScript and external core Wasm files, including any Wasm inlined into JavaScript. Gzip level 9 and Brotli quality 11 are applied per file. Shared host code, HTML, type declarations and HTTP headers are excluded. The raw JavaScript reference lives in the demo page controller.

All external core Wasm files match byte for byte between the two generators. The size differences come entirely from the emitted JavaScript.

![Gzip payload in KiB for the seven browser workloads, grouped by guest language](web/bench/results/payload.png)

**DOM traversal download size** in KiB, gzip. Each row compares implementations from one guest language.

| Guest | Native component | jco 1.13.0 | jco main | Embind | EM_JS | wasm-bindgen |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| C | 26.4 | 28.5 | 55.7 | — | — | — |
| C++ | 26.9 | 29.0 | 56.2 | 21.4 | 14.2 | — |
| Rust | 50.6 | 52.7 | 79.8 | — | — | 27.0 |

<details><summary>All component sizes, in KiB</summary>

Paired columns list **1.13.0 / main**. Native is the original component binary. Core Wasm counts only separate .wasm files.

| Component | Native | Files | JS | Core Wasm | Raw total | Gzip | Brotli |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| C attribute-churn | 65.1 | 2 / 2 | 19.0 / 174.9 | 61.4 / 61.4 | 80.5 / 236.4 | 28.4 / 55.5 | 23.3 / 46.0 |
| C calculator | 0.9 | 1 / 1 | 2.3 / 98.8 | 0.0 / 0.0 | 2.3 / 98.8 | 1.3 / 21.1 | 1.2 / 18.1 |
| C canvas-draw | 66.5 | 2 / 2 | 22.6 / 189.4 | 61.9 / 61.9 | 84.6 / 251.3 | 28.6 / 56.1 | 23.6 / 46.4 |
| C canvas-pixels | 70.1 | 2 / 2 | 24.2 / 207.8 | 64.7 / 64.7 | 88.9 / 272.5 | 29.7 / 60.1 | 24.5 / 49.8 |
| C dom-query | 68.0 | 2 / 2 | 22.0 / 191.2 | 63.7 / 63.7 | 85.6 / 254.8 | 29.2 / 58.0 | 24.0 / 48.0 |
| C dom-traversal | 66.0 | 2 / 2 | 21.1 / 182.4 | 62.0 / 62.0 | 83.1 / 244.4 | 28.5 / 55.7 | 23.4 / 46.1 |
| C greet-bindgen | 56.3 | 2 / 2 | 2.6 / 106.2 | 55.9 / 55.9 | 58.5 / 162.2 | 24.3 / 45.9 | 20.0 / 38.4 |
| C greet-freestanding | 0.9 | 1 / 1 | 3.0 / 103.3 | 0.0 / 0.0 | 3.0 / 103.3 | 1.6 / 22.8 | 1.5 / 19.5 |
| C greet-libc | 54.9 | 2 / 2 | 2.6 / 106.2 | 54.5 / 54.5 | 57.1 / 160.8 | 23.8 / 45.4 | 19.5 / 38.0 |
| C hello-world | 60.4 | 2 / 2 | 13.8 / 161.2 | 57.8 / 57.8 | 71.6 / 219.0 | 26.7 / 54.1 | 22.0 / 45.0 |
| C string-marshalling | 66.2 | 2 / 2 | 19.4 / 181.9 | 62.6 / 62.6 | 82.0 / 244.6 | 28.9 / 57.4 | 23.9 / 47.7 |
| C table-update | 70.7 | 2 / 2 | 21.2 / 189.4 | 66.6 / 66.6 | 87.8 / 256.0 | 29.3 / 58.0 | 24.2 / 48.1 |
| C++ attribute-churn | 68.9 | 2 / 2 | 19.0 / 174.9 | 65.3 / 65.3 | 84.3 / 240.2 | 29.7 / 56.7 | 24.4 / 47.0 |
| C++ canvas-draw | 68.5 | 2 / 2 | 22.6 / 189.4 | 63.9 / 63.9 | 86.6 / 253.3 | 29.1 / 56.6 | 24.0 / 46.9 |
| C++ canvas-pixels | 73.1 | 2 / 2 | 24.2 / 207.8 | 67.8 / 67.8 | 91.9 / 275.6 | 30.6 / 61.0 | 25.1 / 50.3 |
| C++ dom-query | 71.7 | 2 / 2 | 22.0 / 191.2 | 67.4 / 67.4 | 89.4 / 258.6 | 30.7 / 59.5 | 25.1 / 49.2 |
| C++ dom-traversal | 68.0 | 2 / 2 | 21.1 / 182.4 | 64.0 / 64.0 | 85.1 / 246.4 | 29.0 / 56.2 | 23.8 / 46.5 |
| C++ hello-world | 60.4 | 2 / 2 | 13.8 / 161.2 | 57.8 / 57.8 | 71.6 / 219.0 | 26.6 / 53.9 | 21.9 / 44.9 |
| C++ string-marshalling | 68.3 | 2 / 2 | 19.4 / 181.9 | 64.8 / 64.8 | 84.1 / 246.7 | 29.5 / 58.0 | 24.3 / 48.1 |
| C++ table-update | 74.9 | 2 / 2 | 21.2 / 189.4 | 70.9 / 70.9 | 92.1 / 260.3 | 31.2 / 59.8 | 25.4 / 49.3 |
| Rust attribute-churn | 152.0 | 2 / 2 | 18.8 / 173.5 | 148.5 / 148.5 | 167.3 / 322.1 | 55.8 / 82.7 | 45.9 / 68.3 |
| Rust calculator-raw | 258.7 | 2 / 2 | 1.4 / 98.4 | 258.4 / 258.4 | 259.8 / 356.8 | 85.4 / 105.1 | 72.3 / 89.3 |
| Rust calculator | 258.0 | 2 / 2 | 1.4 / 98.4 | 257.7 / 257.7 | 259.1 / 356.1 | 85.1 / 104.9 | 72.1 / 89.1 |
| Rust canvas-draw | 140.9 | 2 / 2 | 22.4 / 188.0 | 136.4 / 136.4 | 158.8 / 324.4 | 53.0 / 80.3 | 43.8 / 66.6 |
| Rust canvas-pixels | 142.9 | 2 / 2 | 24.0 / 206.4 | 137.7 / 137.7 | 161.6 / 344.1 | 53.7 / 83.9 | 44.2 / 69.3 |
| Rust dom-query | 148.8 | 2 / 2 | 21.7 / 189.8 | 144.7 / 144.7 | 166.4 / 334.4 | 55.9 / 84.5 | 46.0 / 69.9 |
| Rust dom-traversal (dom_traversal.my.component) | 138.7 | 2 / 2 | 20.2 / 180.9 | 135.7 / 135.7 | 155.9 / 316.7 | 52.7 / 79.8 | 43.5 / 66.2 |
| Rust dom-traversal | 138.7 | 2 / 2 | 20.2 / 180.9 | 135.7 / 135.7 | 155.9 / 316.7 | 52.7 / 79.8 | 43.5 / 66.2 |
| Rust hello-world | 17.4 | 2 / 2 | 13.6 / 159.9 | 14.9 / 14.9 | 28.5 / 174.7 | 8.9 / 36.0 | 7.4 / 30.3 |
| Rust string-marshalling | 146.9 | 2 / 2 | 19.1 / 180.6 | 143.4 / 143.4 | 162.5 / 323.9 | 55.2 / 83.5 | 45.6 / 69.3 |
| Rust table-rows | 33.3 | 2 / 2 | 13.1 / 157.2 | 31.1 / 31.1 | 44.2 / 188.3 | 16.2 / 42.6 | 14.0 / 36.2 |
| Rust table-update | 149.5 | 2 / 2 | 20.6 / 188.6 | 146.2 / 146.2 | 166.8 / 334.8 | 56.1 / 84.7 | 46.3 / 70.2 |
| Rust todomvc | 14.4 | 2 / 2 | 15.3 / 161.8 | 11.6 / 11.6 | 26.8 / 173.4 | 7.6 / 34.0 | 6.5 / 28.7 |
| Rust vdom-diff | 40.9 | 2 / 2 | 14.8 / 161.6 | 38.5 / 38.5 | 53.3 / 200.2 | 19.7 / 46.2 | 17.0 / 39.3 |

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
