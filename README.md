# Component demos

This fork benchmarks the browser examples from [eqrion/component-demos at d0b9dd1](https://github.com/eqrion/component-demos/tree/d0b9dd1390a300978193adc623838fef4e4b632b). It runs the same compiled C, C++, and Rust WebAssembly components through jco 1.13.0, pinned upstream main, and a branch that optimizes synchronous host imports. The comparison also includes the demos’ JavaScript, Emscripten (Embind and EM_JS), and Rust wasm-bindgen implementations where available.

The performance branch also specializes UTF-8 conversion in both directions. For strings of up to 32 ASCII bytes, the bindings read or write the bytes directly. Non-ASCII text uses the checked codec, including its malformed-input traps. [Short-string changes](https://github.com/vados-cosmonic/jco/compare/ac28d5d481f3cfca94bc4c62f3571511c19386d9...9eeb7f0b9ab82a982810af5cdd1d9035b302aa39)

<!-- candidate:start -->

## Optimized browser bindings

The candidate uses js-component-bindgen’s internal Oxc bundler and the checked jco-cm-runtime. For eligible single-instance, synchronous components, a host import reuses the caller’s task. Resource drops use a one-argument trampoline that checks the instance flag and records traps. The internal Oxc bundle drops the general asynchronous import fallback for these components. The adapter holds direct references to its task stack and instance flags, checks the store for interruptions, and lifts short ASCII strings in groups of four bytes. Synchronous UTF-8 results of 256 to 262,144 code units can reuse a per-instance byte buffer, capped at 256 KiB. The runtime encodes there before requesting the exact guest allocation. Nested calls and larger results use the ordinary encoder. When lifting a borrowed host resource, the runtime validates the handle and reads its 32-bit representation directly. Imported host resources with automatically assigned representations use their guest handle as an array index. Explicit host representations and shared tables use a representation map. Components with async operations, cross-component resource transfers or call tracking keep the general adapter. [Jco commit `3f65947fd`](https://github.com/vados-cosmonic/jco/commit/3f65947fd57caf61bd5ad2fba06f3fd00734049c)

All Jco builds used the same guest binaries. Each value is the median of 7 fresh-page samples with one warm-up per page. The run collected 728 samples on 2026-11-25 with HeadlessChrome/156.0.8078.47 on Intel(R) Xeon(R) Processor @ 2.60GHz.

The candidate finished within **10× of the fastest available compiled shim in 21/21** headline comparisons. The largest ratio was **6.11×**. On separate fresh pages it matched or beat **1.13.0 in 16/21** and **stock main in 21/21**. On the same warmed page it matched or beat **1.13.0 in 17/21** headline cases and 77/84 across all phases. The shim comparison selects the lowest median among Embind, EM_JS and wasm-bindgen for each operation, including shims written in a different guest language. The phase tables in the original comparison describe workload differences and include raw JavaScript.

![Candidate runtime relative to the two targets by operation and language](web/bench/results/candidate-runtime.png)

| Operation | Guest | Unit | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Fastest shim | Shim time | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | µs | 2.60 | 8.02 | 1.43 | 0.55× | Embind | 1.78 | 0.81× |
| Attribute write | C++ | µs | 2.87 | 9.06 | 1.25 | 0.44× | Embind | 1.78 | 0.70× |
| Attribute write | Rust | µs | 2.56 | 7.71 | 2.09 | 0.82× | Embind | 1.78 | 1.18× |
| Canvas fillRect | C | µs | 2.04 | 8.30 | 2.32 | 1.14× | Embind | 2.85 | 0.81× |
| Canvas fillRect | C++ | µs | 2.56 | 8.95 | 2.11 | 0.83× | Embind | 2.85 | 0.74× |
| Canvas fillRect | Rust | µs | 1.63 | 8.89 | 2.23 | 1.37× | Embind | 2.85 | 0.78× |
| Canvas pixel read | C | µs | 838.40 | 819.70 | 739.10 | 0.88× | Embind | 461.90 | 1.60× |
| Canvas pixel read | C++ | µs | 800.00 | 857.20 | 788.40 | 0.99× | Embind | 461.90 | 1.71× |
| Canvas pixel read | Rust | µs | 855.60 | 837.50 | 822.50 | 0.96× | Embind | 461.90 | 1.78× |
| DOM ID lookup | C | µs | 2.65 | 10.51 | 1.91 | 0.72× | Embind | 2.26 | 0.84× |
| DOM ID lookup | C++ | µs | 2.97 | 8.89 | 2.26 | 0.76× | Embind | 2.26 | 1.00× |
| DOM ID lookup | Rust | µs | 2.44 | 11.17 | 1.56 | 0.64× | Embind | 2.26 | 0.69× |
| Tree traversal | C | ms | 29.24 | 169.40 | 30.63 | 1.05× | EM_JS | 6.04 | 5.07× |
| Tree traversal | C++ | ms | 30.19 | 161.75 | 26.12 | 0.87× | EM_JS | 6.04 | 4.32× |
| Tree traversal | Rust | ms | 31.28 | 180.81 | 36.88 | 1.18× | EM_JS | 6.04 | 6.11× |
| Read 1 KiB string | C | µs | 6.56 | 17.87 | 3.96 | 0.60× | wasm-bindgen | 8.71 | 0.45× |
| Read 1 KiB string | C++ | µs | 9.32 | 13.53 | 3.07 | 0.33× | wasm-bindgen | 8.71 | 0.35× |
| Read 1 KiB string | Rust | µs | 6.75 | 10.96 | 3.20 | 0.47× | wasm-bindgen | 8.71 | 0.37× |
| Table creation | C | ms | 23.87 | 117.15 | 20.51 | 0.86× | EM_JS | 9.62 | 2.13× |
| Table creation | C++ | ms | 27.52 | 110.56 | 23.01 | 0.84× | EM_JS | 9.62 | 2.39× |
| Table creation | Rust | ms | 21.01 | 117.01 | 24.40 | 1.16× | EM_JS | 9.62 | 2.54× |

### Change from the previous branch revision

Both revisions ran on the same guest binaries in the same browser session. Each cell divides the candidate median by the previous revision’s median. Parentheses count the rounds in which the candidate finished faster. [Compare `241dcf8cb` and `3f65947fd`](https://github.com/vados-cosmonic/jco/compare/241dcf8cb4dda2c981a12ef9bfbcdd75f8bddf08...3f65947fd57caf61bd5ad2fba06f3fd00734049c)

The generated JavaScript and Wasm were byte-identical for 15/21 headline cases. On separate fresh pages, the ratios for those identical builds ranged from 0.85× to 1.43×. That spread measures run-to-run variation on this machine. [Output hashes](web/bench/results/candidate-sizes.json)

| Operation | C | C++ | Rust |
| --- | --- | --- | --- |
| Attribute write | 1.22× (5/7) | 0.85× (4/7) | 1.12× (3/7) |
| Canvas fillRect | 1.02× (4/7) | 0.96× (4/7) | 1.43× (2/7) |
| Canvas pixel read | 1.10× (2/7) | 1.02× (4/7) | 1.08× (2/7) |
| DOM ID lookup | 1.00× (3/7) | 1.04× (2/7) | 0.99× (1/7) |
| Tree traversal | 1.04× (3/7) | 0.91× (3/7) | 1.06× (4/7) |
| Read 1 KiB string | 0.47× (7/7) | 0.50× (7/7) | 0.47× (7/7) |
| Table creation | 0.85× (5/7) | 0.89× (5/7) | 1.10× (2/7) |
| Bulk DOM query | 1.13× (2/7) | 0.86× (3/7) | 1.10× (2/7) |
| Tree construction | 1.10× (3/7) | 0.89× (5/7) | 1.09× (2/7) |
| set 8 B | 0.93× (2/7) | 0.92× (3/7) | 1.10× (4/7) |
| get 8 B | 0.78× (4/7) | 1.16× (2/7) | 1.04× (2/7) |
| get 16384 B | 0.22× (7/7) | 0.37× (7/7) | 0.33× (7/7) |
| get 262144 B | 0.28× (7/7) | 0.41× (7/7) | 0.33× (7/7) |

### Warm 1.13.0 comparison on the same page

For each guest and workload, both builds run once to warm up, then 4 times each on the same page. Each pair alternates which build runs first. The runner clears the DOM and performance entries before every call. It repeats this on 9 fresh pages. Each page contributes the median of its candidate / 1.13.0 ratios. The median across pages was at or below 1× for **17/21** headline cases. [Raw paired timings](web/bench/results/paired-browser.json)

![Median paired time ratios by workload and guest, with bars spanning the middle half of page ratios](web/bench/results/paired-runtime.png)

| Operation | Guest | Candidate / 1.13.0 | Middle 50% of page ratios | Pages at or below 1× |
| --- | --- | --- | --- | --- |
| Attribute write | C | 0.52× | 0.48–0.55× | 9/9 |
| Attribute write | C++ | 0.49× | 0.47–0.52× | 9/9 |
| Attribute write | Rust | 0.54× | 0.53–0.58× | 9/9 |
| Canvas fillRect | C | 0.86× | 0.83–0.91× | 8/9 |
| Canvas fillRect | C++ | 0.89× | 0.85–0.90× | 9/9 |
| Canvas fillRect | Rust | 0.95× | 0.94–1.05× | 5/9 |
| Canvas pixel read | C | 1.07× | 1.01–1.11× | 2/9 |
| Canvas pixel read | C++ | 1.02× | 0.95–1.04× | 4/9 |
| Canvas pixel read | Rust | 1.00× | 0.98–1.06× | 4/9 |
| DOM ID lookup | C | 0.65× | 0.57–0.72× | 9/9 |
| DOM ID lookup | C++ | 0.63× | 0.57–0.71× | 9/9 |
| DOM ID lookup | Rust | 0.63× | 0.56–0.73× | 9/9 |
| Tree traversal | C | 0.81× | 0.79–0.89× | 9/9 |
| Tree traversal | C++ | 0.76× | 0.75–0.82× | 9/9 |
| Tree traversal | Rust | 0.70× | 0.62–1.07× | 6/9 |
| Read 1 KiB string | C | 0.44× | 0.41–0.60× | 9/9 |
| Read 1 KiB string | C++ | 0.49× | 0.45–0.53× | 9/9 |
| Read 1 KiB string | Rust | 0.48× | 0.35–0.49× | 9/9 |
| Table creation | C | 0.93× | 0.91–1.07× | 5/9 |
| Table creation | C++ | 1.02× | 0.80–1.18× | 4/9 |
| Table creation | Rust | 0.99× | 0.93–1.01× | 6/9 |

Across all 84 reported phases and string lengths, the same-page comparison matched or beat 1.13.0 in **77/84** cases. Totals and subphases overlap.

| Slower paired phase | Guest | Metric | Candidate / 1.13.0 | Pages at or below 1× |
| --- | --- | --- | --- | --- |
| canvas-pixels | C | getImageData(): µs/call | 1.068× | 2/9 |
| string-marshalling | C++ | set 16384 B | 1.035× | 3/9 |
| canvas-pixels | C | putImageData(): µs/call | 1.025× | 4/9 |
| canvas-pixels | C++ | getImageData(): µs/call | 1.022× | 4/9 |
| table-update | C++ | create: µs/row | 1.017× | 4/9 |
| table-update | C++ | create: total ms | 1.017× | 4/9 |
| canvas-pixels | Rust | getImageData(): µs/call | 1.003× | 4/9 |

Across all reported phases and string lengths, 81/84 comparable candidate medians were within 10× of the fastest compiled shim and 64/84 matched or beat 1.13.0. Totals and their subphases overlap. Each ratio compares the same phase on both sides.

| Phases above 10× | Phase | Guest | Shim | Candidate / shim |
| --- | --- | --- | --- | --- |
| dom-query | bulk: total ms | C | Embind | 589.62× |
| dom-query | bulk: total ms | C++ | Embind | 501.00× |
| dom-query | bulk: total ms | Rust | Embind | 533.25× |

The bulk DOM query returns a live collection to Embind, which discards it. The component host materializes the collection with `Array.from`, then the bindings lower every element into a WIT resource handle. The ratio includes that difference in work. [Embind loop](cpp/dom-query/emscripten/main.cpp) · [Component host](web/host/web-host.js) · [C guest loop](c/dom-query/main.c)

### DOM bindings with identical guest code

These 216 fresh-page samples compare each language’s exact core Wasm binary with each set of bindings in the table. The direct JS shim calls the same DOM host, puts owned handles in guest memory and recycles them on guest drops. It implements the synchronous imports used by these guests. Jco also provides Canonical ABI checks, task tracking and instance shutdown. [Direct shim](web/bench/dom-core-shim.mjs) · [Raw timings and correctness checks](web/bench/results/dom-control-browser.json)

The bulk query copies 2,000 handles per call, 10 times. Each traversal visits 19,531 nodes. The runner checks the rendered fixture or node count for each guest and verifies list counts and handle release for the direct shim after warm-up and measurement.

With list materialization on both sides, the candidate took **1.03–2.10×** the direct shim’s bulk-query time across the three guests. Times below are per measured workload, after warm-up.

![DOM phase times for Jco 1.13.0 and the candidate relative to the same-guest direct shim](web/bench/results/dom-control-runtime.png)

| Phase | Guest | Direct (ms) | 1.13.0 (ms) | Candidate (ms) | Candidate / direct | Candidate / 1.13.0 | Rounds at or below 1.13.0 | Candidate / previous | Rounds at or below previous |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DOM ID lookup | C | 25.36 | 59.69 | 40.66 | 1.60× | 0.68× | 8/9 | 1.18× | 5/9 |
| DOM ID lookup | C++ | 36.42 | 48.78 | 39.66 | 1.09× | 0.81× | 8/9 | 0.81× | 8/9 |
| DOM ID lookup | Rust | 32.10 | 53.99 | 40.63 | 1.27× | 0.75× | 8/9 | 1.00× | 5/9 |
| Bulk DOM query | C | 11.64 | 26.57 | 23.81 | 2.05× | 0.90× | 6/9 | 1.41× | 2/9 |
| Bulk DOM query | C++ | 16.68 | 19.05 | 17.23 | 1.03× | 0.90× | 4/9 | 0.65× | 9/9 |
| Bulk DOM query | Rust | 12.27 | 18.68 | 25.75 | 2.10× | 1.38× | 5/9 | 1.03× | 5/9 |
| Tree construction | C | 50.69 | 100.68 | 112.02 | 2.21× | 1.11× | 3/9 | 1.04× | 4/9 |
| Tree construction | C++ | 42.18 | 110.88 | 115.06 | 2.73× | 1.04× | 3/9 | 1.37× | 3/9 |
| Tree construction | Rust | 53.54 | 101.97 | 104.74 | 1.96× | 1.03× | 3/9 | 0.97× | 5/9 |
| Tree traversal | C | 13.28 | 23.38 | 32.80 | 2.47× | 1.40× | 1/9 | 1.10× | 2/9 |
| Tree traversal | C++ | 12.66 | 31.09 | 32.52 | 2.57× | 1.05× | 3/9 | 1.25× | 4/9 |
| Tree traversal | Rust | 15.44 | 33.25 | 37.67 | 2.44× | 1.13× | 4/9 | 1.00× | 4/9 |

### Cost of a synchronous host import

The scalar, string and resource loops run 131,072 iterations per pass. The string loop changes the first byte before each call. The resource loop acquires a host object, borrows it to read its value, and drops it. The optional-resource loop checks the discriminant in guest memory every time and reads and drops each present handle. Each pass checks its checksum. All four adapters use byte-identical core modules. The direct shim keeps the fixture’s single live handle in one slot.

The byte-list loop copies a 176 × 176 RGBA region (123,904 bytes) 2,048 times per pass, using a reusable host view and a fixed guest allocation. It sums the changing first byte across transfers and verifies every byte of the final result after each pass. The canvas demo also measures browser readback, host allocation and guest allocation.

The string-return loops make 1,024 calls per pass. Each result occupies 16 KiB in Wasm. One host returns a repeated ASCII string. The other rotates four strings containing two-, three-, and four-byte UTF-8 sequences. The guest checks each byte length, sums the first bytes, and hashes every distinct result outside the timer.

Times are nanoseconds per guest iteration, including the loop and host work. Each cell is the median of 7 fresh-page medians, with 2 warm-ups and 5 timed passes per page. The runner interleaves the four builds. [Raw timings and digests](web/bench/results/import-loop.json)

| Operation | Direct | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Candidate / direct |
| --- | --- | --- | --- | --- | --- | --- |
| u32 | 22.1 | 18.3 | 3,147.9 | 25.2 | 1.37× | 1.14× |
| 2-byte string | 758.4 | 685.1 | 5,039.2 | 241.1 | 0.35× | 0.32× |
| 9-byte string | 705.7 | 669.1 | 4,589.8 | 291.4 | 0.44× | 0.41× |
| 32-byte string | 639.3 | 694.3 | 4,058.8 | 636.3 | 0.92× | 1.00× |
| Acquire, borrow, drop | 75.5 | 424.2 | 8,235.2 | 193.0 | 0.46× | 2.56× |
| Optional resource, half present | 54.2 | 376.9 | 5,595.4 | 230.4 | 0.61× | 4.25× |
| 121 KiB host-to-guest byte list | 9,130.9 | 8,691.4 | 17,334.0 | 10,986.3 | 1.26× | 1.20× |
| 16 KiB UTF-8 result, repeated ASCII | 58,886.7 | 61,035.2 | 84,277.3 | 27,148.4 | 0.44× | 0.46× |
| 16 KiB UTF-8 result, rotating Unicode | 81,543.0 | 76,855.5 | 121,875.0 | 48,046.9 | 0.63× | 0.59× |

### Where the canvas read spends its time

The same-page comparison was repeated with a clock around the demo’s host method. That method reads 176 × 176 pixels from Chromium and creates a JavaScript byte array. The remainder includes guest allocation and freeing, the copy into Wasm, binding checks, the loop and observer overhead. Each cell is a median across 9 page medians. Columns are summarized independently. [Raw instrumented samples](web/bench/results/canvas-control-browser.json)

| Guest | Bindings | Full read (µs) | Inside host (µs) | Remainder (µs) | Inside host (%) |
| --- | --- | --- | --- | --- | --- |
| C | 1.13.0 | 744.7 | 710.2 | 34.2 | 95.0% |
| C | Candidate | 780.6 | 732.2 | 47.3 | 94.1% |
| C++ | 1.13.0 | 812.3 | 766.4 | 47.3 | 94.6% |
| C++ | Candidate | 810.9 | 752.5 | 57.0 | 93.3% |
| Rust | 1.13.0 | 793.9 | 740.3 | 47.7 | 94.0% |
| Rust | Candidate | 803.8 | 750.0 | 52.5 | 93.5% |

The host accounted for 93.3–95.0% of the full read across these builds. The candidate spent 47.3–57.0 µs per read outside the host, compared with 34.2–47.7 µs for 1.13.0.

<details><summary>All timed phases and string lengths</summary>

| Demo | Phase | Guest | Candidate time | Fresh-page / 1.13.0 | Same-page / 1.13.0 | Candidate / main | Fastest shim | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| attribute-churn | total time | C | 114.67 ms | 0.55× | 0.52× | 0.18× | Embind | 0.81× |
| attribute-churn | total time | C++ | 100.17 ms | 0.44× | 0.49× | 0.14× | Embind | 0.70× |
| attribute-churn | total time | Rust | 167.37 ms | 0.82× | 0.54× | 0.27× | Embind | 1.18× |
| attribute-churn | per setAttribute() | C | 1.43 µs | 0.55× | 0.52× | 0.18× | Embind | 0.81× |
| attribute-churn | per setAttribute() | C++ | 1.25 µs | 0.44× | 0.49× | 0.14× | Embind | 0.70× |
| attribute-churn | per setAttribute() | Rust | 2.09 µs | 0.82× | 0.54× | 0.27× | Embind | 1.18× |
| canvas-draw | total | C | 116.21 ms | 1.14× | 0.86× | 0.28× | Embind | 0.81× |
| canvas-draw | total | C++ | 105.60 ms | 0.83× | 0.89× | 0.24× | Embind | 0.74× |
| canvas-draw | total | Rust | 111.73 ms | 1.37× | 0.95× | 0.25× | Embind | 0.78× |
| canvas-draw | per fill_rect() | C | 2.32 µs | 1.14× | 0.86× | 0.28× | Embind | 0.81× |
| canvas-draw | per fill_rect() | C++ | 2.11 µs | 0.83× | 0.89× | 0.24× | Embind | 0.74× |
| canvas-draw | per fill_rect() | Rust | 2.23 µs | 1.37× | 0.95× | 0.25× | Embind | 0.78× |
| canvas-pixels | getImageData(): µs/call | C | 739.10 µs | 0.88× | 1.07× | 0.90× | Embind | 1.60× |
| canvas-pixels | getImageData(): µs/call | C++ | 788.40 µs | 0.99× | 1.02× | 0.92× | Embind | 1.71× |
| canvas-pixels | getImageData(): µs/call | Rust | 822.50 µs | 0.96× | 1.00× | 0.98× | Embind | 1.78× |
| canvas-pixels | putImageData(): µs/call | C | 547.30 µs | 0.92× | 1.03× | 0.85× | Embind | 1.40× |
| canvas-pixels | putImageData(): µs/call | C++ | 434.80 µs | 0.81× | 0.98× | 0.69× | Embind | 1.11× |
| canvas-pixels | putImageData(): µs/call | Rust | 590.20 µs | 1.02× | 0.99× | 0.97× | Embind | 1.51× |
| dom-query | individual: total ms | C | 38.16 ms | 0.72× | 0.65× | 0.18× | Embind | 0.84× |
| dom-query | individual: total ms | C++ | 45.11 ms | 0.76× | 0.63× | 0.25× | Embind | 1.00× |
| dom-query | individual: total ms | Rust | 31.20 ms | 0.64× | 0.63× | 0.14× | Embind | 0.69× |
| dom-query | bulk: total ms | C | 23.59 ms | 1.22× | 0.74× | 0.68× | Embind | 589.62× |
| dom-query | bulk: total ms | C++ | 20.04 ms | 0.80× | 0.75× | 0.51× | Embind | 501.00× |
| dom-query | bulk: total ms | Rust | 21.33 ms | 0.95× | 0.72× | 0.73× | Embind | 533.25× |
| dom-query | individual: µs/element | C | 1.91 µs | 0.72× | 0.65× | 0.18× | Embind | 0.84× |
| dom-query | individual: µs/element | C++ | 2.26 µs | 0.76× | 0.63× | 0.25× | Embind | 1.00× |
| dom-query | individual: µs/element | Rust | 1.56 µs | 0.64× | 0.63× | 0.14× | Embind | 0.69× |
| dom-traversal | build | C | 106.12 ms | 1.02× | 0.79× | 0.27× | EM_JS | 3.29× |
| dom-traversal | build | C++ | 90.35 ms | 0.88× | 0.77× | 0.22× | EM_JS | 2.80× |
| dom-traversal | build | Rust | 89.41 ms | 0.88× | 0.83× | 0.20× | EM_JS | 2.77× |
| dom-traversal | traverse (total) | C | 30.63 ms | 1.05× | 0.81× | 0.18× | EM_JS | 5.07× |
| dom-traversal | traverse (total) | C++ | 26.12 ms | 0.87× | 0.76× | 0.16× | EM_JS | 4.32× |
| dom-traversal | traverse (total) | Rust | 36.88 ms | 1.18× | 0.70× | 0.20× | EM_JS | 6.11× |
| dom-traversal | traverse (per node) | C | 1.57 µs | 1.05× | 0.81× | 0.18× | EM_JS | 5.06× |
| dom-traversal | traverse (per node) | C++ | 1.34 µs | 0.86× | 0.76× | 0.16× | EM_JS | 4.31× |
| dom-traversal | traverse (per node) | Rust | 1.89 µs | 1.18× | 0.70× | 0.20× | EM_JS | 6.09× |
| string-marshalling | set 8 B | C | 0.91 µs | 0.75× | 0.71× | 0.12× | EM_JS | 1.74× |
| string-marshalling | set 8 B | C++ | 0.69 µs | 0.51× | 0.67× | 0.08× | EM_JS | 1.33× |
| string-marshalling | set 8 B | Rust | 0.86 µs | 0.59× | 0.69× | 0.17× | EM_JS | 1.65× |
| string-marshalling | get 8 B | C | 1.37 µs | 0.42× | 0.30× | 0.18× | EM_JS | 4.15× |
| string-marshalling | get 8 B | C++ | 1.26 µs | 0.28× | 0.30× | 0.15× | EM_JS | 3.82× |
| string-marshalling | get 8 B | Rust | 1.16 µs | 0.33× | 0.31× | 0.15× | EM_JS | 3.53× |
| string-marshalling | set 128 B | C | 1.17 µs | 0.74× | 0.84× | 0.16× | wasm-bindgen | 1.33× |
| string-marshalling | set 128 B | C++ | 0.95 µs | 0.59× | 0.85× | 0.13× | wasm-bindgen | 1.07× |
| string-marshalling | set 128 B | Rust | 1.41 µs | 0.83× | 0.91× | 0.27× | wasm-bindgen | 1.60× |
| string-marshalling | get 128 B | C | 3.47 µs | 0.88× | 0.83× | 0.29× | wasm-bindgen | 2.74× |
| string-marshalling | get 128 B | C++ | 3.44 µs | 0.71× | 0.74× | 0.27× | wasm-bindgen | 2.71× |
| string-marshalling | get 128 B | Rust | 3.94 µs | 1.04× | 0.79× | 0.37× | wasm-bindgen | 3.11× |
| string-marshalling | set 1024 B | C | 1.61 µs | 1.00× | 0.93× | 0.18× | wasm-bindgen | 1.19× |
| string-marshalling | set 1024 B | C++ | 1.57 µs | 0.67× | 0.88× | 0.23× | wasm-bindgen | 1.16× |
| string-marshalling | set 1024 B | Rust | 2.11 µs | 1.12× | 0.86× | 0.29× | wasm-bindgen | 1.57× |
| string-marshalling | get 1024 B | C | 3.96 µs | 0.60× | 0.44× | 0.22× | wasm-bindgen | 0.45× |
| string-marshalling | get 1024 B | C++ | 3.07 µs | 0.33× | 0.49× | 0.23× | wasm-bindgen | 0.35× |
| string-marshalling | get 1024 B | Rust | 3.20 µs | 0.47× | 0.48× | 0.29× | wasm-bindgen | 0.37× |
| string-marshalling | set 16384 B | C | 10.61 µs | 0.99× | 0.99× | 0.50× | wasm-bindgen | 1.04× |
| string-marshalling | set 16384 B | C++ | 10.27 µs | 0.95× | 1.04× | 0.67× | wasm-bindgen | 1.01× |
| string-marshalling | set 16384 B | Rust | 11.76 µs | 1.11× | 0.99× | 0.79× | wasm-bindgen | 1.16× |
| string-marshalling | get 16384 B | C | 26.26 µs | 0.46× | 0.50× | 0.27× | wasm-bindgen | 0.22× |
| string-marshalling | get 16384 B | C++ | 27.94 µs | 0.47× | 0.51× | 0.32× | wasm-bindgen | 0.23× |
| string-marshalling | get 16384 B | Rust | 27.31 µs | 0.49× | 0.52× | 0.31× | wasm-bindgen | 0.22× |
| string-marshalling | set 262144 B | C | 155.45 µs | 0.34× | 0.95× | 0.37× | Embind | 0.85× |
| string-marshalling | set 262144 B | C++ | 155.10 µs | 0.39× | 0.98× | 0.38× | Embind | 0.85× |
| string-marshalling | set 262144 B | Rust | 161.70 µs | 0.39× | 0.96× | 0.36× | Embind | 0.89× |
| string-marshalling | get 262144 B | C | 430.70 µs | 0.24× | 0.27× | 0.36× | wasm-bindgen | 0.21× |
| string-marshalling | get 262144 B | C++ | 429.85 µs | 0.28× | 0.29× | 0.35× | wasm-bindgen | 0.21× |
| string-marshalling | get 262144 B | Rust | 401.25 µs | 0.26× | 0.27× | 0.33× | wasm-bindgen | 0.19× |
| table-update | create: total ms | C | 20.51 ms | 0.86× | 0.93× | 0.18× | EM_JS | 2.13× |
| table-update | create: total ms | C++ | 23.01 ms | 0.84× | 1.02× | 0.21× | EM_JS | 2.39× |
| table-update | create: total ms | Rust | 24.40 ms | 1.16× | 0.99× | 0.21× | EM_JS | 2.54× |
| table-update | create: µs/row | C | 10.26 µs | 0.86× | 0.93× | 0.18× | EM_JS | 2.13× |
| table-update | create: µs/row | C++ | 11.51 µs | 0.84× | 1.02× | 0.21× | EM_JS | 2.39× |
| table-update | create: µs/row | Rust | 12.20 µs | 1.16× | 0.99× | 0.21× | EM_JS | 2.54× |
| table-update | update (selected): total ms | C | 1.69 ms | 0.94× | 0.82× | 0.31× | wasm-bindgen | 1.28× |
| table-update | update (selected): total ms | C++ | 1.58 ms | 0.96× | 0.84× | 0.29× | wasm-bindgen | 1.20× |
| table-update | update (selected): total ms | Rust | 2.23 ms | 1.36× | 0.95× | 0.44× | wasm-bindgen | 1.69× |
| table-update | update (selected): µs/row | C | 0.84 µs | 0.94× | 0.82× | 0.31× | wasm-bindgen | 1.28× |
| table-update | update (selected): µs/row | C++ | 0.79 µs | 0.96× | 0.84× | 0.29× | wasm-bindgen | 1.20× |
| table-update | update (selected): µs/row | Rust | 1.11 µs | 1.36× | 0.95× | 0.44× | wasm-bindgen | 1.69× |
| table-update | clear (unselected): total ms | C | 5.87 ms | 0.85× | 0.80× | 0.24× | wasm-bindgen | 1.86× |
| table-update | clear (unselected): total ms | C++ | 5.12 ms | 0.66× | 0.80× | 0.17× | wasm-bindgen | 1.62× |
| table-update | clear (unselected): total ms | Rust | 6.89 ms | 1.12× | 0.81× | 0.28× | wasm-bindgen | 2.19× |
| table-update | clear (unselected): µs/row | C | 2.93 µs | 0.85× | 0.80× | 0.24× | wasm-bindgen | 1.86× |
| table-update | clear (unselected): µs/row | C++ | 2.56 µs | 0.66× | 0.80× | 0.17× | wasm-bindgen | 1.62× |
| table-update | clear (unselected): µs/row | Rust | 3.45 µs | 1.12× | 0.81× | 0.28× | wasm-bindgen | 2.19× |

</details>

### Payload and startup

Payload medians cover 34 component inputs. Compression is per file. Startup is the median of the 21 per-workload and guest medians, from dynamic import through initialization, with browser caching disabled.

| Build | JS (KiB) | Core Wasm (KiB) | Total (KiB) | Gzip (KiB) | Brotli (KiB) | Startup (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 | 19.4 | 64.4 | 85.4 | 29.3 | 24.1 | 20.00 |
| Stock main | 180.7 | 64.4 | 252.0 | 57.6 | 47.8 | 46.88 |
| Candidate | 149.6 | 64.4 | 217.4 | 53.6 | 44.5 | 41.06 |

### Generated JavaScript reached by each demo

Chromium recorded block coverage on 126 fresh pages in a separate run. One page imported each module and finished initialization. A second also ran the demo once and checked its output. The table reports medians over the 21 guest and workload combinations. Sizes count UTF-8 bytes in V8’s covered source ranges. A demo can leave error handling, shutdown or other supported operations unexercised. [Per-module coverage and hashes](web/bench/results/js-coverage.json)

| Build | Reached at init (KiB) | Reached through first run (KiB) | Share through first run | Unreached through first run (KiB) |
| --- | --- | --- | --- | --- |
| 1.13.0 | 4.8 | 16.3 | 76.6% | 5.0 |
| Stock main | 53.9 | 96.3 | 51.2% | 91.2 |
| Candidate | 42.6 | 67.5 | 44.1% | 85.0 |

<details><summary>Candidate startup, variation and paired comparison to 1.13.0</summary>

The paired ratio divides the candidate time by the 1.13.0 time within each round, then takes the median. The final column counts rounds where the candidate was at least as fast.

| Operation | Guest | Startup median (ms) | Warm phase p25 | Warm phase p50 | Warm phase p75 | Phase unit | Paired ratio to 1.13.0 | Rounds at or below 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | 40.27 | 1.01 | 1.43 | 1.46 | µs | 0.49× | 7/7 |
| Attribute write | C++ | 41.38 | 1.07 | 1.25 | 1.48 | µs | 0.50× | 7/7 |
| Attribute write | Rust | 44.24 | 1.67 | 2.09 | 2.17 | µs | 0.68× | 7/7 |
| Canvas fillRect | C | 43.09 | 1.87 | 2.32 | 2.35 | µs | 0.88× | 5/7 |
| Canvas fillRect | C++ | 49.27 | 1.81 | 2.11 | 2.30 | µs | 0.77× | 6/7 |
| Canvas fillRect | Rust | 41.06 | 2.10 | 2.23 | 2.28 | µs | 1.37× | 2/7 |
| Canvas pixel read | C | 49.41 | 536.25 | 739.10 | 823.60 | µs | 0.91× | 6/7 |
| Canvas pixel read | C++ | 43.37 | 604.40 | 788.40 | 831.40 | µs | 0.89× | 4/7 |
| Canvas pixel read | Rust | 47.88 | 788.60 | 822.50 | 832.95 | µs | 1.01× | 3/7 |
| DOM ID lookup | C | 45.38 | 1.86 | 1.91 | 2.07 | µs | 0.77× | 7/7 |
| DOM ID lookup | C++ | 44.13 | 2.03 | 2.26 | 2.37 | µs | 0.83× | 6/7 |
| DOM ID lookup | Rust | 41.05 | 1.48 | 1.56 | 2.03 | µs | 0.70× | 5/7 |
| Tree traversal | C | 43.70 | 27.72 | 30.63 | 32.66 | ms | 1.17× | 2/7 |
| Tree traversal | C++ | 35.52 | 23.96 | 26.12 | 27.38 | ms | 0.83× | 4/7 |
| Tree traversal | Rust | 38.94 | 29.46 | 36.88 | 41.18 | ms | 1.19× | 2/7 |
| Read 1 KiB string | C | 39.86 | 3.08 | 3.96 | 4.97 | µs | 0.53× | 7/7 |
| Read 1 KiB string | C++ | 37.00 | 2.75 | 3.07 | 4.39 | µs | 0.38× | 7/7 |
| Read 1 KiB string | Rust | 40.24 | 2.85 | 3.20 | 4.81 | µs | 0.45× | 7/7 |
| Table creation | C | 35.05 | 19.78 | 20.51 | 21.91 | ms | 0.86× | 6/7 |
| Table creation | C++ | 38.88 | 19.56 | 23.01 | 24.61 | ms | 0.91× | 5/7 |
| Table creation | Rust | 40.74 | 19.96 | 24.40 | 31.49 | ms | 0.99× | 4/7 |

</details>

[Raw browser timings](web/bench/results/candidate-browser.json) · [File sizes, digests and generator revision](web/bench/results/candidate-sizes.json)

### Reproduce the candidate run

Run the dependency installation, main setup and size commands in [Reproduce the comparison](#reproduce-the-comparison), then run the following from the repository root. Cargo uses the Jco checkout’s pinned toolchain and lockfile.

```sh
git clone https://github.com/vados-cosmonic/jco ../jco-candidate
git -C ../jco-candidate checkout 3f65947fd57caf61bd5ad2fba06f3fd00734049c
node web/bench/candidate.mjs ../jco-candidate
git -C ../jco-candidate worktree add --detach ../jco-reference 241dcf8cb4dda2c981a12ef9bfbcdd75f8bddf08
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

<!-- candidate:end -->

<!-- benchmark:start -->

## Browser performance

**jco 1.13.0 vs. main at `16f8fe48`** · 2026-11-25 · HeadlessChrome/156.0.8078.47 · Intel(R) Xeon(R) Processor @ 2.60GHz · linux 6.12.111 x64 · Node v26.13.0. [Upstream commit](https://github.com/bytecodealliance/jco/commit/16f8fe4805367bb5591f2fc23e7fbe42de61cff5) · [Transpiler build](https://github.com/bytecodealliance/jco/actions/runs/45650406951)

These stock and shim timings come from the same interleaved fresh-page trial as the performance branch. [Full trial](web/bench/results/candidate-browser.json) · [Stock and shim samples](web/bench/results/browser.json)

Across the seven operations below and three guest languages, main took longer in **19 of 21** median comparisons. The highest ratio was **5.79×** for the C guest in `dom-traversal`.

For 256 KiB string reads, the median time on main changed by -33% to -20% across the three guest languages. The phase tables below include every tested string size.

Each cell is the median of 7 fresh-page samples. The chart divides main’s median time by 1.13.0’s for the same guest and operation. A value below 1× means main finished faster.

![Median time on main divided by baseline time for seven operations and three guest languages](web/bench/results/runtime.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 0.61 | 1.78 | — | — | 2.60 | 8.02 | 2.87 | 9.06 | 2.56 | 7.71 |
| Canvas fillRect (µs) | 1.77 | 2.85 | — | — | 2.04 | 8.30 | 2.56 | 8.95 | 1.63 | 8.89 |
| Canvas pixel read (µs) | 428.30 | 461.90 | — | — | 838.40 | 819.70 | 800.00 | 857.20 | 855.60 | 837.50 |
| DOM ID lookup (µs) | 0.596 | 2.26 | — | — | 2.65 | 10.51 | 2.97 | 8.89 | 2.44 | 11.17 |
| Tree traversal (ms) | 1.73 | 42.46 | 6.04 | 11.06 | 29.24 | 169.40 | 30.19 | 161.75 | 31.28 | 180.81 |
| Read 1 KiB string (µs) | 0.161 | 19.19 | 14.64 | 8.71 | 6.56 | 17.87 | 9.32 | 13.53 | 6.75 | 10.96 |
| Table creation (ms) | 5.10 | 26.09 | 9.62 | 16.55 | 23.87 | 117.15 | 27.52 | 110.56 | 21.01 | 117.01 |

Embind and EM_JS are the C++ Emscripten variants. An em dash marks an unavailable combination. Across toolchains, the upstream implementations can do different amounts of work. For example, the JavaScript bulk DOM query obtains a live collection while the component host materializes a list.

<details><summary>Run-to-run variation for the two jco versions</summary>

Each cell spans the 25th to 75th percentile of measured times, using linear interpolation between sorted samples.

| Operation | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 2.13–2.78 | 7.06–10.27 | 2.69–2.96 | 6.56–9.29 | 2.49–3.16 | 7.30–9.93 |
| Canvas fillRect (µs) | 1.76–2.73 | 7.98–8.85 | 2.39–2.63 | 7.05–9.88 | 1.61–2.20 | 8.50–9.33 |
| Canvas pixel read (µs) | 827.95–855.00 | 728.15–872.95 | 703.40–822.50 | 809.70–925.15 | 625.60–936.10 | 827.65–845.60 |
| DOM ID lookup (µs) | 2.09–2.98 | 9.12–12.64 | 2.45–2.99 | 8.43–12.50 | 2.04–2.77 | 9.41–12.27 |
| Tree traversal (ms) | 25.32–30.74 | 156.59–196.28 | 18.74–33.30 | 153.98–183.00 | 31.01–33.97 | 172.97–243.78 |
| Read 1 KiB string (µs) | 6.33–9.49 | 13.83–19.42 | 7.98–10.39 | 13.17–15.95 | 6.19–8.18 | 10.58–12.90 |
| Table creation (ms) | 21.80–31.16 | 106.22–144.11 | 22.98–30.17 | 100.05–137.88 | 19.82–22.00 | 100.66–149.69 |

</details>

<details><summary>All workload phases, per-call timings, and string transfer rates</summary>

Times come from the tables rendered by the demos and retain their original reporting precision. Effective string throughput uses the ASCII payload length divided by median call time (decimal MB/s).

**attribute-churn**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total time (ms) | 48.83 | 142.31 | — | — | 207.62 | 641.61 | 229.51 | 724.77 | 205.24 | 616.59 |
| per setAttribute() (µs) | 0.61 | 1.78 | — | — | 2.60 | 8.02 | 2.87 | 9.06 | 2.56 | 7.71 |

**canvas-draw**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total (ms) | 88.69 | 142.74 | — | — | 101.94 | 415.07 | 127.84 | 447.32 | 81.42 | 444.64 |
| per fill_rect() (µs) | 1.77 | 2.85 | — | — | 2.04 | 8.30 | 2.56 | 8.95 | 1.63 | 8.89 |

**canvas-pixels**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| getImageData() (µs) | 428.30 | 461.90 | — | — | 838.40 | 819.70 | 800.00 | 857.20 | 855.60 | 837.50 |
| putImageData() (µs) | 29.40 | 391.40 | — | — | 594.80 | 643.10 | 537.20 | 634.10 | 579.40 | 607.80 |

**dom-query**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| individual, total (ms) | 11.92 | 45.27 | — | — | 53.04 | 210.09 | 59.48 | 177.86 | 48.77 | 223.41 |
| bulk, total (ms) | 0.02 | 0.04 | — | — | 19.28 | 34.91 | 25.18 | 39.13 | 22.56 | 29.29 |
| individual: µs/element (µs) | 0.596 | 2.26 | — | — | 2.65 | 10.51 | 2.97 | 8.89 | 2.44 | 11.17 |

**dom-traversal**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| build (ms) | 22.77 | 58.19 | 32.24 | 45.27 | 104.40 | 386.13 | 102.75 | 415.88 | 101.86 | 442.84 |
| traverse (total) (ms) | 1.73 | 42.46 | 6.04 | 11.06 | 29.24 | 169.40 | 30.19 | 161.75 | 31.28 | 180.81 |
| traverse (per node) (µs) | 0.088 | 2.17 | 0.31 | 0.567 | 1.50 | 8.67 | 1.55 | 8.28 | 1.60 | 9.26 |

**string-marshalling**

![Median DOM textContent set and get latency by payload length for each guest and jco version, on logarithmic axes](web/bench/results/strings.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| set 8 B (µs) | 0.285 | 1.40 | 0.521 | 1.15 | 1.20 | 7.83 | 1.36 | 8.91 | 1.46 | 5.09 |
| set 8 B (MB/s) | 28.07 | 5.72 | 15.36 | 6.96 | 6.66 | 1.02 | 5.87 | 0.897 | 5.49 | 1.57 |
| get 8 B (µs) | 0.12 | 2.22 | 0.33 | 0.343 | 3.29 | 7.59 | 4.43 | 8.46 | 3.53 | 7.69 |
| get 8 B (MB/s) | 66.67 | 3.61 | 24.24 | 23.32 | 2.43 | 1.05 | 1.81 | 0.945 | 2.27 | 1.04 |
| set 128 B (µs) | 0.424 | 1.67 | 1.48 | 0.88 | 1.58 | 7.24 | 1.59 | 7.05 | 1.69 | 5.25 |
| set 128 B (MB/s) | 301.89 | 76.60 | 86.49 | 145.45 | 81.06 | 17.67 | 80.25 | 18.16 | 75.65 | 24.39 |
| get 128 B (µs) | 0.154 | 3.64 | 2.46 | 1.27 | 3.96 | 11.85 | 4.85 | 12.71 | 3.80 | 10.68 |
| get 128 B (MB/s) | 831.17 | 35.17 | 52.05 | 101.03 | 32.29 | 10.80 | 26.37 | 10.07 | 33.71 | 11.98 |
| set 1024 B (µs) | 1.74 | 2.62 | 4.37 | 1.35 | 1.61 | 8.84 | 2.33 | 6.93 | 1.89 | 7.33 |
| set 1024 B (MB/s) | 589.86 | 390.84 | 234.54 | 759.64 | 635.63 | 115.82 | 440.24 | 147.76 | 543.24 | 139.74 |
| get 1024 B (µs) | 0.161 | 19.19 | 14.64 | 8.71 | 6.56 | 17.87 | 9.32 | 13.53 | 6.75 | 10.96 |
| get 1024 B (MB/s) | 6,360.25 | 53.35 | 69.93 | 117.62 | 156.03 | 57.31 | 109.85 | 75.68 | 151.82 | 93.41 |
| set 16384 B (µs) | 21.19 | 13.54 | 51.40 | 10.18 | 10.76 | 21.02 | 10.80 | 15.36 | 10.56 | 14.94 |
| set 16384 B (MB/s) | 773.30 | 1,209.69 | 318.75 | 1,610.22 | 1,522.39 | 779.26 | 1,517.46 | 1,066.53 | 1,551.66 | 1,096.36 |
| get 16384 B (µs) | 0.727 | 292.35 | 248.05 | 121.65 | 57.42 | 98.67 | 59.85 | 87.22 | 55.19 | 87.25 |
| get 16384 B (MB/s) | 22,536.45 | 56.04 | 66.05 | 134.68 | 285.31 | 166.04 | 273.75 | 187.84 | 296.88 | 187.78 |
| set 262144 B (µs) | 272.81 | 182.30 | 773.25 | 382.75 | 461.20 | 419.40 | 396.55 | 408.65 | 417.95 | 455.35 |
| set 262144 B (MB/s) | 960.90 | 1,437.98 | 339.02 | 684.90 | 568.40 | 625.05 | 661.06 | 641.49 | 627.21 | 575.70 |
| get 262144 B (µs) | 19.84 | 4,158.10 | 3,773.40 | 2,085.90 | 1,793.10 | 1,204.65 | 1,553.95 | 1,235.85 | 1,534.25 | 1,216.85 |
| get 262144 B (MB/s) | 13,210.24 | 63.04 | 69.47 | 125.67 | 146.20 | 217.61 | 168.70 | 212.12 | 170.86 | 215.43 |

**table-update**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create, total (ms) | 5.10 | 26.09 | 9.62 | 16.55 | 23.87 | 117.15 | 27.52 | 110.56 | 21.01 | 117.01 |
| create, per row (µs) | 2.55 | 13.04 | 4.81 | 8.28 | 11.94 | 58.58 | 13.76 | 55.28 | 10.51 | 58.51 |
| update (selected), total (ms) | 0.725 | 1.90 | 1.65 | 1.32 | 1.80 | 5.43 | 1.65 | 5.50 | 1.64 | 5.03 |
| update (selected), per row (µs) | 0.362 | 0.947 | 0.822 | 0.66 | 0.9 | 2.72 | 0.822 | 2.75 | 0.818 | 2.51 |
| clear (unselected), total (ms) | 2.03 | 7.20 | 6.50 | 3.15 | 6.87 | 24.24 | 7.75 | 29.57 | 6.16 | 24.39 |
| clear (unselected), per row (µs) | 1.01 | 3.60 | 3.25 | 1.58 | 3.44 | 12.12 | 3.88 | 14.78 | 3.08 | 12.20 |

</details>

<details><summary>Module load and initialization, median milliseconds</summary>

Elapsed browser time for dynamic import through instantiation, with the shared demo host already loaded. The browser process is reused, each page has HTTP caching disabled, and assets are served uncompressed over loopback. These timings include scheduling and local requests. JS is already loaded by the harness.

| Workload | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| attribute-churn | 25.38 | — | — | 20.68 | 48.69 | 19.56 | 50.75 | 22.12 | 47.71 |
| canvas-draw | 24.23 | — | — | 23.05 | 50.22 | 22.56 | 51.65 | 18.18 | 46.88 |
| canvas-pixels | 30.66 | — | — | 25.24 | 55.57 | 22.71 | 57.87 | 25.95 | 53.95 |
| dom-query | 24.42 | — | — | 17.66 | 45.71 | 20.00 | 46.81 | 23.01 | 45.80 |
| dom-traversal | 26.64 | 17.71 | 15.14 | 20.54 | 47.40 | 20.77 | 45.02 | 17.86 | 51.01 |
| string-marshalling | 26.69 | 16.34 | 15.62 | 19.40 | 44.31 | 19.63 | 42.57 | 16.54 | 37.26 |
| table-update | 23.43 | 14.62 | 15.43 | 17.65 | 40.14 | 16.77 | 41.96 | 18.06 | 44.88 |

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

Across 34 component inputs, the median change in gzip payload on main was **+27.2 KiB** per component (range +19.7 to +30.3 KiB). The payload sums the emitted JavaScript and external core Wasm files, including any Wasm inlined into JavaScript. Gzip level 9 and Brotli quality 11 are applied per file. Shared host code, HTML, type declarations and HTTP headers are excluded. The raw JavaScript reference lives in the demo page controller.

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
| C attribute-churn | 65.1 | 2 / 2 | 19.0 / 174.7 | 61.4 / 61.4 | 80.5 / 236.1 | 28.4 / 55.4 | 23.3 / 45.9 |
| C calculator | 0.9 | 1 / 1 | 2.3 / 98.5 | 0.0 / 0.0 | 2.3 / 98.5 | 1.3 / 21.0 | 1.2 / 18.1 |
| C canvas-draw | 66.5 | 2 / 2 | 22.6 / 189.1 | 61.9 / 61.9 | 84.6 / 251.0 | 28.6 / 56.1 | 23.6 / 46.4 |
| C canvas-pixels | 70.1 | 2 / 2 | 24.2 / 207.6 | 64.7 / 64.7 | 88.9 / 272.3 | 29.7 / 60.1 | 24.5 / 49.7 |
| C dom-query | 68.0 | 2 / 2 | 22.0 / 190.9 | 63.7 / 63.7 | 85.6 / 254.6 | 29.2 / 57.9 | 24.0 / 47.9 |
| C dom-traversal | 66.0 | 2 / 2 | 21.1 / 182.1 | 62.0 / 62.0 | 83.1 / 244.1 | 28.5 / 55.6 | 23.4 / 46.0 |
| C greet-bindgen | 56.3 | 2 / 2 | 2.6 / 106.0 | 55.9 / 55.9 | 58.5 / 161.9 | 24.3 / 45.8 | 20.0 / 38.4 |
| C greet-freestanding | 0.9 | 1 / 1 | 3.0 / 103.0 | 0.0 / 0.0 | 3.0 / 103.0 | 1.6 / 22.7 | 1.5 / 19.4 |
| C greet-libc | 54.9 | 2 / 2 | 2.6 / 106.0 | 54.5 / 54.5 | 57.1 / 160.5 | 23.8 / 45.3 | 19.5 / 38.0 |
| C hello-world | 60.4 | 2 / 2 | 13.8 / 161.0 | 57.8 / 57.8 | 71.6 / 218.8 | 26.7 / 54.0 | 22.0 / 45.0 |
| C string-marshalling | 66.2 | 2 / 2 | 19.4 / 181.7 | 62.6 / 62.6 | 82.0 / 244.3 | 28.9 / 57.3 | 23.9 / 47.7 |
| C table-update | 70.7 | 2 / 2 | 21.2 / 189.1 | 66.6 / 66.6 | 87.8 / 255.8 | 29.3 / 58.0 | 24.2 / 48.1 |
| C++ attribute-churn | 68.9 | 2 / 2 | 19.0 / 174.7 | 65.3 / 65.3 | 84.3 / 240.0 | 29.7 / 56.6 | 24.4 / 47.0 |
| C++ canvas-draw | 68.5 | 2 / 2 | 22.6 / 189.1 | 63.9 / 63.9 | 86.6 / 253.0 | 29.1 / 56.5 | 24.0 / 46.8 |
| C++ canvas-pixels | 73.1 | 2 / 2 | 24.2 / 207.6 | 67.8 / 67.8 | 91.9 / 275.3 | 30.6 / 60.9 | 25.1 / 50.3 |
| C++ dom-query | 71.7 | 2 / 2 | 22.0 / 190.9 | 67.4 / 67.4 | 89.4 / 258.3 | 30.7 / 59.4 | 25.1 / 49.1 |
| C++ dom-traversal | 68.0 | 2 / 2 | 21.1 / 182.1 | 64.0 / 64.0 | 85.1 / 246.1 | 29.0 / 56.1 | 23.8 / 46.5 |
| C++ hello-world | 60.4 | 2 / 2 | 13.8 / 161.0 | 57.8 / 57.8 | 71.6 / 218.7 | 26.6 / 53.9 | 21.9 / 44.9 |
| C++ string-marshalling | 68.3 | 2 / 2 | 19.4 / 181.7 | 64.8 / 64.8 | 84.1 / 246.4 | 29.5 / 57.9 | 24.3 / 48.0 |
| C++ table-update | 74.9 | 2 / 2 | 21.2 / 189.1 | 70.9 / 70.9 | 92.1 / 260.0 | 31.2 / 59.7 | 25.4 / 49.2 |
| Rust attribute-churn | 152.0 | 2 / 2 | 18.8 / 173.3 | 148.5 / 148.5 | 167.3 / 321.8 | 55.8 / 82.6 | 45.9 / 68.2 |
| Rust calculator-raw | 258.7 | 2 / 2 | 1.4 / 98.1 | 258.4 / 258.4 | 259.8 / 356.5 | 85.4 / 105.1 | 72.3 / 89.2 |
| Rust calculator | 258.0 | 2 / 2 | 1.4 / 98.1 | 257.7 / 257.7 | 259.1 / 355.8 | 85.1 / 104.9 | 72.1 / 89.0 |
| Rust canvas-draw | 140.9 | 2 / 2 | 22.4 / 187.7 | 136.4 / 136.4 | 158.8 / 324.1 | 53.0 / 80.3 | 43.8 / 66.5 |
| Rust canvas-pixels | 142.9 | 2 / 2 | 24.0 / 206.2 | 137.7 / 137.7 | 161.6 / 343.8 | 53.7 / 83.8 | 44.2 / 69.2 |
| Rust dom-query | 148.8 | 2 / 2 | 21.7 / 189.5 | 144.7 / 144.7 | 166.4 / 334.2 | 55.9 / 84.5 | 46.0 / 69.8 |
| Rust dom-traversal (dom_traversal.my.component) | 138.7 | 2 / 2 | 20.2 / 180.7 | 135.7 / 135.7 | 155.9 / 316.4 | 52.7 / 79.7 | 43.5 / 66.2 |
| Rust dom-traversal | 138.7 | 2 / 2 | 20.2 / 180.7 | 135.7 / 135.7 | 155.9 / 316.4 | 52.7 / 79.7 | 43.5 / 66.1 |
| Rust hello-world | 17.4 | 2 / 2 | 13.6 / 159.6 | 14.9 / 14.9 | 28.5 / 174.5 | 8.9 / 35.9 | 7.4 / 30.3 |
| Rust string-marshalling | 146.9 | 2 / 2 | 19.1 / 180.3 | 143.4 / 143.4 | 162.5 / 323.7 | 55.2 / 83.4 | 45.6 / 69.3 |
| Rust table-rows | 33.3 | 2 / 2 | 13.1 / 157.0 | 31.1 / 31.1 | 44.2 / 188.1 | 16.2 / 42.5 | 14.0 / 36.2 |
| Rust table-update | 149.5 | 2 / 2 | 20.6 / 188.3 | 146.2 / 146.2 | 166.8 / 334.5 | 56.1 / 84.7 | 46.3 / 70.2 |
| Rust todomvc | 14.4 | 2 / 2 | 15.3 / 161.5 | 11.6 / 11.6 | 26.8 / 173.1 | 7.6 / 34.0 | 6.5 / 28.7 |
| Rust vdom-diff | 40.9 | 2 / 2 | 14.8 / 161.4 | 38.5 / 38.5 | 53.3 / 199.9 | 19.7 / 46.1 | 17.0 / 39.3 |

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
