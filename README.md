# Component demos

This fork benchmarks the browser examples from [eqrion/component-demos at d0b9dd1](https://github.com/eqrion/component-demos/tree/d0b9dd1390a300978193adc623838fef4e4b632b). It runs the same compiled C, C++, and Rust WebAssembly components through jco 1.13.0, pinned upstream main, and a branch that optimizes synchronous host imports. The comparison also includes the demos’ JavaScript, Emscripten (Embind and EM_JS), and Rust wasm-bindgen implementations where available.

The performance branch also specializes UTF-8 conversion in both directions. For strings of up to 32 ASCII bytes, the bindings read or write the bytes directly. Non-ASCII text uses the checked codec, including its malformed-input traps. [Short-string changes](https://github.com/vados-cosmonic/jco/compare/ac28d5d481f3cfca94bc4c62f3571511c19386d9...9eeb7f0b9ab82a982810af5cdd1d9035b302aa39)

For longer host-returned strings, the runtime can encode into a reusable buffer before allocating guest memory. On the preceding upstream revision, a 16 KiB read took 26–28 µs across C, C++, and Rust, or 46–50% of the time for 1.13.0. The archived run compares the bindings immediately before and after this change. [UTF-8 benchmark and raw measurements](https://github.com/vados-cosmonic/component-demos/blob/7550fa7523931f918b6bd599174af07e6537961b/README.md#optimized-browser-bindings)

<!-- candidate:start -->

## Optimized browser bindings

The candidate uses js-component-bindgen’s internal Oxc bundler and the checked jco-cm-runtime. For eligible single-instance, synchronous components, a host import reuses the caller’s task. Resource drops use a one-argument trampoline that checks the instance flag and records traps. The internal Oxc bundle drops the general asynchronous import fallback for these components. The adapter holds direct references to its task stack and instance flags, checks the store for interruptions, and lifts short ASCII strings in groups of four bytes. During a synchronous guest allocation, the checked runtime clears the instance’s may-leave flag and restores it on return or throw. Allocators in components with context-slot operations keep the general guard, which supplies fresh slots for each call. Synchronous UTF-8 results of 256 to 262,144 code units can reuse a per-instance byte buffer, capped at 256 KiB. The runtime encodes there before requesting the exact guest allocation. Nested calls and larger results use the ordinary encoder. When lifting a borrowed host resource, the runtime validates the handle and reads its 32-bit representation directly. Imported host resources with automatically assigned representations use their guest handle as an array index. Explicit host representations and shared tables use a representation map. Components with async operations, cross-component resource transfers or call tracking keep the general adapter. [Jco commit `7c5712b61`](https://github.com/vados-cosmonic/jco/commit/7c5712b61abb6a026ea7eb94228d77a87bd030e6)

All Jco builds used the same guest binaries. Each value is the median of 7 fresh-page samples with one warm-up per page. The run collected 728 samples on 2026-11-25 with HeadlessChrome/156.0.8078.47 on Intel(R) Xeon(R) Processor @ 2.60GHz.

The candidate finished within **10× of the fastest available compiled shim in 21/21** headline comparisons. The largest ratio was **4.14×**. On separate fresh pages it matched or beat **1.13.0 in 14/21** and **stock main in 18/21**. On the same warmed page it matched or beat **1.13.0 in 19/21** headline cases and 80/84 across all phases. The shim comparison selects the lowest median among Embind, EM_JS and wasm-bindgen for each operation, including shims written in a different guest language. The phase tables in the original comparison describe workload differences and include raw JavaScript.

![Candidate runtime relative to the two targets by operation and language](web/bench/results/candidate-runtime.png)

| Operation | Guest | Unit | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Fastest shim | Shim time | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | µs | 1.36 | 3.67 | 0.68 | 0.49× | Embind | 1.05 | 0.64× |
| Attribute write | C++ | µs | 1.36 | 3.99 | 0.57 | 0.42× | Embind | 1.05 | 0.54× |
| Attribute write | Rust | µs | 1.41 | 4.15 | 0.86 | 0.61× | Embind | 1.05 | 0.82× |
| Canvas fillRect | C | µs | 1.02 | 3.88 | 1.00 | 0.99× | Embind | 1.62 | 0.62× |
| Canvas fillRect | C++ | µs | 1.04 | 4.00 | 0.92 | 0.88× | Embind | 1.62 | 0.57× |
| Canvas fillRect | Rust | µs | 0.84 | 3.84 | 0.94 | 1.11× | Embind | 1.62 | 0.58× |
| Canvas pixel read | C | µs | 335.20 | 323.00 | 324.80 | 0.97× | Embind | 194.10 | 1.67× |
| Canvas pixel read | C++ | µs | 318.20 | 315.50 | 360.60 | 1.13× | Embind | 194.10 | 1.86× |
| Canvas pixel read | Rust | µs | 324.70 | 324.50 | 361.70 | 1.11× | Embind | 194.10 | 1.86× |
| DOM ID lookup | C | µs | 1.29 | 5.20 | 0.89 | 0.69× | Embind | 1.25 | 0.72× |
| DOM ID lookup | C++ | µs | 1.36 | 4.59 | 0.95 | 0.70× | Embind | 1.25 | 0.76× |
| DOM ID lookup | Rust | µs | 1.14 | 4.81 | 0.84 | 0.73× | Embind | 1.25 | 0.67× |
| Tree traversal | C | ms | 14.66 | 96.83 | 13.84 | 0.94× | EM_JS | 4.10 | 3.38× |
| Tree traversal | C++ | ms | 13.76 | 97.31 | 15.65 | 1.14× | EM_JS | 4.10 | 3.82× |
| Tree traversal | Rust | ms | 15.54 | 107.26 | 16.96 | 1.09× | EM_JS | 4.10 | 4.14× |
| Read 1 KiB string | C | µs | 17.00 | 7.17 | 2.02 | 0.12× | wasm-bindgen | 5.55 | 0.36× |
| Read 1 KiB string | C++ | µs | 4.68 | 8.02 | 1.95 | 0.42× | wasm-bindgen | 5.55 | 0.35× |
| Read 1 KiB string | Rust | µs | 9.68 | 7.25 | 1.92 | 0.20× | wasm-bindgen | 5.55 | 0.35× |
| Table creation | C | ms | 12.38 | 62.73 | 14.48 | 1.17× | EM_JS | 5.71 | 2.53× |
| Table creation | C++ | ms | 13.09 | 69.38 | 13.06 | 1.00× | EM_JS | 5.71 | 2.29× |
| Table creation | Rust | ms | 12.45 | 67.34 | 13.94 | 1.12× | EM_JS | 5.71 | 2.44× |

### Change from the previous branch revision

Both revisions ran on the same guest binaries in the same browser session. Each cell divides the candidate median by the previous revision’s median. Parentheses count the rounds in which the candidate finished faster. [Compare `5db31f3a5` and `7c5712b61`](https://github.com/vados-cosmonic/jco/compare/5db31f3a5bb23c4392f76f68845b37e7f4d2c3bf...7c5712b61abb6a026ea7eb94228d77a87bd030e6)

The generated JavaScript and Wasm were byte-identical for 9/21 headline cases. On separate fresh pages, the ratios for those identical builds ranged from 0.87× to 1.08×. That spread measures run-to-run variation on this machine. [Output hashes](web/bench/results/candidate-sizes.json)

| Operation | C | C++ | Rust |
| --- | --- | --- | --- |
| Attribute write | 0.94× (5/7) | 0.93× (4/7) | 1.08× (2/7) |
| Canvas fillRect | 1.03× (3/7) | 0.96× (4/7) | 0.96× (4/7) |
| Canvas pixel read | 0.97× (4/7) | 1.07× (3/7) | 1.05× (3/7) |
| DOM ID lookup | 1.02× (4/7) | 0.78× (6/7) | 1.09× (3/7) |
| Tree traversal | 0.87× (5/7) | 1.00× (5/7) | 1.04× (4/7) |
| Read 1 KiB string | 0.93× (5/7) | 0.93× (4/7) | 0.87× (6/7) |
| Table creation | 1.13× (3/7) | 0.99× (3/7) | 1.14× (4/7) |
| Bulk DOM query | 0.96× (3/7) | 0.81× (6/7) | 1.27× (1/7) |
| Tree construction | 0.92× (5/7) | 0.98× (4/7) | 1.14× (1/7) |
| set 8 B | 0.92× (6/7) | 1.02× (2/7) | 0.98× (4/7) |
| get 8 B | 0.53× (7/7) | 0.65× (6/7) | 0.82× (6/7) |
| get 128 B | 0.87× (6/7) | 0.97× (5/7) | 0.99× (4/7) |
| get 16384 B | 0.93× (4/7) | 1.07× (3/7) | 0.98× (3/7) |
| get 262144 B | 0.96× (5/7) | 1.00× (3/7) | 1.00× (2/7) |

### Warm 1.13.0 comparison on the same page

For each guest and workload, both builds run once to warm up, then 4 times each on the same page. Each pair alternates which build runs first. The runner clears the DOM and performance entries before every call. It repeats this on 9 fresh pages. Each page contributes the median of its candidate / 1.13.0 ratios. The median across pages was at or below 1× for **19/21** headline cases. [Raw paired timings](web/bench/results/paired-browser.json)

![Median paired time ratios by workload and guest, with bars spanning the middle half of page ratios](web/bench/results/paired-runtime.png)

| Operation | Guest | Candidate / 1.13.0 | Middle 50% of page ratios | Pages at or below 1× |
| --- | --- | --- | --- | --- |
| Attribute write | C | 0.49× | 0.48–0.50× | 9/9 |
| Attribute write | C++ | 0.51× | 0.49–0.52× | 9/9 |
| Attribute write | Rust | 0.57× | 0.55–0.59× | 9/9 |
| Canvas fillRect | C | 0.92× | 0.91–0.93× | 7/9 |
| Canvas fillRect | C++ | 0.94× | 0.93–0.97× | 8/9 |
| Canvas fillRect | Rust | 0.94× | 0.94–0.97× | 9/9 |
| Canvas pixel read | C | 1.13× | 1.10–1.50× | 2/9 |
| Canvas pixel read | C++ | 1.01× | 0.95–1.02× | 4/9 |
| Canvas pixel read | Rust | 0.97× | 0.86–1.01× | 6/9 |
| DOM ID lookup | C | 0.59× | 0.56–0.70× | 9/9 |
| DOM ID lookup | C++ | 0.59× | 0.56–0.71× | 9/9 |
| DOM ID lookup | Rust | 0.63× | 0.59–0.74× | 9/9 |
| Tree traversal | C | 0.78× | 0.77–0.83× | 9/9 |
| Tree traversal | C++ | 0.82× | 0.76–0.85× | 8/9 |
| Tree traversal | Rust | 0.67× | 0.56–0.92× | 8/9 |
| Read 1 KiB string | C | 0.48× | 0.47–0.54× | 9/9 |
| Read 1 KiB string | C++ | 0.50× | 0.46–0.52× | 9/9 |
| Read 1 KiB string | Rust | 0.49× | 0.48–0.49× | 9/9 |
| Table creation | C | 0.96× | 0.81–1.04× | 6/9 |
| Table creation | C++ | 0.94× | 0.82–0.97× | 8/9 |
| Table creation | Rust | 0.94× | 0.92–0.95× | 9/9 |

Across all 84 reported phases and string lengths, the same-page comparison matched or beat 1.13.0 in **80/84** cases. Totals and subphases overlap.

| Slower paired phase | Guest | Metric | Candidate / 1.13.0 | Pages at or below 1× |
| --- | --- | --- | --- | --- |
| canvas-pixels | C | getImageData(): µs/call | 1.129× | 2/9 |
| canvas-pixels | C++ | getImageData(): µs/call | 1.007× | 4/9 |
| string-marshalling | Rust | set 16384 B | 1.003× | 3/9 |
| string-marshalling | C | set 16384 B | 1.001× | 4/9 |

Across all reported phases and string lengths, 81/84 comparable candidate medians were within 10× of the fastest compiled shim and 64/84 matched or beat 1.13.0. Totals and their subphases overlap. Each ratio compares the same phase on both sides.

| Phases above 10× | Phase | Guest | Shim | Candidate / shim |
| --- | --- | --- | --- | --- |
| dom-query | bulk: total ms | C | Embind | 486.75× |
| dom-query | bulk: total ms | C++ | Embind | 518.25× |
| dom-query | bulk: total ms | Rust | Embind | 555.25× |

The bulk DOM query returns a live collection to Embind, which discards it. The component host materializes the collection with `Array.from`, then the bindings lower every element into a WIT resource handle. The ratio includes that difference in work. [Embind loop](cpp/dom-query/emscripten/main.cpp) · [Component host](web/host/web-host.js) · [C guest loop](c/dom-query/main.c)

### DOM bindings with identical guest code

These 216 fresh-page samples compare each language’s exact core Wasm binary with each set of bindings in the table. The direct JS shim calls the same DOM host, puts owned handles in guest memory and recycles them on guest drops. It implements the synchronous imports used by these guests. Jco also provides Canonical ABI checks, task tracking and instance shutdown. [Direct shim](web/bench/dom-core-shim.mjs) · [Raw timings and correctness checks](web/bench/results/dom-control-browser.json)

The bulk query copies 2,000 handles per call, 10 times. Each traversal visits 19,531 nodes. The runner checks the rendered fixture or node count for each guest and verifies list counts and handle release for the direct shim after warm-up and measurement.

With list materialization on both sides, the candidate took **1.49–2.03×** the direct shim’s bulk-query time across the three guests. Times below are per measured workload, after warm-up.

![DOM phase times for Jco 1.13.0 and the candidate relative to the same-guest direct shim](web/bench/results/dom-control-runtime.png)

| Phase | Guest | Direct (ms) | 1.13.0 (ms) | Candidate (ms) | Candidate / direct | Candidate / 1.13.0 | Rounds at or below 1.13.0 | Candidate / previous | Rounds at or below previous |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DOM ID lookup | C | 13.43 | 26.61 | 18.68 | 1.39× | 0.70× | 8/9 | 1.05× | 5/9 |
| DOM ID lookup | C++ | 13.68 | 26.79 | 20.75 | 1.52× | 0.77× | 8/9 | 1.00× | 5/9 |
| DOM ID lookup | Rust | 13.71 | 22.16 | 16.56 | 1.21× | 0.75× | 8/9 | 0.92× | 6/9 |
| Bulk DOM query | C | 5.94 | 11.14 | 10.48 | 1.76× | 0.94× | 5/9 | 0.97× | 7/9 |
| Bulk DOM query | C++ | 6.08 | 11.21 | 12.36 | 2.03× | 1.10× | 4/9 | 1.14× | 3/9 |
| Bulk DOM query | Rust | 6.29 | 11.40 | 9.40 | 1.49× | 0.82× | 6/9 | 0.93× | 6/9 |
| Tree construction | C | 23.41 | 48.23 | 40.12 | 1.71× | 0.83× | 7/9 | 0.86× | 8/9 |
| Tree construction | C++ | 22.09 | 52.67 | 48.34 | 2.19× | 0.92× | 4/9 | 1.00× | 3/9 |
| Tree construction | Rust | 20.23 | 46.95 | 39.37 | 1.95× | 0.84× | 8/9 | 0.88× | 6/9 |
| Tree traversal | C | 5.54 | 13.24 | 12.94 | 2.34× | 0.98× | 4/9 | 0.99× | 5/9 |
| Tree traversal | C++ | 5.86 | 14.75 | 16.33 | 2.79× | 1.11× | 3/9 | 1.07× | 3/9 |
| Tree traversal | Rust | 6.70 | 16.66 | 16.51 | 2.46× | 0.99× | 4/9 | 0.96× | 6/9 |

### Cost of a synchronous host import

The scalar, string and resource loops run 131,072 iterations per pass. The string loop changes the first byte before each call. The resource loop acquires a host object, borrows it to read its value, and drops it. The optional-resource loop checks the discriminant in guest memory every time and reads and drops each present handle. Each pass checks its checksum. All four adapters use byte-identical core modules. The direct shim keeps the fixture’s single live handle in one slot.

The byte-list loops copy a 176 × 176 RGBA region (123,904 bytes) 2,048 times per pass in each direction. The host-to-guest case uses a reusable host view and a fixed guest allocation. In the reverse direction the host keeps the final snapshot while the guest changes the source in Wasm. Both cases sum the changing first byte during the loop and verify the whole payload afterward. The canvas demo also measures browser readback, host allocation and guest allocation.

The string-return loops make 32,768 calls per pass for 16-byte results and 1,024 for 16 KiB results. One host returns a repeated ASCII string. The other rotates four strings containing two-, three-, and four-byte UTF-8 sequences. The guest checks each byte length, sums the first bytes, and hashes every distinct result outside the timer.

Times are nanoseconds per guest iteration, including the loop and host work. Each cell is the median of 7 fresh-page medians, with 2 warm-ups and 5 timed passes per page. The runner interleaves the four builds. [Raw timings and digests](web/bench/results/import-loop.json)

| Operation | Direct | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Candidate / direct |
| --- | --- | --- | --- | --- | --- | --- |
| u32 | 13.7 | 12.2 | 1,831.1 | 14.5 | 1.19× | 1.06× |
| 2-byte string | 425.0 | 415.0 | 2,540.6 | 116.0 | 0.28× | 0.27× |
| 9-byte string | 418.1 | 405.9 | 2,395.6 | 167.8 | 0.41× | 0.40× |
| 32-byte string | 382.2 | 399.8 | 2,404.0 | 389.9 | 0.98× | 1.02× |
| Acquire, borrow, drop | 41.2 | 222.0 | 4,149.6 | 114.4 | 0.52× | 2.78× |
| Optional resource, half present | 30.5 | 168.6 | 2,957.9 | 124.4 | 0.74× | 4.08× |
| 121 KiB host-to-guest byte list | 4,541.0 | 4,589.8 | 8,203.1 | 4,834.0 | 1.05× | 1.06× |
| 121 KiB guest-to-host byte list | 95,410.2 | 94,043.0 | 99,853.5 | 93,359.4 | 0.99× | 0.98× |
| 16-byte UTF-8 result, repeated ASCII | 1,611.3 | 1,654.1 | 3,848.3 | 360.1 | 0.22× | 0.22× |
| 16-byte UTF-8 result, rotating Unicode | 1,663.2 | 1,843.3 | 4,339.6 | 909.4 | 0.49× | 0.55× |
| 16 KiB UTF-8 result, repeated ASCII | 33,203.1 | 33,105.5 | 50,683.6 | 17,285.2 | 0.52× | 0.52× |
| 16 KiB UTF-8 result, rotating Unicode | 43,750.0 | 43,652.3 | 74,511.7 | 30,078.1 | 0.69× | 0.69× |

![Time per guest iteration relative to Jco 1.13.0, by import and transfer direction](web/bench/results/import-loop-runtime.png)

### Where the canvas read spends its time

The same-page comparison was repeated with a clock around the demo’s host method. That method reads 176 × 176 pixels from Chromium and creates a JavaScript byte array. The remainder includes guest allocation and freeing, the copy into Wasm, binding checks, the loop and observer overhead. Each cell is a median across 9 page medians. Columns are summarized independently. [Raw instrumented samples](web/bench/results/canvas-control-browser.json)

| Guest | Bindings | Full read (µs) | Inside host (µs) | Remainder (µs) | Inside host (%) |
| --- | --- | --- | --- | --- | --- |
| C | 1.13.0 | 325.7 | 314.6 | 13.7 | 96.1% |
| C | Candidate | 329.9 | 316.4 | 13.5 | 96.0% |
| C++ | 1.13.0 | 340.2 | 326.3 | 12.7 | 96.2% |
| C++ | Candidate | 312.7 | 300.2 | 13.0 | 96.0% |
| Rust | 1.13.0 | 338.2 | 324.7 | 13.2 | 96.2% |
| Rust | Candidate | 307.3 | 295.2 | 12.2 | 96.0% |

The host accounted for 96.0–96.2% of the full read across these builds. The candidate spent 12.2–13.5 µs per read outside the host, compared with 12.7–13.7 µs for 1.13.0.

<details><summary>All timed phases and string lengths</summary>

| Demo | Phase | Guest | Candidate time | Fresh-page / 1.13.0 | Same-page / 1.13.0 | Candidate / main | Fastest shim | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| attribute-churn | total time | C | 53.98 ms | 0.49× | 0.49× | 0.18× | Embind | 0.64× |
| attribute-churn | total time | C++ | 45.46 ms | 0.42× | 0.51× | 0.14× | Embind | 0.54× |
| attribute-churn | total time | Rust | 68.46 ms | 0.61× | 0.56× | 0.21× | Embind | 0.82× |
| attribute-churn | per setAttribute() | C | 0.68 µs | 0.49× | 0.49× | 0.18× | Embind | 0.64× |
| attribute-churn | per setAttribute() | C++ | 0.57 µs | 0.42× | 0.51× | 0.14× | Embind | 0.54× |
| attribute-churn | per setAttribute() | Rust | 0.86 µs | 0.61× | 0.57× | 0.21× | Embind | 0.82× |
| canvas-draw | total | C | 50.26 ms | 0.99× | 0.92× | 0.26× | Embind | 0.62× |
| canvas-draw | total | C++ | 45.79 ms | 0.88× | 0.94× | 0.23× | Embind | 0.57× |
| canvas-draw | total | Rust | 46.88 ms | 1.11× | 0.94× | 0.24× | Embind | 0.58× |
| canvas-draw | per fill_rect() | C | 1.00 µs | 0.99× | 0.92× | 0.26× | Embind | 0.62× |
| canvas-draw | per fill_rect() | C++ | 0.92 µs | 0.88× | 0.94× | 0.23× | Embind | 0.57× |
| canvas-draw | per fill_rect() | Rust | 0.94 µs | 1.11× | 0.94× | 0.24× | Embind | 0.58× |
| canvas-pixels | getImageData(): µs/call | C | 324.80 µs | 0.97× | 1.13× | 1.01× | Embind | 1.67× |
| canvas-pixels | getImageData(): µs/call | C++ | 360.60 µs | 1.13× | 1.01× | 1.14× | Embind | 1.86× |
| canvas-pixels | getImageData(): µs/call | Rust | 361.70 µs | 1.11× | 0.97× | 1.11× | Embind | 1.86× |
| canvas-pixels | putImageData(): µs/call | C | 238.70 µs | 0.96× | 0.96× | 0.87× | Embind | 1.36× |
| canvas-pixels | putImageData(): µs/call | C++ | 253.70 µs | 1.04× | 0.91× | 0.88× | Embind | 1.44× |
| canvas-pixels | putImageData(): µs/call | Rust | 257.30 µs | 0.57× | 0.91× | 0.98× | Embind | 1.46× |
| dom-query | individual: total ms | C | 17.86 ms | 0.69× | 0.59× | 0.17× | Embind | 0.72× |
| dom-query | individual: total ms | C++ | 18.99 ms | 0.70× | 0.59× | 0.21× | Embind | 0.76× |
| dom-query | individual: total ms | Rust | 16.80 ms | 0.73× | 0.63× | 0.17× | Embind | 0.67× |
| dom-query | bulk: total ms | C | 9.73 ms | 0.86× | 0.75× | 0.56× | Embind | 486.75× |
| dom-query | bulk: total ms | C++ | 10.37 ms | 0.86× | 0.75× | 0.57× | Embind | 518.25× |
| dom-query | bulk: total ms | Rust | 11.11 ms | 1.04× | 0.76× | 0.63× | Embind | 555.25× |
| dom-query | individual: µs/element | C | 0.89 µs | 0.69× | 0.59× | 0.17× | Embind | 0.72× |
| dom-query | individual: µs/element | C++ | 0.95 µs | 0.70× | 0.59× | 0.21× | Embind | 0.76× |
| dom-query | individual: µs/element | Rust | 0.84 µs | 0.73× | 0.63× | 0.17× | Embind | 0.67× |
| dom-traversal | build | C | 46.13 ms | 0.95× | 0.85× | 0.24× | EM_JS | 2.63× |
| dom-traversal | build | C++ | 46.04 ms | 0.94× | 0.73× | 0.23× | EM_JS | 2.62× |
| dom-traversal | build | Rust | 47.68 ms | 1.04× | 0.83× | 0.23× | EM_JS | 2.72× |
| dom-traversal | traverse (total) | C | 13.84 ms | 0.94× | 0.78× | 0.14× | EM_JS | 3.38× |
| dom-traversal | traverse (total) | C++ | 15.65 ms | 1.14× | 0.82× | 0.16× | EM_JS | 3.82× |
| dom-traversal | traverse (total) | Rust | 16.96 ms | 1.09× | 0.67× | 0.16× | EM_JS | 4.14× |
| dom-traversal | traverse (per node) | C | 0.71 µs | 0.94× | 0.78× | 0.14× | EM_JS | 3.37× |
| dom-traversal | traverse (per node) | C++ | 0.80 µs | 1.14× | 0.82× | 0.16× | EM_JS | 3.82× |
| dom-traversal | traverse (per node) | Rust | 0.87 µs | 1.09× | 0.67× | 0.16× | EM_JS | 4.13× |
| string-marshalling | set 8 B | C | 0.41 µs | 0.50× | 0.75× | 0.13× | EM_JS | 1.05× |
| string-marshalling | set 8 B | C++ | 0.40 µs | 0.48× | 0.66× | 0.12× | EM_JS | 1.02× |
| string-marshalling | set 8 B | Rust | 0.36 µs | 0.41× | 0.71× | 0.11× | EM_JS | 0.91× |
| string-marshalling | get 8 B | C | 0.54 µs | 0.20× | 0.25× | 0.12× | EM_JS | 2.62× |
| string-marshalling | get 8 B | C++ | 0.51 µs | 0.24× | 0.25× | 0.11× | EM_JS | 2.49× |
| string-marshalling | get 8 B | Rust | 0.49 µs | 0.22× | 0.24× | 0.10× | EM_JS | 2.37× |
| string-marshalling | set 128 B | C | 0.61 µs | 1.01× | 0.87× | 0.16× | wasm-bindgen | 1.16× |
| string-marshalling | set 128 B | C++ | 0.61 µs | 0.79× | 0.90× | 0.16× | wasm-bindgen | 1.16× |
| string-marshalling | set 128 B | Rust | 0.59 µs | 0.63× | 0.91× | 0.15× | wasm-bindgen | 1.12× |
| string-marshalling | get 128 B | C | 1.76 µs | 0.73× | 0.75× | 0.34× | wasm-bindgen | 2.11× |
| string-marshalling | get 128 B | C++ | 1.76 µs | 0.70× | 0.74× | 0.39× | wasm-bindgen | 2.11× |
| string-marshalling | get 128 B | Rust | 1.83 µs | 0.81× | 0.71× | 0.38× | wasm-bindgen | 2.19× |
| string-marshalling | set 1024 B | C | 1.00 µs | 0.81× | 0.98× | 0.30× | wasm-bindgen | 1.12× |
| string-marshalling | set 1024 B | C++ | 0.99 µs | 0.95× | 0.92× | 0.28× | wasm-bindgen | 1.11× |
| string-marshalling | set 1024 B | Rust | 0.97 µs | 0.77× | 0.97× | 0.28× | wasm-bindgen | 1.09× |
| string-marshalling | get 1024 B | C | 2.02 µs | 0.12× | 0.48× | 0.28× | wasm-bindgen | 0.36× |
| string-marshalling | get 1024 B | C++ | 1.95 µs | 0.42× | 0.50× | 0.24× | wasm-bindgen | 0.35× |
| string-marshalling | get 1024 B | Rust | 1.92 µs | 0.20× | 0.49× | 0.26× | wasm-bindgen | 0.35× |
| string-marshalling | set 16384 B | C | 7.33 µs | 1.05× | 1.00× | 0.76× | wasm-bindgen | 1.14× |
| string-marshalling | set 16384 B | C++ | 7.12 µs | 1.01× | 1.00× | 0.72× | wasm-bindgen | 1.11× |
| string-marshalling | set 16384 B | Rust | 6.59 µs | 0.91× | 1.00× | 0.63× | wasm-bindgen | 1.03× |
| string-marshalling | get 16384 B | C | 18.23 µs | 0.53× | 0.54× | 0.36× | wasm-bindgen | 0.23× |
| string-marshalling | get 16384 B | C++ | 19.43 µs | 0.23× | 0.53× | 0.36× | wasm-bindgen | 0.24× |
| string-marshalling | get 16384 B | Rust | 17.83 µs | 0.50× | 0.49× | 0.32× | wasm-bindgen | 0.22× |
| string-marshalling | set 262144 B | C | 108.60 µs | 0.42× | 0.99× | 0.44× | Embind | 0.99× |
| string-marshalling | set 262144 B | C++ | 107.75 µs | 0.43× | 0.72× | 0.41× | Embind | 0.98× |
| string-marshalling | set 262144 B | Rust | 104.17 µs | 0.40× | 0.70× | 0.39× | Embind | 0.95× |
| string-marshalling | get 262144 B | C | 274.15 µs | 0.29× | 0.29× | 0.37× | wasm-bindgen | 0.22× |
| string-marshalling | get 262144 B | C++ | 273.00 µs | 0.29× | 0.30× | 0.37× | wasm-bindgen | 0.22× |
| string-marshalling | get 262144 B | Rust | 277.15 µs | 0.29× | 0.30× | 0.35× | wasm-bindgen | 0.22× |
| table-update | create: total ms | C | 14.48 ms | 1.17× | 0.96× | 0.23× | EM_JS | 2.53× |
| table-update | create: total ms | C++ | 13.06 ms | 1.00× | 0.94× | 0.19× | EM_JS | 2.29× |
| table-update | create: total ms | Rust | 13.94 ms | 1.12× | 0.94× | 0.21× | EM_JS | 2.44× |
| table-update | create: µs/row | C | 7.24 µs | 1.17× | 0.96× | 0.23× | EM_JS | 2.54× |
| table-update | create: µs/row | C++ | 6.53 µs | 1.00× | 0.94× | 0.19× | EM_JS | 2.29× |
| table-update | create: µs/row | Rust | 6.97 µs | 1.12× | 0.94× | 0.21× | EM_JS | 2.44× |
| table-update | update (selected): total ms | C | 1.05 ms | 1.15× | 0.79× | 0.34× | wasm-bindgen | 1.16× |
| table-update | update (selected): total ms | C++ | 1.00 ms | 0.95× | 0.88× | 0.31× | wasm-bindgen | 1.10× |
| table-update | update (selected): total ms | Rust | 0.94 ms | 0.97× | 0.83× | 0.31× | wasm-bindgen | 1.04× |
| table-update | update (selected): µs/row | C | 0.53 µs | 1.15× | 0.79× | 0.34× | wasm-bindgen | 1.16× |
| table-update | update (selected): µs/row | C++ | 0.50 µs | 0.95× | 0.88× | 0.31× | wasm-bindgen | 1.10× |
| table-update | update (selected): µs/row | Rust | 0.47 µs | 0.97× | 0.83× | 0.31× | wasm-bindgen | 1.04× |
| table-update | clear (unselected): total ms | C | 3.58 ms | 0.99× | 0.77× | 0.24× | wasm-bindgen | 1.52× |
| table-update | clear (unselected): total ms | C++ | 3.23 ms | 0.80× | 0.74× | 0.19× | wasm-bindgen | 1.38× |
| table-update | clear (unselected): total ms | Rust | 3.46 ms | 0.99× | 0.78× | 0.22× | wasm-bindgen | 1.47× |
| table-update | clear (unselected): µs/row | C | 1.79 µs | 0.99× | 0.77× | 0.24× | wasm-bindgen | 1.52× |
| table-update | clear (unselected): µs/row | C++ | 1.62 µs | 0.80× | 0.75× | 0.19× | wasm-bindgen | 1.38× |
| table-update | clear (unselected): µs/row | Rust | 1.73 µs | 0.99× | 0.78× | 0.22× | wasm-bindgen | 1.47× |

</details>

### Payload and startup

Payload medians cover 34 component inputs. Compression is per file. Startup is the median of the 21 per-workload and guest medians, from dynamic import through initialization, with browser caching disabled.

| Build | JS (KiB) | Core Wasm (KiB) | Total (KiB) | Gzip (KiB) | Brotli (KiB) | Startup (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 | 19.4 | 64.4 | 85.4 | 29.3 | 24.1 | 10.36 |
| Stock main | 180.8 | 64.4 | 252.1 | 57.6 | 47.8 | 23.58 |
| Candidate | 149.9 | 64.4 | 217.7 | 53.7 | 44.5 | 21.17 |

### Generated JavaScript reached by each demo

Chromium recorded block coverage on 126 fresh pages in a separate run. One page imported each module and finished initialization. A second also ran the demo once and checked its output. The table reports medians over the 21 guest and workload combinations. Sizes count UTF-8 bytes in V8’s covered source ranges. A demo can leave error handling, shutdown or other supported operations unexercised. [Per-module coverage and hashes](web/bench/results/js-coverage.json)

| Build | Reached at init (KiB) | Reached through first run (KiB) | Share through first run | Unreached through first run (KiB) |
| --- | --- | --- | --- | --- |
| 1.13.0 | 4.8 | 16.3 | 76.6% | 5.0 |
| Stock main | 53.9 | 96.3 | 51.2% | 91.3 |
| Candidate | 42.8 | 67.1 | 43.9% | 85.9 |

<details><summary>Candidate startup, variation and paired comparison to 1.13.0</summary>

The paired ratio divides the candidate time by the 1.13.0 time within each round, then takes the median. The final column counts rounds where the candidate was at least as fast.

| Operation | Guest | Startup median (ms) | Warm phase p25 | Warm phase p50 | Warm phase p75 | Phase unit | Paired ratio to 1.13.0 | Rounds at or below 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | 20.82 | 0.63 | 0.68 | 0.69 | µs | 0.48× | 7/7 |
| Attribute write | C++ | 21.07 | 0.54 | 0.57 | 0.66 | µs | 0.46× | 7/7 |
| Attribute write | Rust | 18.28 | 0.78 | 0.86 | 0.89 | µs | 0.58× | 7/7 |
| Canvas fillRect | C | 21.25 | 0.80 | 1.00 | 1.11 | µs | 0.93× | 5/7 |
| Canvas fillRect | C++ | 21.16 | 0.85 | 0.92 | 0.98 | µs | 0.90× | 5/7 |
| Canvas fillRect | Rust | 21.14 | 0.81 | 0.94 | 0.97 | µs | 0.96× | 4/7 |
| Canvas pixel read | C | 23.81 | 294.35 | 324.80 | 346.25 | µs | 0.94× | 6/7 |
| Canvas pixel read | C++ | 23.37 | 331.80 | 360.60 | 371.95 | µs | 1.11× | 2/7 |
| Canvas pixel read | Rust | 22.71 | 348.95 | 361.70 | 371.40 | µs | 1.07× | 2/7 |
| DOM ID lookup | C | 22.94 | 0.81 | 0.89 | 1.07 | µs | 0.79× | 5/7 |
| DOM ID lookup | C++ | 23.36 | 0.91 | 0.95 | 1.08 | µs | 0.74× | 6/7 |
| DOM ID lookup | Rust | 21.17 | 0.75 | 0.84 | 0.91 | µs | 0.82× | 6/7 |
| Tree traversal | C | 20.51 | 13.06 | 13.84 | 15.49 | ms | 0.98× | 4/7 |
| Tree traversal | C++ | 20.87 | 13.71 | 15.65 | 15.80 | ms | 1.11× | 2/7 |
| Tree traversal | Rust | 20.12 | 16.82 | 16.96 | 20.34 | ms | 1.23× | 0/7 |
| Read 1 KiB string | C | 20.77 | 1.93 | 2.02 | 2.17 | µs | 0.11× | 7/7 |
| Read 1 KiB string | C++ | 22.86 | 1.86 | 1.95 | 2.05 | µs | 0.45× | 7/7 |
| Read 1 KiB string | Rust | 19.38 | 1.88 | 1.92 | 1.99 | µs | 0.20× | 7/7 |
| Table creation | C | 26.36 | 13.93 | 14.48 | 15.38 | ms | 1.14× | 3/7 |
| Table creation | C++ | 24.67 | 11.96 | 13.06 | 13.86 | ms | 0.95× | 4/7 |
| Table creation | Rust | 21.92 | 12.59 | 13.94 | 14.97 | ms | 1.09× | 2/7 |

</details>

[Raw browser timings](web/bench/results/candidate-browser.json) · [File sizes, digests and generator revision](web/bench/results/candidate-sizes.json)

### Reproduce the candidate run

Run the dependency installation, main setup and size commands in [Reproduce the comparison](#reproduce-the-comparison), then run the following from the repository root. Cargo uses the Jco checkout’s pinned toolchain and lockfile.

```sh
git clone https://github.com/vados-cosmonic/jco ../jco-candidate
git -C ../jco-candidate checkout 7c5712b61abb6a026ea7eb94228d77a87bd030e6
node web/bench/candidate.mjs ../jco-candidate
git -C ../jco-candidate worktree add --detach ../jco-reference 5db31f3a5bb23c4392f76f68845b37e7f4d2c3bf
node web/bench/candidate.mjs --reference ../jco-reference
CHROME_BIN=/path/to/chrome BENCH_CANDIDATE=1 ROUNDS=7 node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome BENCH_DOM_CONTROL=1 ROUNDS=9 node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome BENCH_PAIRED=1 ROUNDS=9 node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome BENCH_CANVAS_CONTROL=1 ROUNDS=9 node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome ROUNDS=7 node web/bench/import-loop.mjs ../jco-candidate
CHROME_BIN=/path/to/chrome node web/bench/coverage.mjs
python3 web/bench/report.py --from-candidate
python3 web/bench/candidate-report.py
```

To verify that the packaged WebAssembly transpiler emits the same files as the native generator used for timing, build it at the candidate commit and compare every generated JavaScript and core Wasm file against the recorded inventory.

```sh
pnpm -C ../jco-candidate install --frozen-lockfile
pnpm -C ../jco-candidate --filter @bytecodealliance/jco-transpile run build
node web/bench/candidate.mjs --verify-wasm ../jco-candidate
```

<!-- candidate:end -->

<!-- benchmark:start -->

## Browser performance

**jco 1.13.0 vs. main at `37f1dfaa`** · 2026-11-25 · HeadlessChrome/156.0.8078.47 · Intel(R) Xeon(R) Processor @ 2.60GHz · linux 6.12.111 x64 · Node v26.13.0. [Upstream commit](https://github.com/bytecodealliance/jco/commit/37f1dfaa31eef82d4ac38975cba66bafaca20b73) · [Transpiler build](https://github.com/bytecodealliance/jco/actions/runs/45716763144)

These stock and shim timings come from the same interleaved fresh-page trial as the performance branch. [Full trial](web/bench/results/candidate-browser.json) · [Stock and shim samples](web/bench/results/browser.json)

Across the seven operations below and three guest languages, main took longer in **16 of 21** median comparisons. The highest ratio was **7.07×** for the C++ guest in `dom-traversal`.

For 256 KiB string reads, the median time on main changed by -23% to -18% across the three guest languages. The phase tables below include every tested string size.

Each cell is the median of 7 fresh-page samples. The chart divides main’s median time by 1.13.0’s for the same guest and operation. A value below 1× means main finished faster.

![Median time on main divided by baseline time for seven operations and three guest languages](web/bench/results/runtime.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 0.306 | 1.05 | — | — | 1.36 | 3.67 | 1.36 | 3.99 | 1.41 | 4.15 |
| Canvas fillRect (µs) | 0.755 | 1.62 | — | — | 1.02 | 3.88 | 1.04 | 4.00 | 0.845 | 3.84 |
| Canvas pixel read (µs) | 171.50 | 194.10 | — | — | 335.20 | 323.00 | 318.20 | 315.50 | 324.70 | 324.50 |
| DOM ID lookup (µs) | 0.264 | 1.25 | — | — | 1.29 | 5.20 | 1.36 | 4.59 | 1.14 | 4.81 |
| Tree traversal (ms) | 0.895 | 21.44 | 4.10 | 5.72 | 14.66 | 96.83 | 13.76 | 97.31 | 15.54 | 107.26 |
| Read 1 KiB string (µs) | 0.093 | 11.15 | 11.17 | 5.55 | 17.00 | 7.17 | 4.68 | 8.02 | 9.68 | 7.25 |
| Table creation (ms) | 3.65 | 14.43 | 5.71 | 9.02 | 12.38 | 62.73 | 13.09 | 69.38 | 12.45 | 67.34 |

Embind and EM_JS are the C++ Emscripten variants. An em dash marks an unavailable combination. Across toolchains, the upstream implementations can do different amounts of work. For example, the JavaScript bulk DOM query obtains a live collection while the component host materializes a list.

<details><summary>Run-to-run variation for the two jco versions</summary>

Each cell spans the 25th to 75th percentile of measured times, using linear interpolation between sorted samples.

| Operation | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 1.31–1.42 | 3.53–3.75 | 1.31–1.39 | 3.86–4.06 | 1.35–1.47 | 4.05–4.27 |
| Canvas fillRect (µs) | 0.857–1.06 | 3.81–3.99 | 0.984–1.13 | 3.46–4.08 | 0.827–1.10 | 3.70–3.94 |
| Canvas pixel read (µs) | 324.10–349.15 | 311.60–348.70 | 290.90–345.90 | 313.40–322.35 | 296.20–353.40 | 313.00–361.75 |
| DOM ID lookup (µs) | 1.13–1.33 | 4.97–5.51 | 1.17–1.40 | 4.45–4.90 | 0.978–1.22 | 4.40–5.26 |
| Tree traversal (ms) | 13.40–15.52 | 93.12–101.72 | 11.74–15.66 | 93.05–99.98 | 13.52–17.00 | 102.99–114.74 |
| Read 1 KiB string (µs) | 10.25–19.12 | 6.48–7.78 | 3.82–5.10 | 7.28–8.10 | 4.51–28.02 | 6.73–7.50 |
| Table creation (ms) | 11.19–13.86 | 61.60–74.09 | 12.74–15.15 | 62.66–70.94 | 12.11–12.60 | 64.86–69.15 |

</details>

<details><summary>All workload phases, per-call timings, and string transfer rates</summary>

Times come from the tables rendered by the demos and retain their original reporting precision. Effective string throughput uses the ASCII payload length divided by median call time (decimal MB/s).

**attribute-churn**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total time (ms) | 24.49 | 83.84 | — | — | 109.11 | 293.75 | 108.64 | 318.94 | 113.06 | 331.80 |
| per setAttribute() (µs) | 0.306 | 1.05 | — | — | 1.36 | 3.67 | 1.36 | 3.99 | 1.41 | 4.15 |

**canvas-draw**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total (ms) | 37.74 | 80.93 | — | — | 50.84 | 194.00 | 52.13 | 200.03 | 42.23 | 192.03 |
| per fill_rect() (µs) | 0.755 | 1.62 | — | — | 1.02 | 3.88 | 1.04 | 4.00 | 0.845 | 3.84 |

**canvas-pixels**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| getImageData() (µs) | 171.50 | 194.10 | — | — | 335.20 | 323.00 | 318.20 | 315.50 | 324.70 | 324.50 |
| putImageData() (µs) | 13.60 | 175.90 | — | — | 249.00 | 273.80 | 243.50 | 288.80 | 454.50 | 261.60 |

**dom-query**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| individual, total (ms) | 5.28 | 24.91 | — | — | 25.73 | 104.00 | 27.12 | 91.89 | 22.87 | 96.17 |
| bulk, total (ms) | 0.015 | 0.02 | — | — | 11.33 | 17.54 | 12.06 | 18.17 | 10.65 | 17.50 |
| individual: µs/element (µs) | 0.264 | 1.25 | — | — | 1.29 | 5.20 | 1.36 | 4.59 | 1.14 | 4.81 |

**dom-traversal**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| build (ms) | 10.84 | 30.38 | 17.55 | 25.36 | 48.74 | 192.35 | 49.24 | 199.61 | 45.93 | 207.52 |
| traverse (total) (ms) | 0.895 | 21.44 | 4.10 | 5.72 | 14.66 | 96.83 | 13.76 | 97.31 | 15.54 | 107.26 |
| traverse (per node) (µs) | 0.046 | 1.10 | 0.21 | 0.293 | 0.751 | 4.96 | 0.705 | 4.98 | 0.795 | 5.49 |

**string-marshalling**

![Median DOM textContent set and get latency by payload length for each guest and jco version, on logarithmic axes](web/bench/results/strings.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| set 8 B (µs) | 0.175 | 0.717 | 0.394 | 0.502 | 0.832 | 3.10 | 0.842 | 3.45 | 0.886 | 3.17 |
| set 8 B (MB/s) | 45.71 | 11.16 | 20.30 | 15.94 | 9.62 | 2.58 | 9.50 | 2.32 | 9.03 | 2.53 |
| get 8 B (µs) | 0.075 | 0.987 | 0.206 | 0.22 | 2.73 | 4.51 | 2.13 | 4.52 | 2.19 | 4.67 |
| get 8 B (MB/s) | 106.67 | 8.11 | 38.83 | 36.36 | 2.93 | 1.78 | 3.76 | 1.77 | 3.66 | 1.71 |
| set 128 B (µs) | 0.284 | 1.08 | 0.867 | 0.524 | 0.602 | 3.68 | 0.768 | 3.81 | 0.928 | 3.81 |
| set 128 B (MB/s) | 450.70 | 118.52 | 147.64 | 244.27 | 212.62 | 34.77 | 166.67 | 33.63 | 137.93 | 33.59 |
| get 128 B (µs) | 0.08 | 2.02 | 1.51 | 0.834 | 2.40 | 5.15 | 2.51 | 4.54 | 2.25 | 4.84 |
| get 128 B (MB/s) | 1,600.00 | 63.52 | 84.71 | 153.48 | 53.38 | 24.84 | 50.96 | 28.16 | 56.94 | 26.42 |
| set 1024 B (µs) | 1.00 | 1.51 | 2.86 | 0.89 | 1.24 | 3.36 | 1.05 | 3.50 | 1.25 | 3.50 |
| set 1024 B (MB/s) | 1,020.94 | 678.60 | 357.79 | 1,150.56 | 827.14 | 304.49 | 978.97 | 292.15 | 816.59 | 292.32 |
| get 1024 B (µs) | 0.093 | 11.15 | 11.17 | 5.55 | 17.00 | 7.17 | 4.68 | 8.02 | 9.68 | 7.25 |
| get 1024 B (MB/s) | 11,010.75 | 91.84 | 91.71 | 184.50 | 60.22 | 142.90 | 218.62 | 127.70 | 105.74 | 141.30 |
| set 16384 B (µs) | 12.42 | 7.80 | 35.98 | 6.42 | 7.00 | 9.65 | 7.05 | 9.85 | 7.25 | 10.49 |
| set 16384 B (MB/s) | 1,319.48 | 2,099.71 | 455.43 | 2,552.42 | 2,341.57 | 1,697.82 | 2,324.96 | 1,662.84 | 2,259.86 | 1,561.72 |
| get 16384 B (µs) | 0.453 | 154.85 | 167.55 | 79.38 | 34.73 | 50.83 | 82.66 | 53.70 | 35.81 | 55.92 |
| get 16384 B (MB/s) | 36,167.77 | 105.81 | 97.79 | 206.41 | 471.82 | 322.36 | 198.20 | 305.10 | 457.49 | 292.96 |
| set 262144 B (µs) | 149.14 | 110.10 | 558.45 | 233.90 | 256.25 | 244.05 | 252.15 | 260.85 | 259.00 | 269.35 |
| set 262144 B (MB/s) | 1,757.69 | 2,380.96 | 469.41 | 1,120.75 | 1,023.00 | 1,074.14 | 1,039.64 | 1,004.96 | 1,012.14 | 973.25 |
| get 262144 B (µs) | 11.27 | 2,439.05 | 2,624.30 | 1,252.65 | 957.90 | 736.15 | 937.00 | 734.10 | 957.45 | 783.90 |
| get 262144 B (MB/s) | 23,260.34 | 107.48 | 99.89 | 209.27 | 273.67 | 356.10 | 279.77 | 357.10 | 273.79 | 334.41 |

**table-update**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create, total (ms) | 3.65 | 14.43 | 5.71 | 9.02 | 12.38 | 62.73 | 13.09 | 69.38 | 12.45 | 67.34 |
| create, per row (µs) | 1.82 | 7.21 | 2.86 | 4.51 | 6.19 | 31.37 | 6.54 | 34.69 | 6.22 | 33.67 |
| update (selected), total (ms) | 0.445 | 1.13 | 1.07 | 0.905 | 0.915 | 3.08 | 1.05 | 3.27 | 0.97 | 3.06 |
| update (selected), per row (µs) | 0.222 | 0.565 | 0.537 | 0.453 | 0.458 | 1.54 | 0.525 | 1.64 | 0.485 | 1.53 |
| clear (unselected), total (ms) | 1.48 | 3.45 | 3.15 | 2.35 | 3.62 | 15.21 | 4.06 | 16.91 | 3.49 | 15.68 |
| clear (unselected), per row (µs) | 0.737 | 1.73 | 1.58 | 1.18 | 1.81 | 7.61 | 2.03 | 8.46 | 1.75 | 7.84 |

</details>

<details><summary>Module load and initialization, median milliseconds</summary>

Elapsed browser time for dynamic import through instantiation, with the shared demo host already loaded. The browser process is reused, each page has HTTP caching disabled, and assets are served uncompressed over loopback. These timings include scheduling and local requests. JS is already loaded by the harness.

| Workload | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| attribute-churn | 15.16 | — | — | 10.29 | 22.31 | 9.83 | 23.05 | 10.36 | 22.44 |
| canvas-draw | 13.68 | — | — | 10.27 | 24.48 | 10.83 | 23.07 | 11.30 | 22.70 |
| canvas-pixels | 13.81 | — | — | 10.22 | 26.85 | 10.31 | 25.46 | 11.06 | 24.34 |
| dom-query | 12.90 | — | — | 10.68 | 25.00 | 10.03 | 23.38 | 10.65 | 23.18 |
| dom-traversal | 13.37 | 9.08 | 7.81 | 10.28 | 24.83 | 10.83 | 22.93 | 10.77 | 23.75 |
| string-marshalling | 11.71 | 8.31 | 7.88 | 9.06 | 22.13 | 9.37 | 23.58 | 9.05 | 21.76 |
| table-update | 13.32 | 9.00 | 8.30 | 12.40 | 26.34 | 10.39 | 23.96 | 10.87 | 25.87 |

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
