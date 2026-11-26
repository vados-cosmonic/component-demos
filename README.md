# Component demos

This fork benchmarks the browser examples from [eqrion/component-demos at d0b9dd1](https://github.com/eqrion/component-demos/tree/d0b9dd1390a300978193adc623838fef4e4b632b). It runs the same compiled C, C++, and Rust WebAssembly components through jco 1.13.0, pinned upstream main, and a branch that optimizes synchronous host imports. The comparison also includes the demos’ JavaScript, Emscripten (Embind and EM_JS), and Rust wasm-bindgen implementations where available.

The performance branch also specializes UTF-8 conversion in both directions. For strings of up to 32 ASCII bytes, the bindings read or write the bytes directly. Non-ASCII text uses the checked codec, including its malformed-input traps. [Short-string changes](https://github.com/vados-cosmonic/jco/compare/ac28d5d481f3cfca94bc4c62f3571511c19386d9...9eeb7f0b9ab82a982810af5cdd1d9035b302aa39)

For longer host-returned strings, the runtime can encode into a reusable buffer before allocating guest memory. On the preceding upstream revision, a 16 KiB read took 26–28 µs across C, C++, and Rust, or 46–50% of the time for 1.13.0. The archived run compares the bindings immediately before and after this change. [UTF-8 benchmark and raw measurements](https://github.com/vados-cosmonic/component-demos/blob/7550fa7523931f918b6bd599174af07e6537961b/README.md#optimized-browser-bindings)

<!-- candidate:start -->

## Optimized browser bindings

The branch uses js-component-bindgen’s internal Oxc bundler and the checked jco-cm-runtime. [Measured Jco commit `d7ac58241`](https://github.com/vados-cosmonic/jco/commit/d7ac58241e950ad78e950663509c3c34cee599bf) · [Payload and startup](#payload-and-startup) · [Reproduction commands](#reproduce-the-candidate-run)

All Jco builds used the same guest binaries. Each value is the median of 7 fresh-page samples with one warm-up per page. The run collected 728 samples on 2026-11-26 with HeadlessChrome/156.0.8078.47 on Intel(R) Xeon(R) Processor @ 2.60GHz.

The candidate finished within **10× of the fastest available compiled shim in 21/21** headline comparisons. The largest ratio was **4.57×**. On separate fresh pages it matched or beat **1.13.0 in 15/21** and **stock main in 19/21**. On the same warmed page it matched or beat **1.13.0 in 19/21** headline cases and 80/84 across all phases. The shim comparison selects the lowest median among Embind, EM_JS and wasm-bindgen for each operation, including shims written in a different guest language. The phase tables in the original comparison describe workload differences and include raw JavaScript.

![Candidate runtime relative to the two targets by operation and language](web/bench/results/candidate-runtime.png)

| Operation | Guest | Unit | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Fastest shim | Shim time | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | µs | 1.24 | 3.69 | 0.65 | 0.52× | Embind | 1.18 | 0.55× |
| Attribute write | C++ | µs | 1.26 | 3.81 | 0.62 | 0.49× | Embind | 1.18 | 0.53× |
| Attribute write | Rust | µs | 1.38 | 4.15 | 0.85 | 0.61× | Embind | 1.18 | 0.72× |
| Canvas fillRect | C | µs | 1.05 | 3.41 | 0.89 | 0.85× | Embind | 1.47 | 0.61× |
| Canvas fillRect | C++ | µs | 1.02 | 3.85 | 0.98 | 0.96× | Embind | 1.47 | 0.67× |
| Canvas fillRect | Rust | µs | 1.02 | 3.55 | 0.92 | 0.90× | Embind | 1.47 | 0.62× |
| Canvas pixel read | C | µs | 281.80 | 337.50 | 314.80 | 1.12× | Embind | 201.40 | 1.56× |
| Canvas pixel read | C++ | µs | 320.80 | 324.80 | 338.60 | 1.06× | Embind | 201.40 | 1.68× |
| Canvas pixel read | Rust | µs | 349.10 | 347.20 | 358.40 | 1.03× | Embind | 201.40 | 1.78× |
| DOM ID lookup | C | µs | 1.14 | 4.43 | 1.03 | 0.91× | Embind | 1.45 | 0.71× |
| DOM ID lookup | C++ | µs | 1.32 | 4.46 | 0.88 | 0.66× | Embind | 1.45 | 0.60× |
| DOM ID lookup | Rust | µs | 1.07 | 5.09 | 0.82 | 0.77× | Embind | 1.45 | 0.57× |
| Tree traversal | C | ms | 14.10 | 102.08 | 14.25 | 1.01× | EM_JS | 3.67 | 3.88× |
| Tree traversal | C++ | ms | 12.65 | 100.81 | 13.37 | 1.06× | EM_JS | 3.67 | 3.64× |
| Tree traversal | Rust | ms | 14.59 | 115.49 | 16.79 | 1.15× | EM_JS | 3.67 | 4.57× |
| Read 1 KiB string | C | µs | 4.25 | 7.93 | 1.76 | 0.42× | wasm-bindgen | 5.43 | 0.32× |
| Read 1 KiB string | C++ | µs | 9.51 | 6.97 | 1.94 | 0.20× | wasm-bindgen | 5.43 | 0.36× |
| Read 1 KiB string | Rust | µs | 3.71 | 7.18 | 1.77 | 0.48× | wasm-bindgen | 5.43 | 0.33× |
| Table creation | C | ms | 13.77 | 72.81 | 12.07 | 0.88× | EM_JS | 5.50 | 2.19× |
| Table creation | C++ | ms | 12.29 | 71.58 | 11.20 | 0.91× | EM_JS | 5.50 | 2.04× |
| Table creation | Rust | ms | 15.40 | 64.17 | 12.49 | 0.81× | EM_JS | 5.50 | 2.27× |

<details><summary>How the synchronous bindings work</summary>

Eligible single-instance, synchronous components reuse the caller’s task for host imports. The adapter keeps direct references to its task stack and instance flags and checks for store interruptions. Oxc removes the asynchronous import fallback and the subtask constructor, which these imports never use. The generator skips asynchronous wrappers for synchronous allocators and post-return hooks. Standalone modules also omit suspension markers on core imports.

During a guest allocation, the checked runtime clears the instance’s may-leave flag and restores it on return or throw. Allocators in components with context-slot operations use the general guard to supply fresh slots for each call. The adapter lifts short ASCII strings four bytes at a time. Synchronous UTF-8 results of 256 to 262,144 code units can reuse a per-instance byte buffer capped at 256 KiB. The runtime encodes there before requesting the exact guest allocation. Nested calls and larger results use the ordinary encoder.

Resource drops check the instance flag and record traps. When lifting a borrowed host resource, the adapter validates the handle and reads its 32-bit representation directly. Imported host resources with automatically assigned representations use their guest handle as an array index. Explicit host representations and shared tables use a representation map. Components with async operations, cross-component resource transfers or call tracking use the general adapter.

</details>

### Change from the previous branch revision

Both revisions ran on the same guest binaries in the same browser session. Each cell divides the candidate median by the previous revision’s median. Parentheses count the rounds in which the candidate finished faster. [Compare `8400d667f` and `d7ac58241`](https://github.com/vados-cosmonic/jco/compare/8400d667ff71addffcd184046fc47bc9c99a02be...d7ac58241e950ad78e950663509c3c34cee599bf)

Generated JavaScript was smaller for 34/34 inputs. The median per-input change was -9,932 bytes of JavaScript and -1,884 bytes of total gzip payload. Across the 21 timed guest and workload combinations, the median ratio of candidate to previous startup time was 0.97×.

Both branch revisions also ran with their default output and caching disabled. The change column takes the difference for each guest and workload first, then the median of those differences.

| Startup interval | Previous (ms) | Candidate (ms) | Median change (ms) | Faster workloads |
| --- | --- | --- | --- | --- |
| Import to ready | 20.95 | 20.29 | -0.72 | 13/21 |
| Import to JS response end | 2.30 | 2.35 | +0.04 | 10/21 |
| JS end to first Wasm request | 12.68 | 11.96 | -0.83 | 18/21 |
| First Wasm request to last Wasm response | 2.23 | 2.31 | -0.01 | 11/21 |
| Last Wasm response to ready | 3.82 | 3.85 | -0.09 | 13/21 |

| Operation | C | C++ | Rust |
| --- | --- | --- | --- |
| Attribute write | 0.96× (4/7) | 0.94× (4/7) | 1.06× (1/7) |
| Canvas fillRect | 1.02× (3/7) | 1.02× (4/7) | 0.98× (4/7) |
| Canvas pixel read | 0.91× (7/7) | 1.08× (2/7) | 1.05× (2/7) |
| DOM ID lookup | 1.10× (4/7) | 0.88× (5/7) | 0.96× (5/7) |
| Tree traversal | 1.09× (2/7) | 0.86× (6/7) | 1.01× (2/7) |
| Read 1 KiB string | 0.87× (6/7) | 1.06× (3/7) | 0.93× (4/7) |
| Table creation | 0.94× (4/7) | 0.82× (5/7) | 0.94× (4/7) |
| Bulk DOM query | 1.25× (3/7) | 0.86× (6/7) | 1.09× (4/7) |
| Tree construction | 1.11× (3/7) | 0.99× (5/7) | 0.94× (4/7) |
| set 8 B | 0.96× (5/7) | 1.03× (2/7) | 0.84× (6/7) |
| get 8 B | 1.65× (1/7) | 0.99× (4/7) | 1.02× (3/7) |
| get 128 B | 1.00× (3/7) | 0.96× (4/7) | 0.96× (5/7) |
| get 16384 B | 0.92× (5/7) | 0.99× (5/7) | 0.93× (6/7) |
| get 262144 B | 0.97× (4/7) | 1.03× (4/7) | 0.94× (5/7) |

### Warm 1.13.0 comparison on the same page

For each guest and workload, both builds run once to warm up, then 4 times each on the same page. Each pair alternates which build runs first. The runner clears the DOM and performance entries before every call. It repeats this on 9 fresh pages. Each page contributes the median of its candidate / 1.13.0 ratios. The median across pages was at or below 1× for **19/21** headline cases. [Raw paired timings](web/bench/results/paired-browser.json)

![Median paired time ratios by workload and guest, with bars spanning the middle half of page ratios](web/bench/results/paired-runtime.png)

| Operation | Guest | Candidate / 1.13.0 | Middle 50% of page ratios | Pages at or below 1× |
| --- | --- | --- | --- | --- |
| Attribute write | C | 0.49× | 0.48–0.50× | 9/9 |
| Attribute write | C++ | 0.50× | 0.49–0.52× | 9/9 |
| Attribute write | Rust | 0.56× | 0.55–0.57× | 9/9 |
| Canvas fillRect | C | 0.95× | 0.94–0.97× | 7/9 |
| Canvas fillRect | C++ | 0.91× | 0.89–0.96× | 8/9 |
| Canvas fillRect | Rust | 0.93× | 0.92–0.96× | 8/9 |
| Canvas pixel read | C | 1.01× | 0.94–1.10× | 4/9 |
| Canvas pixel read | C++ | 1.00× | 0.89–1.01× | 4/9 |
| Canvas pixel read | Rust | 1.00× | 0.95–1.04× | 5/9 |
| DOM ID lookup | C | 0.61× | 0.57–0.69× | 9/9 |
| DOM ID lookup | C++ | 0.58× | 0.57–0.68× | 9/9 |
| DOM ID lookup | Rust | 0.66× | 0.60–0.76× | 9/9 |
| Tree traversal | C | 0.81× | 0.78–0.84× | 9/9 |
| Tree traversal | C++ | 0.78× | 0.69–0.80× | 9/9 |
| Tree traversal | Rust | 0.68× | 0.59–1.00× | 7/9 |
| Read 1 KiB string | C | 0.44× | 0.39–0.47× | 9/9 |
| Read 1 KiB string | C++ | 0.49× | 0.40–0.50× | 9/9 |
| Read 1 KiB string | Rust | 0.44× | 0.43–0.45× | 9/9 |
| Table creation | C | 0.90× | 0.87–1.06× | 6/9 |
| Table creation | C++ | 0.89× | 0.85–1.03× | 6/9 |
| Table creation | Rust | 0.99× | 0.93–1.01× | 6/9 |

Across all 84 reported phases and string lengths, the same-page comparison matched or beat 1.13.0 in **80/84** cases. Totals and subphases overlap.

| Slower paired phase | Guest | Metric | Candidate / 1.13.0 | Pages at or below 1× |
| --- | --- | --- | --- | --- |
| canvas-pixels | C | putImageData(): µs/call | 1.040× | 4/9 |
| canvas-pixels | Rust | putImageData(): µs/call | 1.022× | 4/9 |
| canvas-pixels | C | getImageData(): µs/call | 1.014× | 4/9 |
| canvas-pixels | C++ | getImageData(): µs/call | 1.003× | 4/9 |

Across all reported phases and string lengths, 81/84 comparable candidate medians were within 10× of the fastest compiled shim and 71/84 matched or beat 1.13.0. Totals and their subphases overlap. Each ratio compares the same phase on both sides.

| Phases above 10× | Phase | Guest | Shim | Candidate / shim |
| --- | --- | --- | --- | --- |
| dom-query | bulk: total ms | C | Embind | 598.75× |
| dom-query | bulk: total ms | C++ | Embind | 495.75× |
| dom-query | bulk: total ms | Rust | Embind | 491.75× |

The bulk DOM query returns a live collection to Embind, which discards it. The component host materializes the collection with `Array.from`, then the bindings lower every element into a WIT resource handle. The ratio includes that difference in work. [Embind loop](cpp/dom-query/emscripten/main.cpp) · [Component host](web/host/web-host.js) · [C guest loop](c/dom-query/main.c)

### DOM bindings with identical guest code

These 216 fresh-page samples compare each language’s exact core Wasm binary with each set of bindings in the table. The direct JS shim calls the same DOM host, puts owned handles in guest memory and recycles them on guest drops. It implements the synchronous imports used by these guests. Jco also provides Canonical ABI checks, task tracking and instance shutdown. [Direct shim](web/bench/dom-core-shim.mjs) · [Raw timings and correctness checks](web/bench/results/dom-control-browser.json)

The bulk query copies 2,000 handles per call, 10 times. Each traversal visits 19,531 nodes. The runner checks the rendered fixture or node count for each guest and verifies list counts and handle release for the direct shim after warm-up and measurement.

With list materialization on both sides, the candidate took **1.61–1.71×** the direct shim’s bulk-query time across the three guests. Times below are per measured workload, after warm-up.

![DOM phase times for Jco 1.13.0 and the candidate relative to the same-guest direct shim](web/bench/results/dom-control-runtime.png)

| Phase | Guest | Direct (ms) | 1.13.0 (ms) | Candidate (ms) | Candidate / direct | Candidate / 1.13.0 | Rounds at or below 1.13.0 | Candidate / previous | Rounds at or below previous |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DOM ID lookup | C | 14.26 | 24.30 | 17.75 | 1.25× | 0.73× | 9/9 | 1.03× | 4/9 |
| DOM ID lookup | C++ | 15.96 | 24.39 | 21.30 | 1.33× | 0.87× | 7/9 | 1.09× | 4/9 |
| DOM ID lookup | Rust | 13.32 | 23.11 | 16.89 | 1.27× | 0.73× | 8/9 | 1.06× | 4/9 |
| Bulk DOM query | C | 5.96 | 12.03 | 10.22 | 1.71× | 0.85× | 8/9 | 1.10× | 3/9 |
| Bulk DOM query | C++ | 7.41 | 10.71 | 12.62 | 1.70× | 1.18× | 3/9 | 1.16× | 2/9 |
| Bulk DOM query | Rust | 6.09 | 11.39 | 9.79 | 1.61× | 0.86× | 7/9 | 1.07× | 5/9 |
| Tree construction | C | 24.90 | 44.85 | 48.34 | 1.94× | 1.08× | 3/9 | 1.16× | 3/9 |
| Tree construction | C++ | 20.75 | 47.29 | 46.77 | 2.25× | 0.99× | 6/9 | 1.01× | 4/9 |
| Tree construction | Rust | 25.69 | 44.92 | 39.37 | 1.53× | 0.88× | 4/9 | 0.91× | 5/9 |
| Tree traversal | C | 5.93 | 12.45 | 14.53 | 2.45× | 1.17× | 2/9 | 1.18× | 2/9 |
| Tree traversal | C++ | 5.30 | 12.15 | 15.29 | 2.88× | 1.26× | 1/9 | 1.07× | 3/9 |
| Tree traversal | Rust | 7.29 | 15.03 | 15.36 | 2.11× | 1.02× | 3/9 | 0.92× | 7/9 |

### Cost of a synchronous host import

The scalar, string and resource loops run 131,072 iterations per pass. The string loop changes the first byte before each call. The resource loop acquires a host object, borrows it to read its value, and drops it. The optional-resource loop checks the discriminant in guest memory every time and reads and drops each present handle. Each pass checks its checksum. All four adapters use byte-identical core modules. The direct shim keeps the fixture’s single live handle in one slot.

The byte-list loops copy a 176 × 176 RGBA region (123,904 bytes) 2,048 times per pass in each direction. The host-to-guest case uses a reusable host view and a fixed guest allocation. In the reverse direction the host keeps the final snapshot while the guest changes the source in Wasm. Both cases sum the changing first byte during the loop and verify the whole payload afterward. The canvas demo also measures browser readback, host allocation and guest allocation.

The string-return loops make 32,768 calls per pass for 16-byte results and 1,024 for 16 KiB results. One host returns a repeated ASCII string. The other rotates four strings containing two-, three-, and four-byte UTF-8 sequences. The guest checks each byte length, sums the first bytes, and hashes every distinct result outside the timer.

Times are nanoseconds per guest iteration, including the loop and host work. Each cell is the median of 7 fresh-page medians, with 2 warm-ups and 5 timed passes per page. The runner interleaves the four builds. [Raw timings and digests](web/bench/results/import-loop.json)

| Operation | Direct | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Candidate / direct |
| --- | --- | --- | --- | --- | --- | --- |
| u32 | 15.3 | 13.7 | 1,844.0 | 16.0 | 1.17× | 1.05× |
| 2-byte string | 410.5 | 404.4 | 2,430.0 | 109.9 | 0.27× | 0.27× |
| 9-byte string | 412.8 | 412.0 | 2,469.6 | 164.8 | 0.40× | 0.40× |
| 32-byte string | 398.3 | 390.6 | 2,347.6 | 414.3 | 1.06× | 1.04× |
| Acquire, borrow, drop | 38.1 | 228.1 | 3,958.1 | 112.2 | 0.49× | 2.94× |
| Optional resource, half present | 29.0 | 179.3 | 2,986.9 | 117.5 | 0.66× | 4.05× |
| 121 KiB host-to-guest byte list | 4,296.9 | 4,492.2 | 8,056.6 | 4,541.0 | 1.01× | 1.06× |
| 121 KiB guest-to-host byte list | 90,283.2 | 90,380.9 | 96,923.8 | 91,015.6 | 1.01× | 1.01× |
| 16-byte UTF-8 result, repeated ASCII | 1,571.7 | 1,586.9 | 3,570.6 | 317.4 | 0.20× | 0.20× |
| 16-byte UTF-8 result, rotating Unicode | 1,767.0 | 1,721.2 | 4,309.1 | 946.0 | 0.55× | 0.54× |
| 16 KiB UTF-8 result, repeated ASCII | 33,203.1 | 32,812.5 | 49,804.7 | 17,382.8 | 0.53× | 0.52× |
| 16 KiB UTF-8 result, rotating Unicode | 45,410.2 | 44,726.6 | 80,859.4 | 30,761.7 | 0.69× | 0.68× |

![Time per guest iteration relative to Jco 1.13.0, by import and transfer direction](web/bench/results/import-loop-runtime.png)

### Where the canvas read spends its time

The same-page comparison was repeated with a clock around the demo’s host method. That method reads 176 × 176 pixels from Chromium and creates a JavaScript byte array. The remainder includes guest allocation and freeing, the copy into Wasm, binding checks, the loop and observer overhead. Each cell is a median across 9 page medians. Columns are summarized independently. [Raw instrumented samples](web/bench/results/canvas-control-browser.json)

| Guest | Bindings | Full read (µs) | Inside host (µs) | Remainder (µs) | Inside host (%) |
| --- | --- | --- | --- | --- | --- |
| C | 1.13.0 | 325.3 | 312.3 | 12.9 | 96.1% |
| C | Candidate | 329.0 | 314.6 | 14.4 | 95.8% |
| C++ | 1.13.0 | 325.1 | 313.8 | 12.8 | 96.2% |
| C++ | Candidate | 339.8 | 324.7 | 15.1 | 96.0% |
| Rust | 1.13.0 | 330.9 | 317.8 | 13.3 | 96.2% |
| Rust | Candidate | 332.0 | 318.1 | 14.8 | 95.8% |

The host accounted for 95.8–96.2% of the full read across these builds. The candidate spent 14.4–15.1 µs per read outside the host, compared with 12.8–13.3 µs for 1.13.0.

<details><summary>All timed phases and string lengths</summary>

| Demo | Phase | Guest | Candidate time | Fresh-page / 1.13.0 | Same-page / 1.13.0 | Candidate / main | Fastest shim | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| attribute-churn | total time | C | 52.15 ms | 0.52× | 0.49× | 0.18× | Embind | 0.55× |
| attribute-churn | total time | C++ | 49.84 ms | 0.49× | 0.50× | 0.16× | Embind | 0.53× |
| attribute-churn | total time | Rust | 67.73 ms | 0.61× | 0.56× | 0.20× | Embind | 0.72× |
| attribute-churn | per setAttribute() | C | 0.65 µs | 0.52× | 0.49× | 0.18× | Embind | 0.55× |
| attribute-churn | per setAttribute() | C++ | 0.62 µs | 0.49× | 0.50× | 0.16× | Embind | 0.53× |
| attribute-churn | per setAttribute() | Rust | 0.85 µs | 0.61× | 0.56× | 0.20× | Embind | 0.72× |
| canvas-draw | total | C | 44.60 ms | 0.85× | 0.95× | 0.26× | Embind | 0.61× |
| canvas-draw | total | C++ | 49.01 ms | 0.96× | 0.91× | 0.25× | Embind | 0.67× |
| canvas-draw | total | Rust | 45.80 ms | 0.90× | 0.93× | 0.26× | Embind | 0.62× |
| canvas-draw | per fill_rect() | C | 0.89 µs | 0.85× | 0.95× | 0.26× | Embind | 0.61× |
| canvas-draw | per fill_rect() | C++ | 0.98 µs | 0.96× | 0.91× | 0.25× | Embind | 0.67× |
| canvas-draw | per fill_rect() | Rust | 0.92 µs | 0.90× | 0.93× | 0.26× | Embind | 0.62× |
| canvas-pixels | getImageData(): µs/call | C | 314.80 µs | 1.12× | 1.01× | 0.93× | Embind | 1.56× |
| canvas-pixels | getImageData(): µs/call | C++ | 338.60 µs | 1.06× | 1.00× | 1.04× | Embind | 1.68× |
| canvas-pixels | getImageData(): µs/call | Rust | 358.40 µs | 1.03× | 1.00× | 1.03× | Embind | 1.78× |
| canvas-pixels | putImageData(): µs/call | C | 235.10 µs | 0.90× | 1.04× | 0.82× | Embind | 1.32× |
| canvas-pixels | putImageData(): µs/call | C++ | 254.90 µs | 1.00× | 0.88× | 0.87× | Embind | 1.43× |
| canvas-pixels | putImageData(): µs/call | Rust | 271.20 µs | 1.04× | 1.02× | 0.76× | Embind | 1.52× |
| dom-query | individual: total ms | C | 20.66 ms | 0.91× | 0.61× | 0.23× | Embind | 0.71× |
| dom-query | individual: total ms | C++ | 17.50 ms | 0.66× | 0.58× | 0.20× | Embind | 0.60× |
| dom-query | individual: total ms | Rust | 16.41 ms | 0.77× | 0.66× | 0.16× | Embind | 0.57× |
| dom-query | bulk: total ms | C | 11.97 ms | 1.11× | 0.81× | 0.72× | Embind | 598.75× |
| dom-query | bulk: total ms | C++ | 9.91 ms | 0.87× | 0.78× | 0.58× | Embind | 495.75× |
| dom-query | bulk: total ms | Rust | 9.84 ms | 0.90× | 0.78× | 0.54× | Embind | 491.75× |
| dom-query | individual: µs/element | C | 1.03 µs | 0.91× | 0.61× | 0.23× | Embind | 0.71× |
| dom-query | individual: µs/element | C++ | 0.88 µs | 0.66× | 0.58× | 0.20× | Embind | 0.60× |
| dom-query | individual: µs/element | Rust | 0.82 µs | 0.77× | 0.66× | 0.16× | Embind | 0.57× |
| dom-traversal | build | C | 49.85 ms | 1.00× | 0.77× | 0.25× | EM_JS | 2.98× |
| dom-traversal | build | C++ | 47.75 ms | 1.08× | 0.81× | 0.23× | EM_JS | 2.86× |
| dom-traversal | build | Rust | 44.24 ms | 0.99× | 0.80× | 0.22× | EM_JS | 2.65× |
| dom-traversal | traverse (total) | C | 14.25 ms | 1.01× | 0.81× | 0.14× | EM_JS | 3.88× |
| dom-traversal | traverse (total) | C++ | 13.37 ms | 1.06× | 0.78× | 0.13× | EM_JS | 3.64× |
| dom-traversal | traverse (total) | Rust | 16.79 ms | 1.15× | 0.68× | 0.15× | EM_JS | 4.57× |
| dom-traversal | traverse (per node) | C | 0.73 µs | 1.01× | 0.81× | 0.14× | EM_JS | 3.88× |
| dom-traversal | traverse (per node) | C++ | 0.68 µs | 1.06× | 0.78× | 0.13× | EM_JS | 3.64× |
| dom-traversal | traverse (per node) | Rust | 0.86 µs | 1.15× | 0.68× | 0.15× | EM_JS | 4.57× |
| string-marshalling | set 8 B | C | 0.39 µs | 0.46× | 0.63× | 0.14× | EM_JS | 1.21× |
| string-marshalling | set 8 B | C++ | 0.41 µs | 0.57× | 0.70× | 0.14× | EM_JS | 1.26× |
| string-marshalling | set 8 B | Rust | 0.35 µs | 0.41× | 0.70× | 0.12× | EM_JS | 1.07× |
| string-marshalling | get 8 B | C | 0.80 µs | 0.36× | 0.25× | 0.17× | EM_JS | 4.15× |
| string-marshalling | get 8 B | C++ | 0.48 µs | 0.19× | 0.24× | 0.10× | EM_JS | 2.50× |
| string-marshalling | get 8 B | Rust | 0.51 µs | 0.28× | 0.24× | 0.11× | EM_JS | 2.66× |
| string-marshalling | set 128 B | C | 0.64 µs | 0.63× | 0.92× | 0.19× | wasm-bindgen | 1.14× |
| string-marshalling | set 128 B | C++ | 0.59 µs | 0.86× | 0.91× | 0.12× | wasm-bindgen | 1.06× |
| string-marshalling | set 128 B | Rust | 0.59 µs | 0.70× | 0.84× | 0.16× | wasm-bindgen | 1.06× |
| string-marshalling | get 128 B | C | 1.81 µs | 0.78× | 0.79× | 0.39× | wasm-bindgen | 2.08× |
| string-marshalling | get 128 B | C++ | 1.76 µs | 0.80× | 0.80× | 0.39× | wasm-bindgen | 2.03× |
| string-marshalling | get 128 B | Rust | 1.65 µs | 0.79× | 0.77× | 0.33× | wasm-bindgen | 1.90× |
| string-marshalling | set 1024 B | C | 0.94 µs | 0.87× | 0.96× | 0.29× | wasm-bindgen | 1.04× |
| string-marshalling | set 1024 B | C++ | 0.97 µs | 0.84× | 0.81× | 0.32× | wasm-bindgen | 1.08× |
| string-marshalling | set 1024 B | Rust | 0.94 µs | 0.42× | 0.96× | 0.28× | wasm-bindgen | 1.04× |
| string-marshalling | get 1024 B | C | 1.76 µs | 0.42× | 0.44× | 0.22× | wasm-bindgen | 0.32× |
| string-marshalling | get 1024 B | C++ | 1.94 µs | 0.20× | 0.49× | 0.28× | wasm-bindgen | 0.36× |
| string-marshalling | get 1024 B | Rust | 1.77 µs | 0.48× | 0.44× | 0.25× | wasm-bindgen | 0.33× |
| string-marshalling | set 16384 B | C | 6.39 µs | 0.88× | 0.98× | 0.66× | wasm-bindgen | 0.97× |
| string-marshalling | set 16384 B | C++ | 6.98 µs | 0.96× | 1.00× | 0.78× | wasm-bindgen | 1.06× |
| string-marshalling | set 16384 B | Rust | 6.36 µs | 0.90× | 0.97× | 0.64× | wasm-bindgen | 0.96× |
| string-marshalling | get 16384 B | C | 17.02 µs | 0.33× | 0.52× | 0.31× | wasm-bindgen | 0.20× |
| string-marshalling | get 16384 B | C++ | 16.92 µs | 0.48× | 0.52× | 0.35× | wasm-bindgen | 0.20× |
| string-marshalling | get 16384 B | Rust | 17.21 µs | 0.33× | 0.53× | 0.31× | wasm-bindgen | 0.21× |
| string-marshalling | set 262144 B | C | 102.65 µs | 0.41× | 0.93× | 0.41× | Embind | 0.89× |
| string-marshalling | set 262144 B | C++ | 101.25 µs | 0.40× | 0.73× | 0.44× | Embind | 0.88× |
| string-marshalling | set 262144 B | Rust | 101.60 µs | 0.43× | 0.98× | 0.38× | Embind | 0.88× |
| string-marshalling | get 262144 B | C | 267.80 µs | 0.28× | 0.29× | 0.39× | wasm-bindgen | 0.20× |
| string-marshalling | get 262144 B | C++ | 268.65 µs | 0.29× | 0.30× | 0.40× | wasm-bindgen | 0.21× |
| string-marshalling | get 262144 B | Rust | 258.85 µs | 0.30× | 0.29× | 0.33× | wasm-bindgen | 0.20× |
| table-update | create: total ms | C | 12.07 ms | 0.88× | 0.90× | 0.17× | EM_JS | 2.19× |
| table-update | create: total ms | C++ | 11.20 ms | 0.91× | 0.89× | 0.16× | EM_JS | 2.04× |
| table-update | create: total ms | Rust | 12.49 ms | 0.81× | 0.99× | 0.19× | EM_JS | 2.27× |
| table-update | create: µs/row | C | 6.04 µs | 0.88× | 0.90× | 0.17× | EM_JS | 2.19× |
| table-update | create: µs/row | C++ | 5.60 µs | 0.91× | 0.89× | 0.16× | EM_JS | 2.04× |
| table-update | create: µs/row | Rust | 6.25 µs | 0.81× | 0.99× | 0.19× | EM_JS | 2.27× |
| table-update | update (selected): total ms | C | 0.98 ms | 0.86× | 0.84× | 0.29× | wasm-bindgen | 1.18× |
| table-update | update (selected): total ms | C++ | 0.88 ms | 0.95× | 0.85× | 0.25× | wasm-bindgen | 1.05× |
| table-update | update (selected): total ms | Rust | 0.98 ms | 0.90× | 0.82× | 0.31× | wasm-bindgen | 1.17× |
| table-update | update (selected): µs/row | C | 0.49 µs | 0.86× | 0.84× | 0.29× | wasm-bindgen | 1.18× |
| table-update | update (selected): µs/row | C++ | 0.44 µs | 0.95× | 0.85× | 0.25× | wasm-bindgen | 1.05× |
| table-update | update (selected): µs/row | Rust | 0.49 µs | 0.90× | 0.82× | 0.31× | wasm-bindgen | 1.18× |
| table-update | clear (unselected): total ms | C | 3.00 ms | 0.68× | 0.76× | 0.19× | wasm-bindgen | 1.43× |
| table-update | clear (unselected): total ms | C++ | 2.83 ms | 0.74× | 0.77× | 0.17× | wasm-bindgen | 1.35× |
| table-update | clear (unselected): total ms | Rust | 3.31 ms | 0.76× | 0.82× | 0.23× | wasm-bindgen | 1.58× |
| table-update | clear (unselected): µs/row | C | 1.50 µs | 0.68× | 0.76× | 0.19× | wasm-bindgen | 1.43× |
| table-update | clear (unselected): µs/row | C++ | 1.41 µs | 0.74× | 0.77× | 0.17× | wasm-bindgen | 1.35× |
| table-update | clear (unselected): µs/row | Rust | 1.66 µs | 0.76× | 0.82× | 0.23× | wasm-bindgen | 1.58× |

</details>

### Payload and startup

Payload medians cover 34 component inputs. Compression is per file. Startup is the median of the 21 per-workload and guest medians, from dynamic import through initialization, with browser caching disabled.

| Build | JS (KiB) | Core Wasm (KiB) | Total (KiB) | Gzip (KiB) | Brotli (KiB) | Startup (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 | 19.4 | 64.4 | 85.4 | 29.3 | 24.1 | 10.48 |
| Stock main | 180.8 | 64.4 | 252.1 | 57.6 | 47.8 | 24.80 |
| Candidate | 138.8 | 64.4 | 206.3 | 51.6 | 42.9 | 20.29 |

### What ships with `--minify`

Each Jco build generated its default and minified distribution from the same 34 components. Jco 1.13.0 uses Terser for its minify option. Stock main and the branch use Oxc. All external Wasm files matched byte for byte across formats. Payloads include JavaScript and external Wasm, compressed per file. Chromium interleaved the six distributions across 630 fresh pages, with 5 rounds for each of the 21 guest and workload combinations. The two ratio columns compare each format to that build’s default for the same guest and workload, then take the median of the 21 ratios. The final column compares workload times to the same format of 1.13.0. [Distribution sizes](web/bench/results/minified-sizes.json) · [Timings and resource requests](web/bench/results/minified-browser.json)

| Distribution | JS (KiB) | Total gzip (KiB) | Total Brotli (KiB) | Startup (ms) | Startup / default | Runtime / default | At or below 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 default | 19.4 | 29.3 | 24.1 | 10.31 | 1.00× | 1.00× | 21/21 |
| 1.13.0 minified | 8.7 | 28.8 | 23.7 | 9.93 | 0.98× | 1.02× | 21/21 |
| Stock main default | 180.8 | 57.6 | 47.8 | 24.50 | 1.00× | 1.00× | 1/21 |
| Stock main minified | 104.9 | 50.7 | 42.8 | 21.86 | 0.89× | 1.04× | 2/21 |
| Candidate default | 138.8 | 51.6 | 42.9 | 20.35 | 1.00× | 1.00× | 15/21 |
| Candidate minified | 76.9 | 45.7 | 38.7 | 18.16 | 0.86× | 1.00× | 17/21 |

Chromium’s Resource Timing entries give four consecutive intervals from the start of dynamic import until the module is ready. The gap before the first Wasm request includes resolving dependencies and executing JavaScript. The local server served uncompressed assets with caching disabled. Browser response-body sizes were checked against the generated file sizes. Each column reports its own median over workload medians.

| Distribution | Import to JS response end (ms) | JS response end to first Wasm request (ms) | First Wasm request to last Wasm response (ms) | Last Wasm response to ready (ms) |
| --- | --- | --- | --- | --- |
| 1.13.0 default | 2.14 | 3.06 | 2.22 | 2.83 |
| 1.13.0 minified | 2.12 | 2.77 | 2.26 | 2.70 |
| Stock main default | 2.35 | 15.44 | 2.30 | 3.88 |
| Stock main minified | 2.30 | 13.31 | 2.28 | 3.94 |
| Candidate default | 2.27 | 11.88 | 2.32 | 3.82 |
| Candidate minified | 2.25 | 10.03 | 2.22 | 3.63 |

Minifying the branch reduced startup by 14% on the median same-workload comparison. Its median import-to-ready time was 18.16 ms, compared with 9.93 ms for minified 1.13.0. Between the end of the entry JavaScript response and the first Wasm request, the corresponding medians were 10.03 and 2.77 ms.

![Default and minified gzip payloads and fresh-page startup for three Jco builds](web/bench/results/minified-startup.png)

### Startup with DevTools disconnected

In 1,260 fresh documents, the page timed its own dynamic import, ran the guest and sent the result to a local server. One browser kept the Puppeteer DevTools connection open. The other disconnected before the first measured navigation. Both navigated the same tab, with matching Chrome flags, no-store responses and verified network transfers. The order of the two browsers alternated over 5 rounds. Each table cell is the median of the 21 workload medians. [Observer timings](web/bench/results/startup-observer.json)

| Distribution | Attached startup (ms) | Detached startup (ms) | Attached JS end to Wasm request (ms) | Detached JS end to Wasm request (ms) |
| --- | --- | --- | --- | --- |
| 1.13.0 default | 7.83 | 5.98 | 2.80 | 1.69 |
| 1.13.0 minified | 7.74 | 5.63 | 2.58 | 1.59 |
| Stock main default | 20.92 | 14.00 | 13.64 | 8.11 |
| Stock main minified | 18.94 | 13.13 | 12.33 | 7.54 |
| Candidate default | 17.10 | 11.58 | 10.75 | 6.46 |
| Candidate minified | 16.00 | 10.97 | 9.87 | 5.68 |

### Generated JavaScript reached by each demo

Chromium recorded block coverage on 126 fresh pages in a separate run. One page imported each module and finished initialization. A second also ran the demo once and checked its output. The table reports medians over the 21 guest and workload combinations. Sizes count UTF-8 bytes in V8’s covered source ranges. A demo can leave error handling, shutdown or other supported operations unexercised. [Per-module coverage and hashes](web/bench/results/js-coverage.json)

| Build | Reached at init (KiB) | Reached through first run (KiB) | Share through first run | Unreached through first run (KiB) |
| --- | --- | --- | --- | --- |
| 1.13.0 | 4.8 | 16.3 | 76.6% | 5.0 |
| Stock main | 53.9 | 96.3 | 51.2% | 91.3 |
| Candidate | 40.0 | 64.3 | 45.6% | 77.0 |

<details><summary>Candidate startup, variation and paired comparison to 1.13.0</summary>

The paired ratio divides the candidate time by the 1.13.0 time within each round, then takes the median. The final column counts rounds where the candidate was at least as fast.

| Operation | Guest | Startup median (ms) | Warm phase p25 | Warm phase p50 | Warm phase p75 | Phase unit | Paired ratio to 1.13.0 | Rounds at or below 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | 21.31 | 0.62 | 0.65 | 0.68 | µs | 0.56× | 7/7 |
| Attribute write | C++ | 20.12 | 0.54 | 0.62 | 0.69 | µs | 0.51× | 7/7 |
| Attribute write | Rust | 17.48 | 0.79 | 0.85 | 0.87 | µs | 0.56× | 7/7 |
| Canvas fillRect | C | 21.78 | 0.80 | 0.89 | 0.92 | µs | 0.82× | 5/7 |
| Canvas fillRect | C++ | 21.17 | 0.84 | 0.98 | 1.02 | µs | 0.87× | 5/7 |
| Canvas fillRect | Rust | 19.38 | 0.80 | 0.92 | 1.00 | µs | 0.90× | 6/7 |
| Canvas pixel read | C | 21.49 | 287.30 | 314.80 | 328.35 | µs | 1.08× | 3/7 |
| Canvas pixel read | C++ | 22.76 | 329.65 | 338.60 | 351.25 | µs | 0.97× | 4/7 |
| Canvas pixel read | Rust | 20.09 | 280.95 | 358.40 | 395.25 | µs | 1.13× | 3/7 |
| DOM ID lookup | C | 20.43 | 0.77 | 1.03 | 1.06 | µs | 0.79× | 5/7 |
| DOM ID lookup | C++ | 23.07 | 0.82 | 0.88 | 0.93 | µs | 0.66× | 7/7 |
| DOM ID lookup | Rust | 20.12 | 0.70 | 0.82 | 0.89 | µs | 0.74× | 7/7 |
| Tree traversal | C | 20.31 | 13.47 | 14.25 | 16.35 | ms | 1.01× | 3/7 |
| Tree traversal | C++ | 21.76 | 12.74 | 13.37 | 14.87 | ms | 1.23× | 2/7 |
| Tree traversal | Rust | 19.10 | 16.06 | 16.79 | 18.77 | ms | 1.24× | 1/7 |
| Read 1 KiB string | C | 19.55 | 1.71 | 1.76 | 1.78 | µs | 0.40× | 7/7 |
| Read 1 KiB string | C++ | 19.81 | 1.74 | 1.94 | 2.05 | µs | 0.18× | 7/7 |
| Read 1 KiB string | Rust | 18.28 | 1.73 | 1.77 | 1.88 | µs | 0.48× | 7/7 |
| Table creation | C | 20.17 | 10.67 | 12.07 | 13.51 | ms | 0.93× | 7/7 |
| Table creation | C++ | 20.68 | 10.20 | 11.20 | 13.95 | ms | 0.93× | 5/7 |
| Table creation | Rust | 20.29 | 11.86 | 12.49 | 15.60 | ms | 0.93× | 4/7 |

</details>

[Raw browser timings](web/bench/results/candidate-browser.json) · [File sizes, digests and generator revision](web/bench/results/candidate-sizes.json)

### Reproduce the candidate run

Run the dependency installation, main setup and size commands in [Reproduce the comparison](#reproduce-the-comparison), then run the following from the repository root. Cargo uses the Jco checkout’s pinned toolchain and lockfile.

```sh
git clone https://github.com/vados-cosmonic/jco ../jco-candidate
git -C ../jco-candidate checkout d7ac58241e950ad78e950663509c3c34cee599bf
node web/bench/candidate.mjs ../jco-candidate
git -C ../jco-candidate worktree add --detach ../jco-reference 8400d667ff71addffcd184046fc47bc9c99a02be
node web/bench/candidate.mjs --reference ../jco-reference
CHROME_BIN=/path/to/chrome BENCH_CANDIDATE=1 ROUNDS=7 node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome BENCH_DOM_CONTROL=1 ROUNDS=9 node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome BENCH_PAIRED=1 ROUNDS=9 node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome BENCH_CANVAS_CONTROL=1 ROUNDS=9 node web/bench/browser.mjs
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

**jco 1.13.0 vs. main at `37f1dfaa`** · 2026-11-26 · HeadlessChrome/156.0.8078.47 · Intel(R) Xeon(R) Processor @ 2.60GHz · linux 6.12.111 x64 · Node v26.13.0. [Upstream commit](https://github.com/bytecodealliance/jco/commit/37f1dfaa31eef82d4ac38975cba66bafaca20b73) · [Transpiler build](https://github.com/bytecodealliance/jco/actions/runs/45716763144)

These stock and shim timings come from the same interleaved fresh-page trial as the performance branch. [Full trial](web/bench/results/candidate-browser.json) · [Stock and shim samples](web/bench/results/browser.json)

Across the seven operations below and three guest languages, main took longer in **19 of 21** median comparisons. The highest ratio was **7.97×** for the C++ guest in `dom-traversal`.

For 256 KiB string reads, the median time on main changed by -28% to -9% across the three guest languages. The phase tables below include every tested string size.

Each cell is the median of 7 fresh-page samples. The chart divides main’s median time by 1.13.0’s for the same guest and operation. A value below 1× means main finished faster.

![Median time on main divided by baseline time for seven operations and three guest languages](web/bench/results/runtime.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 0.286 | 1.18 | — | — | 1.24 | 3.69 | 1.26 | 3.81 | 1.38 | 4.15 |
| Canvas fillRect (µs) | 0.944 | 1.47 | — | — | 1.05 | 3.41 | 1.02 | 3.85 | 1.02 | 3.55 |
| Canvas pixel read (µs) | 161.90 | 201.40 | — | — | 281.80 | 337.50 | 320.80 | 324.80 | 349.10 | 347.20 |
| DOM ID lookup (µs) | 0.255 | 1.45 | — | — | 1.14 | 4.43 | 1.32 | 4.46 | 1.07 | 5.09 |
| Tree traversal (ms) | 0.81 | 24.71 | 3.67 | 4.77 | 14.10 | 102.08 | 12.65 | 100.81 | 14.59 | 115.49 |
| Read 1 KiB string (µs) | 0.088 | 11.26 | 10.41 | 5.43 | 4.25 | 7.93 | 9.51 | 6.97 | 3.71 | 7.18 |
| Table creation (ms) | 4.12 | 13.78 | 5.50 | 8.59 | 13.77 | 72.81 | 12.29 | 71.58 | 15.40 | 64.17 |

Embind and EM_JS are the C++ Emscripten variants. An em dash marks an unavailable combination. Across toolchains, the upstream implementations can do different amounts of work. For example, the JavaScript bulk DOM query obtains a live collection while the component host materializes a list.

<details><summary>Run-to-run variation for the two jco versions</summary>

Each cell spans the 25th to 75th percentile of measured times, using linear interpolation between sorted samples.

| Operation | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 1.11–1.25 | 3.59–3.88 | 1.17–1.32 | 3.79–4.15 | 1.26–1.48 | 4.02–4.42 |
| Canvas fillRect (µs) | 0.903–1.14 | 3.12–3.86 | 0.951–1.16 | 3.53–4.00 | 0.957–1.05 | 3.27–3.91 |
| Canvas pixel read (µs) | 259.60–319.95 | 330.05–346.55 | 318.65–367.60 | 320.30–356.60 | 329.75–357.80 | 286.05–367.75 |
| DOM ID lookup (µs) | 0.991–1.29 | 4.23–5.11 | 1.30–1.36 | 4.36–4.59 | 1.02–1.12 | 4.84–5.12 |
| Tree traversal (ms) | 12.24–14.63 | 90.86–109.55 | 11.42–13.66 | 84.83–109.81 | 13.20–15.42 | 109.48–121.10 |
| Read 1 KiB string (µs) | 3.94–5.10 | 6.30–8.18 | 4.48–17.49 | 6.36–7.31 | 3.52–11.39 | 6.89–7.23 |
| Table creation (ms) | 12.47–14.50 | 68.39–74.73 | 11.95–14.59 | 68.20–71.80 | 14.40–15.95 | 59.58–69.11 |

</details>

<details><summary>All workload phases, per-call timings, and string transfer rates</summary>

Times come from the tables rendered by the demos and retain their original reporting precision. Effective string throughput uses the ASCII payload length divided by median call time (decimal MB/s).

**attribute-churn**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total time (ms) | 22.86 | 94.47 | — | — | 99.34 | 294.85 | 100.80 | 304.91 | 110.47 | 331.79 |
| per setAttribute() (µs) | 0.286 | 1.18 | — | — | 1.24 | 3.69 | 1.26 | 3.81 | 1.38 | 4.15 |

**canvas-draw**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total (ms) | 47.20 | 73.48 | — | — | 52.45 | 170.43 | 50.97 | 192.41 | 50.84 | 177.34 |
| per fill_rect() (µs) | 0.944 | 1.47 | — | — | 1.05 | 3.41 | 1.02 | 3.85 | 1.02 | 3.55 |

**canvas-pixels**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| getImageData() (µs) | 161.90 | 201.40 | — | — | 281.80 | 337.50 | 320.80 | 324.80 | 349.10 | 347.20 |
| putImageData() (µs) | 13.50 | 178.70 | — | — | 260.20 | 286.20 | 253.90 | 293.00 | 260.50 | 358.20 |

**dom-query**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| individual, total (ms) | 5.10 | 29.02 | — | — | 22.71 | 88.61 | 26.33 | 89.22 | 21.33 | 101.77 |
| bulk, total (ms) | 0.01 | 0.02 | — | — | 10.79 | 16.64 | 11.42 | 17.05 | 10.93 | 18.26 |
| individual: µs/element (µs) | 0.255 | 1.45 | — | — | 1.14 | 4.43 | 1.32 | 4.46 | 1.07 | 5.09 |

**dom-traversal**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| build (ms) | 11.52 | 35.42 | 16.71 | 23.50 | 49.90 | 202.11 | 44.17 | 206.13 | 44.60 | 196.75 |
| traverse (total) (ms) | 0.81 | 24.71 | 3.67 | 4.77 | 14.10 | 102.08 | 12.65 | 100.81 | 14.59 | 115.49 |
| traverse (per node) (µs) | 0.041 | 1.26 | 0.188 | 0.244 | 0.722 | 5.23 | 0.648 | 5.16 | 0.747 | 5.91 |

**string-marshalling**

![Median DOM textContent set and get latency by payload length for each guest and jco version, on logarithmic axes](web/bench/results/strings.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| set 8 B (µs) | 0.179 | 0.805 | 0.326 | 0.498 | 0.857 | 2.80 | 0.726 | 2.97 | 0.861 | 3.03 |
| set 8 B (MB/s) | 44.69 | 9.94 | 24.54 | 16.06 | 9.33 | 2.86 | 11.02 | 2.69 | 9.29 | 2.64 |
| get 8 B (µs) | 0.075 | 0.946 | 0.192 | 0.226 | 2.24 | 4.79 | 2.54 | 4.92 | 1.82 | 4.81 |
| get 8 B (MB/s) | 106.67 | 8.46 | 41.67 | 35.40 | 3.57 | 1.67 | 3.15 | 1.63 | 4.39 | 1.66 |
| set 128 B (µs) | 0.307 | 1.19 | 0.83 | 0.559 | 1.00 | 3.44 | 0.691 | 5.01 | 0.849 | 3.81 |
| set 128 B (MB/s) | 416.94 | 107.29 | 154.22 | 228.98 | 127.36 | 37.19 | 185.24 | 25.57 | 150.77 | 33.60 |
| get 128 B (µs) | 0.082 | 2.19 | 1.36 | 0.869 | 2.33 | 4.60 | 2.20 | 4.55 | 2.09 | 4.92 |
| get 128 B (MB/s) | 1,560.98 | 58.39 | 93.91 | 147.30 | 55.01 | 27.84 | 58.13 | 28.11 | 61.33 | 26.01 |
| set 1024 B (µs) | 0.974 | 1.40 | 2.61 | 0.899 | 1.07 | 3.23 | 1.16 | 3.04 | 2.23 | 3.36 |
| set 1024 B (MB/s) | 1,051.33 | 732.47 | 392.79 | 1,139.04 | 956.12 | 317.03 | 886.58 | 336.29 | 460.22 | 304.85 |
| get 1024 B (µs) | 0.088 | 11.26 | 10.41 | 5.43 | 4.25 | 7.93 | 9.51 | 6.97 | 3.71 | 7.18 |
| get 1024 B (MB/s) | 11,636.36 | 90.92 | 98.38 | 188.48 | 241.05 | 129.16 | 107.70 | 146.81 | 275.79 | 142.54 |
| set 16384 B (µs) | 11.81 | 7.83 | 33.64 | 6.60 | 7.27 | 9.72 | 7.28 | 9.00 | 7.08 | 9.94 |
| set 16384 B (MB/s) | 1,387.06 | 2,092.20 | 487.08 | 2,483.55 | 2,254.89 | 1,684.73 | 2,252.10 | 1,821.05 | 2,312.82 | 1,648.12 |
| get 16384 B (µs) | 0.439 | 160.80 | 157.00 | 83.38 | 51.59 | 54.77 | 35.52 | 48.23 | 51.74 | 54.67 |
| get 16384 B (MB/s) | 37,321.18 | 101.89 | 104.36 | 196.51 | 317.60 | 299.11 | 461.20 | 339.74 | 316.68 | 299.66 |
| set 262144 B (µs) | 151.99 | 114.95 | 541.60 | 240.90 | 252.35 | 250.00 | 250.15 | 229.70 | 234.80 | 266.80 |
| set 262144 B (MB/s) | 1,724.72 | 2,280.50 | 484.02 | 1,088.19 | 1,038.81 | 1,048.58 | 1,047.95 | 1,141.25 | 1,116.46 | 982.55 |
| get 262144 B (µs) | 11.06 | 2,552.30 | 2,446.80 | 1,309.55 | 944.85 | 686.85 | 936.35 | 670.65 | 858.55 | 779.75 |
| get 262144 B (MB/s) | 23,701.99 | 102.71 | 107.14 | 200.18 | 277.45 | 381.66 | 279.96 | 390.88 | 305.33 | 336.19 |

**table-update**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create, total (ms) | 4.12 | 13.78 | 5.50 | 8.59 | 13.77 | 72.81 | 12.29 | 71.58 | 15.40 | 64.17 |
| create, per row (µs) | 2.06 | 6.89 | 2.75 | 4.29 | 6.88 | 36.41 | 6.14 | 35.79 | 7.70 | 32.09 |
| update (selected), total (ms) | 0.42 | 1.15 | 1.02 | 0.835 | 1.15 | 3.45 | 0.92 | 3.54 | 1.08 | 3.13 |
| update (selected), per row (µs) | 0.21 | 0.572 | 0.513 | 0.417 | 0.572 | 1.73 | 0.46 | 1.77 | 0.542 | 1.56 |
| clear (unselected), total (ms) | 1.32 | 3.63 | 3.87 | 2.09 | 4.41 | 15.94 | 3.83 | 16.62 | 4.34 | 14.68 |
| clear (unselected), per row (µs) | 0.662 | 1.81 | 1.94 | 1.04 | 2.20 | 7.97 | 1.91 | 8.31 | 2.17 | 7.34 |

</details>

<details><summary>Module load and initialization, median milliseconds</summary>

Elapsed browser time for dynamic import through instantiation, with the shared demo host already loaded. The browser process is reused, each page has HTTP caching disabled, and assets are served uncompressed over loopback. These timings include scheduling and local requests. JS is already loaded by the harness.

| Workload | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| attribute-churn | 13.62 | — | — | 10.11 | 26.76 | 9.64 | 24.11 | 10.48 | 20.91 |
| canvas-draw | 14.06 | — | — | 11.14 | 23.77 | 10.33 | 25.53 | 10.68 | 24.62 |
| canvas-pixels | 13.87 | — | — | 11.24 | 29.07 | 10.19 | 24.94 | 10.19 | 24.12 |
| dom-query | 13.24 | — | — | 11.50 | 24.49 | 10.80 | 26.38 | 9.90 | 24.80 |
| dom-traversal | 13.69 | 8.61 | 8.04 | 11.03 | 25.29 | 8.88 | 24.82 | 10.74 | 23.70 |
| string-marshalling | 11.38 | 7.41 | 7.80 | 8.96 | 22.50 | 9.61 | 23.11 | 10.50 | 22.38 |
| table-update | 13.02 | 8.99 | 8.13 | 10.54 | 25.49 | 10.60 | 25.04 | 9.97 | 25.92 |

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

Across 34 component inputs, the median change in gzip payload on main was **+27.2 KiB** per component (range +19.7 to +30.4 KiB). The payload sums the emitted JavaScript and external core Wasm files, including any Wasm inlined into JavaScript. Gzip level 9 and Brotli quality 11 are applied per file. Shared host code, HTML, type declarations and HTTP headers are excluded. The raw JavaScript reference lives in the demo page controller.

All external core Wasm files match byte for byte between the two generators. The size differences come entirely from the emitted JavaScript.

![Gzip payload in KiB for the seven browser workloads, grouped by guest language](web/bench/results/payload.png)

**DOM traversal download size** in KiB, gzip. Each row compares implementations from one guest language.

| Guest | Native component | jco 1.13.0 | jco main | Embind | EM_JS | wasm-bindgen |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| C | 26.4 | 28.5 | 55.6 | — | — | — |
| C++ | 26.9 | 29.0 | 56.1 | 21.4 | 14.2 | — |
| Rust | 50.6 | 52.7 | 79.7 | — | — | 27.0 |

<details><summary>All component sizes, in KiB</summary>

Paired columns list **1.13.0 / main**. Native is the original component binary. Core Wasm counts only separate .wasm files.

| Component | Native | Files | JS | Core Wasm | Raw total | Gzip | Brotli |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| C attribute-churn | 65.1 | 2 / 2 | 19.0 / 174.8 | 61.4 / 61.4 | 80.5 / 236.2 | 28.4 / 55.4 | 23.3 / 45.9 |
| C calculator | 0.9 | 1 / 1 | 2.3 / 98.6 | 0.0 / 0.0 | 2.3 / 98.6 | 1.3 / 21.1 | 1.2 / 18.1 |
| C canvas-draw | 66.5 | 2 / 2 | 22.6 / 189.2 | 61.9 / 61.9 | 84.6 / 251.1 | 28.6 / 56.1 | 23.6 / 46.4 |
| C canvas-pixels | 70.1 | 2 / 2 | 24.2 / 207.7 | 64.7 / 64.7 | 88.9 / 272.4 | 29.7 / 60.1 | 24.5 / 49.7 |
| C dom-query | 68.0 | 2 / 2 | 22.0 / 191.0 | 63.7 / 63.7 | 85.6 / 254.7 | 29.2 / 57.9 | 24.0 / 48.0 |
| C dom-traversal | 66.0 | 2 / 2 | 21.1 / 182.2 | 62.0 / 62.0 | 83.1 / 244.2 | 28.5 / 55.6 | 23.4 / 46.0 |
| C greet-bindgen | 56.3 | 2 / 2 | 2.6 / 106.1 | 55.9 / 55.9 | 58.5 / 162.0 | 24.3 / 45.8 | 20.0 / 38.4 |
| C greet-freestanding | 0.9 | 1 / 1 | 3.0 / 103.1 | 0.0 / 0.0 | 3.0 / 103.1 | 1.6 / 22.7 | 1.5 / 19.5 |
| C greet-libc | 54.9 | 2 / 2 | 2.6 / 106.1 | 54.5 / 54.5 | 57.1 / 160.6 | 23.8 / 45.3 | 19.5 / 38.0 |
| C hello-world | 60.4 | 2 / 2 | 13.8 / 161.1 | 57.8 / 57.8 | 71.6 / 218.9 | 26.7 / 54.0 | 22.0 / 45.0 |
| C string-marshalling | 66.2 | 2 / 2 | 19.4 / 181.8 | 62.6 / 62.6 | 82.0 / 244.4 | 28.9 / 57.3 | 23.9 / 47.7 |
| C table-update | 70.7 | 2 / 2 | 21.2 / 189.3 | 66.6 / 66.6 | 87.8 / 255.9 | 29.3 / 58.0 | 24.2 / 48.1 |
| C++ attribute-churn | 68.9 | 2 / 2 | 19.0 / 174.8 | 65.3 / 65.3 | 84.3 / 240.1 | 29.7 / 56.6 | 24.4 / 47.0 |
| C++ canvas-draw | 68.5 | 2 / 2 | 22.6 / 189.2 | 63.9 / 63.9 | 86.6 / 253.1 | 29.1 / 56.6 | 24.0 / 46.8 |
| C++ canvas-pixels | 73.1 | 2 / 2 | 24.2 / 207.7 | 67.8 / 67.8 | 91.9 / 275.4 | 30.6 / 61.0 | 25.1 / 50.3 |
| C++ dom-query | 71.7 | 2 / 2 | 22.0 / 191.0 | 67.4 / 67.4 | 89.4 / 258.4 | 30.7 / 59.4 | 25.1 / 49.1 |
| C++ dom-traversal | 68.0 | 2 / 2 | 21.1 / 182.2 | 64.0 / 64.0 | 85.1 / 246.2 | 29.0 / 56.1 | 23.8 / 46.5 |
| C++ hello-world | 60.4 | 2 / 2 | 13.8 / 161.1 | 57.8 / 57.8 | 71.6 / 218.8 | 26.6 / 53.9 | 21.9 / 44.9 |
| C++ string-marshalling | 68.3 | 2 / 2 | 19.4 / 181.8 | 64.8 / 64.8 | 84.1 / 246.5 | 29.5 / 57.9 | 24.3 / 48.0 |
| C++ table-update | 74.9 | 2 / 2 | 21.2 / 189.2 | 70.9 / 70.9 | 92.1 / 260.1 | 31.2 / 59.8 | 25.4 / 49.2 |
| Rust attribute-churn | 152.0 | 2 / 2 | 18.8 / 173.4 | 148.5 / 148.5 | 167.3 / 321.9 | 55.8 / 82.6 | 45.9 / 68.3 |
| Rust calculator-raw | 258.7 | 2 / 2 | 1.4 / 98.2 | 258.4 / 258.4 | 259.8 / 356.6 | 85.4 / 105.1 | 72.3 / 89.2 |
| Rust calculator | 258.0 | 2 / 2 | 1.4 / 98.2 | 257.7 / 257.7 | 259.1 / 355.9 | 85.1 / 104.9 | 72.1 / 89.0 |
| Rust canvas-draw | 140.9 | 2 / 2 | 22.4 / 187.8 | 136.4 / 136.4 | 158.8 / 324.2 | 53.0 / 80.3 | 43.8 / 66.5 |
| Rust canvas-pixels | 142.9 | 2 / 2 | 24.0 / 206.3 | 137.7 / 137.7 | 161.6 / 343.9 | 53.7 / 83.8 | 44.2 / 69.3 |
| Rust dom-query | 148.8 | 2 / 2 | 21.7 / 189.6 | 144.7 / 144.7 | 166.4 / 334.3 | 55.9 / 84.5 | 46.0 / 69.9 |
| Rust dom-traversal (dom_traversal.my.component) | 138.7 | 2 / 2 | 20.2 / 180.8 | 135.7 / 135.7 | 155.9 / 316.5 | 52.7 / 79.7 | 43.5 / 66.2 |
| Rust dom-traversal | 138.7 | 2 / 2 | 20.2 / 180.8 | 135.7 / 135.7 | 155.9 / 316.5 | 52.7 / 79.7 | 43.5 / 66.1 |
| Rust hello-world | 17.4 | 2 / 2 | 13.6 / 159.7 | 14.9 / 14.9 | 28.5 / 174.6 | 8.9 / 36.0 | 7.4 / 30.3 |
| Rust string-marshalling | 146.9 | 2 / 2 | 19.1 / 180.4 | 143.4 / 143.4 | 162.5 / 323.8 | 55.2 / 83.5 | 45.6 / 69.3 |
| Rust table-rows | 33.3 | 2 / 2 | 13.1 / 157.1 | 31.1 / 31.1 | 44.2 / 188.2 | 16.2 / 42.5 | 14.0 / 36.2 |
| Rust table-update | 149.5 | 2 / 2 | 20.6 / 188.4 | 146.2 / 146.2 | 166.8 / 334.6 | 56.1 / 84.7 | 46.3 / 70.2 |
| Rust todomvc | 14.4 | 2 / 2 | 15.3 / 161.7 | 11.6 / 11.6 | 26.8 / 173.2 | 7.6 / 34.0 | 6.5 / 28.7 |
| Rust vdom-diff | 40.9 | 2 / 2 | 14.8 / 161.5 | 38.5 / 38.5 | 53.3 / 200.0 | 19.7 / 46.1 | 17.0 / 39.3 |

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
