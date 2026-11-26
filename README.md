# Component demos

This fork benchmarks the browser examples from [eqrion/component-demos at d0b9dd1](https://github.com/eqrion/component-demos/tree/d0b9dd1390a300978193adc623838fef4e4b632b). It runs the same compiled C, C++, and Rust WebAssembly components through jco 1.13.0, pinned upstream main, and a branch that optimizes synchronous host imports. The comparison also includes the demos’ JavaScript, Emscripten (Embind and EM_JS), and Rust wasm-bindgen implementations where available.

The performance branch also specializes UTF-8 conversion in both directions. For strings of up to 32 ASCII bytes, the bindings read or write the bytes directly. Non-ASCII text uses the checked codec, including its malformed-input traps. [Short-string changes](https://github.com/vados-cosmonic/jco/compare/ac28d5d481f3cfca94bc4c62f3571511c19386d9...9eeb7f0b9ab82a982810af5cdd1d9035b302aa39)

For longer host-returned strings, the runtime can encode into a reusable buffer before allocating guest memory. On the preceding upstream revision, a 16 KiB read took 26–28 µs across C, C++, and Rust, or 46–50% of the time for 1.13.0. The archived run compares the bindings immediately before and after this change. [UTF-8 benchmark and raw measurements](https://github.com/vados-cosmonic/component-demos/blob/7550fa7523931f918b6bd599174af07e6537961b/README.md#optimized-browser-bindings)

<!-- candidate:start -->

## Optimized browser bindings

The branch uses js-component-bindgen’s internal Oxc bundler and the checked jco-cm-runtime. [Measured Jco commit `8400d667f`](https://github.com/vados-cosmonic/jco/commit/8400d667ff71addffcd184046fc47bc9c99a02be) · [Payload and startup](#payload-and-startup) · [Reproduction commands](#reproduce-the-candidate-run)

All Jco builds used the same guest binaries. Each value is the median of 7 fresh-page samples with one warm-up per page. The run collected 728 samples on 2026-11-26 with HeadlessChrome/156.0.8078.47 on Intel(R) Xeon(R) Processor @ 2.60GHz.

The candidate finished within **10× of the fastest available compiled shim in 21/21** headline comparisons. The largest ratio was **4.15×**. On separate fresh pages it matched or beat **1.13.0 in 13/21** and **stock main in 21/21**. On the same warmed page it matched or beat **1.13.0 in 21/21** headline cases and 81/84 across all phases. The shim comparison selects the lowest median among Embind, EM_JS and wasm-bindgen for each operation, including shims written in a different guest language. The phase tables in the original comparison describe workload differences and include raw JavaScript.

![Candidate runtime relative to the two targets by operation and language](web/bench/results/candidate-runtime.png)

| Operation | Guest | Unit | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Fastest shim | Shim time | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | µs | 1.22 | 4.13 | 0.69 | 0.56× | Embind | 1.17 | 0.59× |
| Attribute write | C++ | µs | 1.18 | 3.80 | 0.62 | 0.53× | Embind | 1.17 | 0.53× |
| Attribute write | Rust | µs | 1.28 | 4.19 | 0.75 | 0.59× | Embind | 1.17 | 0.64× |
| Canvas fillRect | C | µs | 1.01 | 3.69 | 0.90 | 0.89× | Embind | 1.64 | 0.55× |
| Canvas fillRect | C++ | µs | 0.93 | 3.89 | 1.01 | 1.08× | Embind | 1.64 | 0.62× |
| Canvas fillRect | Rust | µs | 0.87 | 3.73 | 0.88 | 1.01× | Embind | 1.64 | 0.54× |
| Canvas pixel read | C | µs | 287.40 | 376.40 | 328.30 | 1.14× | Embind | 189.20 | 1.74× |
| Canvas pixel read | C++ | µs | 306.70 | 320.00 | 311.30 | 1.01× | Embind | 189.20 | 1.65× |
| Canvas pixel read | Rust | µs | 338.10 | 319.40 | 287.70 | 0.85× | Embind | 189.20 | 1.52× |
| DOM ID lookup | C | µs | 1.16 | 4.97 | 1.01 | 0.88× | Embind | 0.97 | 1.04× |
| DOM ID lookup | C++ | µs | 1.24 | 4.98 | 1.00 | 0.81× | Embind | 0.97 | 1.03× |
| DOM ID lookup | Rust | µs | 1.08 | 4.57 | 0.85 | 0.79× | Embind | 0.97 | 0.87× |
| Tree traversal | C | ms | 12.52 | 103.75 | 13.67 | 1.09× | EM_JS | 3.83 | 3.57× |
| Tree traversal | C++ | ms | 15.51 | 101.08 | 15.49 | 1.00× | EM_JS | 3.83 | 4.04× |
| Tree traversal | Rust | ms | 14.81 | 112.53 | 15.91 | 1.07× | EM_JS | 3.83 | 4.15× |
| Read 1 KiB string | C | µs | 9.93 | 7.33 | 1.98 | 0.20× | wasm-bindgen | 5.45 | 0.36× |
| Read 1 KiB string | C++ | µs | 5.11 | 7.26 | 1.91 | 0.37× | wasm-bindgen | 5.45 | 0.35× |
| Read 1 KiB string | Rust | µs | 24.71 | 7.04 | 1.78 | 0.07× | wasm-bindgen | 5.45 | 0.33× |
| Table creation | C | ms | 14.97 | 62.91 | 11.68 | 0.78× | EM_JS | 5.16 | 2.26× |
| Table creation | C++ | ms | 12.35 | 71.92 | 14.63 | 1.18× | EM_JS | 5.16 | 2.84× |
| Table creation | Rust | ms | 11.65 | 69.73 | 14.43 | 1.24× | EM_JS | 5.16 | 2.80× |

<details><summary>How the synchronous bindings work</summary>

Eligible single-instance, synchronous components reuse the caller’s task for host imports. The adapter keeps direct references to its task stack and instance flags and checks for store interruptions. Oxc removes the asynchronous import fallback. The generator skips asynchronous wrappers for synchronous allocators and post-return hooks. Standalone modules also omit suspension markers on core imports.

During a guest allocation, the checked runtime clears the instance’s may-leave flag and restores it on return or throw. Allocators in components with context-slot operations use the general guard to supply fresh slots for each call. The adapter lifts short ASCII strings four bytes at a time. Synchronous UTF-8 results of 256 to 262,144 code units can reuse a per-instance byte buffer capped at 256 KiB. The runtime encodes there before requesting the exact guest allocation. Nested calls and larger results use the ordinary encoder.

Resource drops check the instance flag and record traps. When lifting a borrowed host resource, the adapter validates the handle and reads its 32-bit representation directly. Imported host resources with automatically assigned representations use their guest handle as an array index. Explicit host representations and shared tables use a representation map. Components with async operations, cross-component resource transfers or call tracking use the general adapter.

</details>

### Change from the previous branch revision

Both revisions ran on the same guest binaries in the same browser session. Each cell divides the candidate median by the previous revision’s median. Parentheses count the rounds in which the candidate finished faster. [Compare `7c5712b61` and `8400d667f`](https://github.com/vados-cosmonic/jco/compare/7c5712b61abb6a026ea7eb94228d77a87bd030e6...8400d667ff71addffcd184046fc47bc9c99a02be)

Generated JavaScript was smaller for 31/34 inputs. The median per-input change was -1,080 bytes of JavaScript and -50 bytes of total gzip payload. Across the 21 timed guest and workload combinations, the median ratio of candidate to previous startup time was 0.95×.

| Operation | C | C++ | Rust |
| --- | --- | --- | --- |
| Attribute write | 0.99× (5/7) | 0.93× (5/7) | 0.90× (4/7) |
| Canvas fillRect | 0.88× (5/7) | 1.04× (2/7) | 0.90× (3/7) |
| Canvas pixel read | 1.03× (3/7) | 0.98× (3/7) | 1.03× (4/7) |
| DOM ID lookup | 1.26× (3/7) | 0.97× (6/7) | 1.01× (3/7) |
| Tree traversal | 0.88× (5/7) | 1.02× (2/7) | 1.01× (3/7) |
| Read 1 KiB string | 1.08× (2/7) | 0.96× (3/7) | 0.90× (5/7) |
| Table creation | 0.92× (5/7) | 1.26× (1/7) | 1.08× (3/7) |
| Bulk DOM query | 1.08× (3/7) | 0.97× (3/7) | 1.03× (5/7) |
| Tree construction | 0.96× (5/7) | 1.07× (3/7) | 0.92× (4/7) |
| set 8 B | 0.96× (4/7) | 0.85× (5/7) | 0.95× (4/7) |
| get 8 B | 0.95× (3/7) | 1.16× (2/7) | 1.10× (3/7) |
| get 128 B | 0.96× (5/7) | 0.94× (4/7) | 0.99× (4/7) |
| get 16384 B | 0.95× (5/7) | 1.03× (3/7) | 0.98× (4/7) |
| get 262144 B | 0.92× (4/7) | 1.07× (3/7) | 1.00× (4/7) |

### Warm 1.13.0 comparison on the same page

For each guest and workload, both builds run once to warm up, then 4 times each on the same page. Each pair alternates which build runs first. The runner clears the DOM and performance entries before every call. It repeats this on 9 fresh pages. Each page contributes the median of its candidate / 1.13.0 ratios. The median across pages was at or below 1× for **21/21** headline cases. [Raw paired timings](web/bench/results/paired-browser.json)

![Median paired time ratios by workload and guest, with bars spanning the middle half of page ratios](web/bench/results/paired-runtime.png)

| Operation | Guest | Candidate / 1.13.0 | Middle 50% of page ratios | Pages at or below 1× |
| --- | --- | --- | --- | --- |
| Attribute write | C | 0.51× | 0.50–0.52× | 9/9 |
| Attribute write | C++ | 0.50× | 0.50–0.53× | 9/9 |
| Attribute write | Rust | 0.56× | 0.54–0.58× | 9/9 |
| Canvas fillRect | C | 0.92× | 0.90–0.93× | 9/9 |
| Canvas fillRect | C++ | 0.91× | 0.90–0.92× | 9/9 |
| Canvas fillRect | Rust | 0.98× | 0.95–0.99× | 8/9 |
| Canvas pixel read | C | 0.93× | 0.81–1.05× | 6/9 |
| Canvas pixel read | C++ | 0.96× | 0.92–0.97× | 8/9 |
| Canvas pixel read | Rust | 0.91× | 0.72–1.03× | 6/9 |
| DOM ID lookup | C | 0.59× | 0.57–0.65× | 9/9 |
| DOM ID lookup | C++ | 0.66× | 0.58–0.71× | 9/9 |
| DOM ID lookup | Rust | 0.62× | 0.58–0.73× | 9/9 |
| Tree traversal | C | 0.76× | 0.74–0.86× | 9/9 |
| Tree traversal | C++ | 0.80× | 0.79–0.81× | 9/9 |
| Tree traversal | Rust | 0.62× | 0.60–0.98× | 7/9 |
| Read 1 KiB string | C | 0.44× | 0.41–0.44× | 9/9 |
| Read 1 KiB string | C++ | 0.45× | 0.44–0.49× | 9/9 |
| Read 1 KiB string | Rust | 0.44× | 0.38–0.48× | 9/9 |
| Table creation | C | 0.94× | 0.79–1.05× | 6/9 |
| Table creation | C++ | 1.00× | 0.86–1.04× | 5/9 |
| Table creation | Rust | 0.91× | 0.89–0.94× | 7/9 |

Across all 84 reported phases and string lengths, the same-page comparison matched or beat 1.13.0 in **81/84** cases. Totals and subphases overlap.

| Slower paired phase | Guest | Metric | Candidate / 1.13.0 | Pages at or below 1× |
| --- | --- | --- | --- | --- |
| string-marshalling | C++ | set 1024 B | 1.017× | 4/9 |
| string-marshalling | C | set 128 B | 1.013× | 4/9 |
| string-marshalling | C++ | set 16384 B | 1.003× | 3/9 |

Across all reported phases and string lengths, 81/84 comparable candidate medians were within 10× of the fastest compiled shim and 62/84 matched or beat 1.13.0. Totals and their subphases overlap. Each ratio compares the same phase on both sides.

| Phases above 10× | Phase | Guest | Shim | Candidate / shim |
| --- | --- | --- | --- | --- |
| dom-query | bulk: total ms | C | Embind | 673.33× |
| dom-query | bulk: total ms | C++ | Embind | 693.00× |
| dom-query | bulk: total ms | Rust | Embind | 749.33× |

The bulk DOM query returns a live collection to Embind, which discards it. The component host materializes the collection with `Array.from`, then the bindings lower every element into a WIT resource handle. The ratio includes that difference in work. [Embind loop](cpp/dom-query/emscripten/main.cpp) · [Component host](web/host/web-host.js) · [C guest loop](c/dom-query/main.c)

### DOM bindings with identical guest code

These 216 fresh-page samples compare each language’s exact core Wasm binary with each set of bindings in the table. The direct JS shim calls the same DOM host, puts owned handles in guest memory and recycles them on guest drops. It implements the synchronous imports used by these guests. Jco also provides Canonical ABI checks, task tracking and instance shutdown. [Direct shim](web/bench/dom-core-shim.mjs) · [Raw timings and correctness checks](web/bench/results/dom-control-browser.json)

The bulk query copies 2,000 handles per call, 10 times. Each traversal visits 19,531 nodes. The runner checks the rendered fixture or node count for each guest and verifies list counts and handle release for the direct shim after warm-up and measurement.

With list materialization on both sides, the candidate took **1.55–1.69×** the direct shim’s bulk-query time across the three guests. Times below are per measured workload, after warm-up.

![DOM phase times for Jco 1.13.0 and the candidate relative to the same-guest direct shim](web/bench/results/dom-control-runtime.png)

| Phase | Guest | Direct (ms) | 1.13.0 (ms) | Candidate (ms) | Candidate / direct | Candidate / 1.13.0 | Rounds at or below 1.13.0 | Candidate / previous | Rounds at or below previous |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DOM ID lookup | C | 15.12 | 27.98 | 19.55 | 1.29× | 0.70× | 9/9 | 0.98× | 4/9 |
| DOM ID lookup | C++ | 16.48 | 22.98 | 17.39 | 1.06× | 0.76× | 7/9 | 0.85× | 8/9 |
| DOM ID lookup | Rust | 13.99 | 23.38 | 16.66 | 1.19× | 0.71× | 8/9 | 1.00× | 4/9 |
| Bulk DOM query | C | 6.85 | 11.91 | 11.28 | 1.65× | 0.95× | 5/9 | 1.01× | 4/9 |
| Bulk DOM query | C++ | 6.95 | 9.86 | 11.77 | 1.69× | 1.19× | 4/9 | 1.05× | 5/9 |
| Bulk DOM query | Rust | 6.72 | 10.86 | 10.40 | 1.55× | 0.96× | 5/9 | 1.02× | 4/9 |
| Tree construction | C | 23.79 | 46.47 | 47.95 | 2.02× | 1.03× | 3/9 | 1.05× | 3/9 |
| Tree construction | C++ | 23.08 | 44.09 | 48.75 | 2.11× | 1.11× | 3/9 | 1.13× | 4/9 |
| Tree construction | Rust | 21.69 | 52.91 | 46.84 | 2.16× | 0.89× | 6/9 | 1.06× | 3/9 |
| Tree traversal | C | 5.18 | 12.87 | 16.12 | 3.11× | 1.25× | 2/9 | 1.18× | 3/9 |
| Tree traversal | C++ | 5.40 | 13.05 | 14.15 | 2.62× | 1.08× | 2/9 | 0.97× | 6/9 |
| Tree traversal | Rust | 6.57 | 16.75 | 17.61 | 2.68× | 1.05× | 4/9 | 0.97× | 4/9 |

### Cost of a synchronous host import

The scalar, string and resource loops run 131,072 iterations per pass. The string loop changes the first byte before each call. The resource loop acquires a host object, borrows it to read its value, and drops it. The optional-resource loop checks the discriminant in guest memory every time and reads and drops each present handle. Each pass checks its checksum. All four adapters use byte-identical core modules. The direct shim keeps the fixture’s single live handle in one slot.

The byte-list loops copy a 176 × 176 RGBA region (123,904 bytes) 2,048 times per pass in each direction. The host-to-guest case uses a reusable host view and a fixed guest allocation. In the reverse direction the host keeps the final snapshot while the guest changes the source in Wasm. Both cases sum the changing first byte during the loop and verify the whole payload afterward. The canvas demo also measures browser readback, host allocation and guest allocation.

The string-return loops make 32,768 calls per pass for 16-byte results and 1,024 for 16 KiB results. One host returns a repeated ASCII string. The other rotates four strings containing two-, three-, and four-byte UTF-8 sequences. The guest checks each byte length, sums the first bytes, and hashes every distinct result outside the timer.

Times are nanoseconds per guest iteration, including the loop and host work. Each cell is the median of 7 fresh-page medians, with 2 warm-ups and 5 timed passes per page. The runner interleaves the four builds. [Raw timings and digests](web/bench/results/import-loop.json)

| Operation | Direct | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Candidate / direct |
| --- | --- | --- | --- | --- | --- | --- |
| u32 | 13.0 | 11.4 | 1,747.9 | 13.7 | 1.20× | 1.06× |
| 2-byte string | 408.9 | 397.5 | 2,384.2 | 114.4 | 0.29× | 0.28× |
| 9-byte string | 397.5 | 386.0 | 2,288.1 | 157.2 | 0.41× | 0.40× |
| 32-byte string | 402.8 | 411.2 | 2,297.2 | 404.4 | 0.98× | 1.00× |
| Acquire, borrow, drop | 38.9 | 251.0 | 4,286.2 | 111.4 | 0.44× | 2.86× |
| Optional resource, half present | 30.5 | 182.3 | 2,990.0 | 129.7 | 0.71× | 4.25× |
| 121 KiB host-to-guest byte list | 4,492.2 | 4,638.7 | 8,349.6 | 4,736.3 | 1.02× | 1.05× |
| 121 KiB guest-to-host byte list | 92,138.7 | 94,824.2 | 94,531.3 | 94,873.0 | 1.00× | 1.03× |
| 16-byte UTF-8 result, repeated ASCII | 1,596.1 | 1,699.8 | 3,942.9 | 351.0 | 0.21× | 0.22× |
| 16-byte UTF-8 result, rotating Unicode | 1,593.0 | 1,724.2 | 4,318.2 | 921.6 | 0.53× | 0.58× |
| 16 KiB UTF-8 result, repeated ASCII | 33,203.1 | 32,324.2 | 48,925.8 | 17,675.8 | 0.55× | 0.53× |
| 16 KiB UTF-8 result, rotating Unicode | 43,359.4 | 43,554.7 | 71,679.7 | 30,273.4 | 0.70× | 0.70× |

![Time per guest iteration relative to Jco 1.13.0, by import and transfer direction](web/bench/results/import-loop-runtime.png)

### Where the canvas read spends its time

The same-page comparison was repeated with a clock around the demo’s host method. That method reads 176 × 176 pixels from Chromium and creates a JavaScript byte array. The remainder includes guest allocation and freeing, the copy into Wasm, binding checks, the loop and observer overhead. Each cell is a median across 9 page medians. Columns are summarized independently. [Raw instrumented samples](web/bench/results/canvas-control-browser.json)

| Guest | Bindings | Full read (µs) | Inside host (µs) | Remainder (µs) | Inside host (%) |
| --- | --- | --- | --- | --- | --- |
| C | 1.13.0 | 313.6 | 302.5 | 12.6 | 96.2% |
| C | Candidate | 350.2 | 336.3 | 14.0 | 96.0% |
| C++ | 1.13.0 | 326.3 | 313.5 | 13.1 | 96.0% |
| C++ | Candidate | 310.0 | 297.8 | 13.9 | 95.7% |
| Rust | 1.13.0 | 318.3 | 305.9 | 12.6 | 96.2% |
| Rust | Candidate | 319.8 | 305.9 | 13.8 | 96.1% |

The host accounted for 95.7–96.2% of the full read across these builds. The candidate spent 13.8–14.0 µs per read outside the host, compared with 12.6–13.1 µs for 1.13.0.

<details><summary>All timed phases and string lengths</summary>

| Demo | Phase | Guest | Candidate time | Fresh-page / 1.13.0 | Same-page / 1.13.0 | Candidate / main | Fastest shim | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| attribute-churn | total time | C | 54.99 ms | 0.56× | 0.51× | 0.17× | Embind | 0.59× |
| attribute-churn | total time | C++ | 49.84 ms | 0.53× | 0.50× | 0.16× | Embind | 0.53× |
| attribute-churn | total time | Rust | 60.32 ms | 0.59× | 0.56× | 0.18× | Embind | 0.64× |
| attribute-churn | per setAttribute() | C | 0.69 µs | 0.56× | 0.51× | 0.17× | Embind | 0.59× |
| attribute-churn | per setAttribute() | C++ | 0.62 µs | 0.53× | 0.50× | 0.16× | Embind | 0.53× |
| attribute-churn | per setAttribute() | Rust | 0.75 µs | 0.59× | 0.56× | 0.18× | Embind | 0.64× |
| canvas-draw | total | C | 44.92 ms | 0.89× | 0.92× | 0.24× | Embind | 0.55× |
| canvas-draw | total | C++ | 50.41 ms | 1.08× | 0.91× | 0.26× | Embind | 0.62× |
| canvas-draw | total | Rust | 44.16 ms | 1.01× | 0.98× | 0.24× | Embind | 0.54× |
| canvas-draw | per fill_rect() | C | 0.90 µs | 0.89× | 0.92× | 0.24× | Embind | 0.55× |
| canvas-draw | per fill_rect() | C++ | 1.01 µs | 1.08× | 0.91× | 0.26× | Embind | 0.62× |
| canvas-draw | per fill_rect() | Rust | 0.88 µs | 1.01× | 0.98× | 0.24× | Embind | 0.54× |
| canvas-pixels | getImageData(): µs/call | C | 328.30 µs | 1.14× | 0.93× | 0.87× | Embind | 1.74× |
| canvas-pixels | getImageData(): µs/call | C++ | 311.30 µs | 1.01× | 0.96× | 0.97× | Embind | 1.65× |
| canvas-pixels | getImageData(): µs/call | Rust | 287.70 µs | 0.85× | 0.91× | 0.90× | Embind | 1.52× |
| canvas-pixels | putImageData(): µs/call | C | 245.60 µs | 1.00× | 0.88× | 0.81× | Embind | 1.18× |
| canvas-pixels | putImageData(): µs/call | C++ | 239.90 µs | 0.86× | 0.88× | 0.85× | Embind | 1.16× |
| canvas-pixels | putImageData(): µs/call | Rust | 208.80 µs | 0.48× | 0.97× | 0.61× | Embind | 1.01× |
| dom-query | individual: total ms | C | 20.30 ms | 0.88× | 0.59× | 0.20× | Embind | 1.04× |
| dom-query | individual: total ms | C++ | 20.02 ms | 0.81× | 0.66× | 0.20× | Embind | 1.03× |
| dom-query | individual: total ms | Rust | 17.05 ms | 0.79× | 0.62× | 0.19× | Embind | 0.87× |
| dom-query | bulk: total ms | C | 10.10 ms | 1.03× | 0.76× | 0.56× | Embind | 673.33× |
| dom-query | bulk: total ms | C++ | 10.39 ms | 0.98× | 0.85× | 0.57× | Embind | 693.00× |
| dom-query | bulk: total ms | Rust | 11.24 ms | 1.07× | 0.78× | 0.70× | Embind | 749.33× |
| dom-query | individual: µs/element | C | 1.01 µs | 0.88× | 0.59× | 0.20× | Embind | 1.04× |
| dom-query | individual: µs/element | C++ | 1.00 µs | 0.81× | 0.66× | 0.20× | Embind | 1.03× |
| dom-query | individual: µs/element | Rust | 0.85 µs | 0.79× | 0.62× | 0.19× | Embind | 0.87× |
| dom-traversal | build | C | 47.77 ms | 0.97× | 0.82× | 0.23× | EM_JS | 2.63× |
| dom-traversal | build | C++ | 48.72 ms | 0.98× | 0.84× | 0.24× | EM_JS | 2.68× |
| dom-traversal | build | Rust | 39.87 ms | 0.88× | 0.86× | 0.19× | EM_JS | 2.20× |
| dom-traversal | traverse (total) | C | 13.67 ms | 1.09× | 0.76× | 0.13× | EM_JS | 3.57× |
| dom-traversal | traverse (total) | C++ | 15.49 ms | 1.00× | 0.80× | 0.15× | EM_JS | 4.04× |
| dom-traversal | traverse (total) | Rust | 15.91 ms | 1.07× | 0.62× | 0.14× | EM_JS | 4.15× |
| dom-traversal | traverse (per node) | C | 0.70 µs | 1.09× | 0.76× | 0.13× | EM_JS | 3.57× |
| dom-traversal | traverse (per node) | C++ | 0.79 µs | 1.00× | 0.80× | 0.15× | EM_JS | 4.05× |
| dom-traversal | traverse (per node) | Rust | 0.81 µs | 1.07× | 0.62× | 0.14× | EM_JS | 4.15× |
| string-marshalling | set 8 B | C | 0.39 µs | 0.50× | 0.76× | 0.14× | EM_JS | 1.19× |
| string-marshalling | set 8 B | C++ | 0.39 µs | 0.48× | 0.69× | 0.12× | EM_JS | 1.19× |
| string-marshalling | set 8 B | Rust | 0.35 µs | 0.39× | 0.68× | 0.12× | EM_JS | 1.08× |
| string-marshalling | get 8 B | C | 0.46 µs | 0.24× | 0.25× | 0.09× | EM_JS | 2.26× |
| string-marshalling | get 8 B | C++ | 0.57 µs | 0.27× | 0.24× | 0.12× | EM_JS | 2.82× |
| string-marshalling | get 8 B | Rust | 0.54 µs | 0.26× | 0.25× | 0.10× | EM_JS | 2.68× |
| string-marshalling | set 128 B | C | 0.61 µs | 0.59× | 1.01× | 0.19× | wasm-bindgen | 1.13× |
| string-marshalling | set 128 B | C++ | 0.64 µs | 0.77× | 0.94× | 0.16× | wasm-bindgen | 1.20× |
| string-marshalling | set 128 B | Rust | 0.56 µs | 0.65× | 0.90× | 0.16× | wasm-bindgen | 1.04× |
| string-marshalling | get 128 B | C | 1.81 µs | 0.70× | 0.70× | 0.36× | wasm-bindgen | 2.12× |
| string-marshalling | get 128 B | C++ | 1.75 µs | 0.77× | 0.64× | 0.34× | wasm-bindgen | 2.05× |
| string-marshalling | get 128 B | Rust | 1.65 µs | 0.71× | 0.75× | 0.32× | wasm-bindgen | 1.93× |
| string-marshalling | set 1024 B | C | 0.97 µs | 0.75× | 0.96× | 0.28× | wasm-bindgen | 1.12× |
| string-marshalling | set 1024 B | C++ | 0.96 µs | 0.88× | 1.02× | 0.25× | wasm-bindgen | 1.12× |
| string-marshalling | set 1024 B | Rust | 0.95 µs | 0.70× | 0.94× | 0.29× | wasm-bindgen | 1.11× |
| string-marshalling | get 1024 B | C | 1.98 µs | 0.20× | 0.44× | 0.27× | wasm-bindgen | 0.36× |
| string-marshalling | get 1024 B | C++ | 1.91 µs | 0.37× | 0.45× | 0.26× | wasm-bindgen | 0.35× |
| string-marshalling | get 1024 B | Rust | 1.78 µs | 0.07× | 0.44× | 0.25× | wasm-bindgen | 0.33× |
| string-marshalling | set 16384 B | C | 6.46 µs | 0.96× | 0.98× | 0.69× | wasm-bindgen | 0.99× |
| string-marshalling | set 16384 B | C++ | 6.87 µs | 0.97× | 1.00× | 0.68× | wasm-bindgen | 1.05× |
| string-marshalling | set 16384 B | Rust | 6.39 µs | 0.87× | 0.99× | 0.63× | wasm-bindgen | 0.98× |
| string-marshalling | get 16384 B | C | 17.12 µs | 0.53× | 0.52× | 0.33× | wasm-bindgen | 0.21× |
| string-marshalling | get 16384 B | C++ | 17.95 µs | 0.34× | 0.54× | 0.33× | wasm-bindgen | 0.23× |
| string-marshalling | get 16384 B | Rust | 17.39 µs | 0.50× | 0.54× | 0.30× | wasm-bindgen | 0.22× |
| string-marshalling | set 262144 B | C | 97.25 µs | 0.40× | 0.71× | 0.38× | Embind | 0.85× |
| string-marshalling | set 262144 B | C++ | 112.30 µs | 0.50× | 0.73× | 0.42× | Embind | 0.98× |
| string-marshalling | set 262144 B | Rust | 103.30 µs | 0.44× | 0.85× | 0.40× | Embind | 0.90× |
| string-marshalling | get 262144 B | C | 262.90 µs | 0.27× | 0.29× | 0.35× | wasm-bindgen | 0.20× |
| string-marshalling | get 262144 B | C++ | 281.25 µs | 0.31× | 0.29× | 0.37× | wasm-bindgen | 0.22× |
| string-marshalling | get 262144 B | Rust | 263.30 µs | 0.29× | 0.29× | 0.35× | wasm-bindgen | 0.21× |
| table-update | create: total ms | C | 11.68 ms | 0.78× | 0.94× | 0.19× | EM_JS | 2.26× |
| table-update | create: total ms | C++ | 14.63 ms | 1.18× | 1.00× | 0.20× | EM_JS | 2.84× |
| table-update | create: total ms | Rust | 14.43 ms | 1.24× | 0.91× | 0.21× | EM_JS | 2.80× |
| table-update | create: µs/row | C | 5.84 µs | 0.78× | 0.94× | 0.19× | EM_JS | 2.26× |
| table-update | create: µs/row | C++ | 7.32 µs | 1.18× | 1.00× | 0.20× | EM_JS | 2.84× |
| table-update | create: µs/row | Rust | 7.21 µs | 1.24× | 0.91× | 0.21× | EM_JS | 2.80× |
| table-update | update (selected): total ms | C | 1.01 ms | 0.86× | 0.91× | 0.30× | EM_JS | 1.12× |
| table-update | update (selected): total ms | C++ | 1.14 ms | 1.24× | 0.81× | 0.31× | EM_JS | 1.25× |
| table-update | update (selected): total ms | Rust | 1.11 ms | 1.21× | 0.91× | 0.36× | EM_JS | 1.23× |
| table-update | update (selected): µs/row | C | 0.51 µs | 0.86× | 0.91× | 0.30× | EM_JS | 1.12× |
| table-update | update (selected): µs/row | C++ | 0.57 µs | 1.24× | 0.81× | 0.31× | EM_JS | 1.25× |
| table-update | update (selected): µs/row | Rust | 0.56 µs | 1.21× | 0.91× | 0.36× | EM_JS | 1.23× |
| table-update | clear (unselected): total ms | C | 2.96 ms | 0.63× | 0.74× | 0.20× | wasm-bindgen | 1.22× |
| table-update | clear (unselected): total ms | C++ | 3.50 ms | 0.87× | 0.76× | 0.18× | wasm-bindgen | 1.43× |
| table-update | clear (unselected): total ms | Rust | 3.58 ms | 1.10× | 0.71× | 0.20× | wasm-bindgen | 1.47× |
| table-update | clear (unselected): µs/row | C | 1.48 µs | 0.63× | 0.74× | 0.20× | wasm-bindgen | 1.22× |
| table-update | clear (unselected): µs/row | C++ | 1.75 µs | 0.87× | 0.76× | 0.18× | wasm-bindgen | 1.43× |
| table-update | clear (unselected): µs/row | Rust | 1.79 µs | 1.10× | 0.71× | 0.20× | wasm-bindgen | 1.47× |

</details>

### Payload and startup

Payload medians cover 34 component inputs. Compression is per file. Startup is the median of the 21 per-workload and guest medians, from dynamic import through initialization, with browser caching disabled.

| Build | JS (KiB) | Core Wasm (KiB) | Total (KiB) | Gzip (KiB) | Brotli (KiB) | Startup (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 | 19.4 | 64.4 | 85.4 | 29.3 | 24.1 | 10.03 |
| Stock main | 180.8 | 64.4 | 252.1 | 57.6 | 47.8 | 24.21 |
| Candidate | 148.5 | 64.4 | 216.0 | 53.4 | 44.5 | 20.94 |

### What ships with `--minify`

Each Jco build generated its default and minified distribution from the same 34 components. Jco 1.13.0 uses Terser for its minify option. Stock main and the branch use Oxc. All external Wasm files matched byte for byte across formats. Payloads include JavaScript and external Wasm, compressed per file. Chromium interleaved the six distributions across 630 fresh pages, with 5 rounds for each of the 21 guest and workload combinations. The two ratio columns compare each format to that build’s default for the same guest and workload, then take the median of the 21 ratios. The final column compares workload times to the same format of 1.13.0. [Distribution sizes](web/bench/results/minified-sizes.json) · [Timings and resource requests](web/bench/results/minified-browser.json)

| Distribution | JS (KiB) | Total gzip (KiB) | Total Brotli (KiB) | Startup (ms) | Startup / default | Runtime / default | At or below 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 default | 19.4 | 29.3 | 24.1 | 10.21 | 1.00× | 1.00× | 21/21 |
| 1.13.0 minified | 8.7 | 28.8 | 23.7 | 9.84 | 0.98× | 1.00× | 21/21 |
| Stock main default | 180.8 | 57.6 | 47.8 | 23.85 | 1.00× | 1.00× | 2/21 |
| Stock main minified | 104.9 | 50.7 | 42.8 | 22.11 | 0.92× | 1.02× | 1/21 |
| Candidate default | 148.5 | 53.4 | 44.5 | 21.72 | 1.00× | 1.00× | 13/21 |
| Candidate minified | 83.1 | 47.2 | 39.9 | 19.21 | 0.90× | 1.01× | 16/21 |

Chromium’s Resource Timing entries give four consecutive intervals from the start of dynamic import until the module is ready. The gap before the first Wasm request includes resolving dependencies and executing JavaScript. The local server served uncompressed assets with caching disabled. Browser response-body sizes were checked against the generated file sizes. Each column reports its own median over workload medians.

| Distribution | Import to JS response end (ms) | JS response end to first Wasm request (ms) | First Wasm request to last Wasm response (ms) | Last Wasm response to ready (ms) |
| --- | --- | --- | --- | --- |
| 1.13.0 default | 2.05 | 3.04 | 2.12 | 2.77 |
| 1.13.0 minified | 2.00 | 2.79 | 2.15 | 2.71 |
| Stock main default | 2.35 | 15.45 | 2.34 | 3.86 |
| Stock main minified | 2.23 | 13.76 | 2.23 | 4.02 |
| Candidate default | 2.31 | 13.05 | 2.27 | 3.90 |
| Candidate minified | 2.18 | 11.07 | 2.14 | 3.75 |

Minifying the branch reduced startup by 10% on the median same-workload comparison. Its median import-to-ready time was 19.21 ms, compared with 9.84 ms for minified 1.13.0. Between the end of the entry JavaScript response and the first Wasm request, the corresponding medians were 11.07 and 2.79 ms.

![Default and minified gzip payloads and fresh-page startup for three Jco builds](web/bench/results/minified-startup.png)

### Startup with DevTools disconnected

In 1,260 fresh documents, the page timed its own dynamic import, ran the guest and sent the result to a local server. One browser kept the Puppeteer DevTools connection open. The other disconnected before the first measured navigation. Both navigated the same tab, with matching Chrome flags, no-store responses and verified network transfers. The order of the two browsers alternated over 5 rounds. Each table cell is the median of the 21 workload medians. [Observer timings](web/bench/results/startup-observer.json)

| Distribution | Attached startup (ms) | Detached startup (ms) | Attached JS end to Wasm request (ms) | Detached JS end to Wasm request (ms) |
| --- | --- | --- | --- | --- |
| 1.13.0 default | 8.07 | 5.96 | 2.83 | 1.67 |
| 1.13.0 minified | 7.84 | 5.66 | 2.52 | 1.62 |
| Stock main default | 21.06 | 13.78 | 14.38 | 8.22 |
| Stock main minified | 19.64 | 12.98 | 12.85 | 7.47 |
| Candidate default | 18.21 | 12.34 | 11.42 | 6.90 |
| Candidate minified | 16.00 | 11.59 | 9.96 | 6.25 |

### Generated JavaScript reached by each demo

Chromium recorded block coverage on 126 fresh pages in a separate run. One page imported each module and finished initialization. A second also ran the demo once and checked its output. The table reports medians over the 21 guest and workload combinations. Sizes count UTF-8 bytes in V8’s covered source ranges. A demo can leave error handling, shutdown or other supported operations unexercised. [Per-module coverage and hashes](web/bench/results/js-coverage.json)

| Build | Reached at init (KiB) | Reached through first run (KiB) | Share through first run | Unreached through first run (KiB) |
| --- | --- | --- | --- | --- |
| 1.13.0 | 4.8 | 16.3 | 76.6% | 5.0 |
| Stock main | 53.9 | 96.3 | 51.2% | 91.3 |
| Candidate | 41.4 | 65.6 | 43.5% | 85.3 |

<details><summary>Candidate startup, variation and paired comparison to 1.13.0</summary>

The paired ratio divides the candidate time by the 1.13.0 time within each round, then takes the median. The final column counts rounds where the candidate was at least as fast.

| Operation | Guest | Startup median (ms) | Warm phase p25 | Warm phase p50 | Warm phase p75 | Phase unit | Paired ratio to 1.13.0 | Rounds at or below 1.13.0 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | 18.47 | 0.63 | 0.69 | 0.71 | µs | 0.56× | 7/7 |
| Attribute write | C++ | 21.07 | 0.57 | 0.62 | 0.65 | µs | 0.50× | 7/7 |
| Attribute write | Rust | 20.94 | 0.69 | 0.75 | 0.78 | µs | 0.58× | 7/7 |
| Canvas fillRect | C | 19.36 | 0.80 | 0.90 | 1.02 | µs | 1.01× | 3/7 |
| Canvas fillRect | C++ | 21.78 | 0.95 | 1.01 | 1.05 | µs | 0.99× | 4/7 |
| Canvas fillRect | Rust | 18.95 | 0.73 | 0.88 | 0.99 | µs | 1.04× | 3/7 |
| Canvas pixel read | C | 20.96 | 282.30 | 328.30 | 420.10 | µs | 1.24× | 3/7 |
| Canvas pixel read | C++ | 21.36 | 308.80 | 311.30 | 362.40 | µs | 1.22× | 2/7 |
| Canvas pixel read | Rust | 20.32 | 278.25 | 287.70 | 302.35 | µs | 0.85× | 4/7 |
| DOM ID lookup | C | 22.21 | 0.79 | 1.01 | 1.11 | µs | 0.74× | 5/7 |
| DOM ID lookup | C++ | 21.18 | 0.91 | 1.00 | 1.08 | µs | 0.84× | 6/7 |
| DOM ID lookup | Rust | 21.41 | 0.81 | 0.85 | 1.07 | µs | 0.79× | 5/7 |
| Tree traversal | C | 20.68 | 12.13 | 13.67 | 15.24 | ms | 1.07× | 3/7 |
| Tree traversal | C++ | 20.68 | 15.06 | 15.49 | 17.68 | ms | 1.07× | 1/7 |
| Tree traversal | Rust | 21.08 | 15.09 | 15.91 | 17.11 | ms | 1.10× | 2/7 |
| Read 1 KiB string | C | 18.68 | 1.86 | 1.98 | 2.05 | µs | 0.19× | 7/7 |
| Read 1 KiB string | C++ | 18.94 | 1.90 | 1.91 | 2.14 | µs | 0.37× | 7/7 |
| Read 1 KiB string | Rust | 19.31 | 1.65 | 1.78 | 1.82 | µs | 0.07× | 7/7 |
| Table creation | C | 22.37 | 11.37 | 11.68 | 14.85 | ms | 0.93× | 5/7 |
| Table creation | C++ | 23.71 | 12.98 | 14.63 | 15.47 | ms | 1.01× | 3/7 |
| Table creation | Rust | 19.60 | 13.09 | 14.43 | 15.05 | ms | 1.08× | 2/7 |

</details>

[Raw browser timings](web/bench/results/candidate-browser.json) · [File sizes, digests and generator revision](web/bench/results/candidate-sizes.json)

### Reproduce the candidate run

Run the dependency installation, main setup and size commands in [Reproduce the comparison](#reproduce-the-comparison), then run the following from the repository root. Cargo uses the Jco checkout’s pinned toolchain and lockfile.

```sh
git clone https://github.com/vados-cosmonic/jco ../jco-candidate
git -C ../jco-candidate checkout 8400d667ff71addffcd184046fc47bc9c99a02be
node web/bench/candidate.mjs ../jco-candidate
git -C ../jco-candidate worktree add --detach ../jco-reference 7c5712b61abb6a026ea7eb94228d77a87bd030e6
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

Across the seven operations below and three guest languages, main took longer in **18 of 21** median comparisons. The highest ratio was **8.29×** for the C guest in `dom-traversal`.

For 256 KiB string reads, the median time on main changed by -22% to -14% across the three guest languages. The phase tables below include every tested string size.

Each cell is the median of 7 fresh-page samples. The chart divides main’s median time by 1.13.0’s for the same guest and operation. A value below 1× means main finished faster.

![Median time on main divided by baseline time for seven operations and three guest languages](web/bench/results/runtime.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 0.284 | 1.17 | — | — | 1.22 | 4.13 | 1.18 | 3.80 | 1.28 | 4.19 |
| Canvas fillRect (µs) | 0.875 | 1.64 | — | — | 1.01 | 3.69 | 0.931 | 3.89 | 0.871 | 3.73 |
| Canvas pixel read (µs) | 157.20 | 189.20 | — | — | 287.40 | 376.40 | 306.70 | 320.00 | 338.10 | 319.40 |
| DOM ID lookup (µs) | 0.287 | 0.975 | — | — | 1.16 | 4.97 | 1.24 | 4.98 | 1.08 | 4.57 |
| Tree traversal (ms) | 0.775 | 23.83 | 3.83 | 6.77 | 12.52 | 103.75 | 15.51 | 101.08 | 14.81 | 112.53 |
| Read 1 KiB string (µs) | 0.1 | 10.72 | 9.77 | 5.45 | 9.93 | 7.33 | 5.11 | 7.26 | 24.71 | 7.04 |
| Table creation (ms) | 3.88 | 14.44 | 5.16 | 9.13 | 14.97 | 62.91 | 12.35 | 71.92 | 11.65 | 69.73 |

Embind and EM_JS are the C++ Emscripten variants. An em dash marks an unavailable combination. Across toolchains, the upstream implementations can do different amounts of work. For example, the JavaScript bulk DOM query obtains a live collection while the component host materializes a list.

<details><summary>Run-to-run variation for the two jco versions</summary>

Each cell spans the 25th to 75th percentile of measured times, using linear interpolation between sorted samples.

| Operation | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 1.16–1.31 | 3.93–4.23 | 1.16–1.22 | 3.59–4.03 | 1.20–1.37 | 4.11–4.31 |
| Canvas fillRect (µs) | 0.883–1.08 | 3.35–3.77 | 0.913–0.998 | 3.60–3.98 | 0.798–0.961 | 3.47–3.80 |
| Canvas pixel read (µs) | 261.65–314.55 | 366.15–386.90 | 280.55–315.15 | 306.25–354.80 | 280.15–359.15 | 292.15–336.90 |
| DOM ID lookup (µs) | 1.10–1.33 | 4.51–5.48 | 1.05–1.32 | 4.60–5.14 | 1.02–1.12 | 4.40–4.76 |
| Tree traversal (ms) | 12.08–13.62 | 87.37–110.70 | 11.59–16.96 | 97.43–102.75 | 14.10–15.88 | 108.19–120.16 |
| Read 1 KiB string (µs) | 4.51–19.47 | 6.77–7.57 | 3.76–23.58 | 7.00–7.99 | 4.87–50.41 | 6.64–7.41 |
| Table creation (ms) | 14.58–15.45 | 55.35–72.11 | 11.75–13.43 | 70.50–75.27 | 11.09–14.44 | 62.47–75.99 |

</details>

<details><summary>All workload phases, per-call timings, and string transfer rates</summary>

Times come from the tables rendered by the demos and retain their original reporting precision. Effective string throughput uses the ASCII payload length divided by median call time (decimal MB/s).

**attribute-churn**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total time (ms) | 22.73 | 93.89 | — | — | 97.53 | 330.20 | 94.22 | 304.15 | 102.06 | 334.89 |
| per setAttribute() (µs) | 0.284 | 1.17 | — | — | 1.22 | 4.13 | 1.18 | 3.80 | 1.28 | 4.19 |

**canvas-draw**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total (ms) | 43.74 | 81.86 | — | — | 50.52 | 184.66 | 46.56 | 194.56 | 43.55 | 186.56 |
| per fill_rect() (µs) | 0.875 | 1.64 | — | — | 1.01 | 3.69 | 0.931 | 3.89 | 0.871 | 3.73 |

**canvas-pixels**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| getImageData() (µs) | 157.20 | 189.20 | — | — | 287.40 | 376.40 | 306.70 | 320.00 | 338.10 | 319.40 |
| putImageData() (µs) | 12.40 | 207.30 | — | — | 246.60 | 302.80 | 278.30 | 280.90 | 433.70 | 343.40 |

**dom-query**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| individual, total (ms) | 5.75 | 19.50 | — | — | 23.18 | 99.45 | 24.82 | 99.58 | 21.59 | 91.35 |
| bulk, total (ms) | 0.01 | 0.015 | — | — | 9.80 | 18.09 | 10.58 | 18.32 | 10.47 | 16.06 |
| individual: µs/element (µs) | 0.287 | 0.975 | — | — | 1.16 | 4.97 | 1.24 | 4.98 | 1.08 | 4.57 |

**dom-traversal**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| build (ms) | 10.11 | 34.72 | 18.15 | 28.31 | 49.20 | 206.16 | 49.55 | 201.75 | 45.49 | 209.34 |
| traverse (total) (ms) | 0.775 | 23.83 | 3.83 | 6.77 | 12.52 | 103.75 | 15.51 | 101.08 | 14.81 | 112.53 |
| traverse (per node) (µs) | 0.04 | 1.22 | 0.196 | 0.347 | 0.641 | 5.31 | 0.794 | 5.17 | 0.758 | 5.76 |

**string-marshalling**

![Median DOM textContent set and get latency by payload length for each guest and jco version, on logarithmic axes](web/bench/results/strings.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| set 8 B (µs) | 0.187 | 0.781 | 0.33 | 0.514 | 0.783 | 2.91 | 0.824 | 3.34 | 0.914 | 2.90 |
| set 8 B (MB/s) | 42.78 | 10.24 | 24.24 | 15.56 | 10.22 | 2.75 | 9.71 | 2.39 | 8.75 | 2.76 |
| get 8 B (µs) | 0.084 | 1.07 | 0.203 | 0.225 | 1.95 | 5.20 | 2.15 | 4.71 | 2.07 | 5.36 |
| get 8 B (MB/s) | 95.24 | 7.46 | 39.41 | 35.56 | 4.11 | 1.54 | 3.73 | 1.70 | 3.87 | 1.49 |
| set 128 B (µs) | 0.31 | 1.13 | 0.798 | 0.536 | 1.03 | 3.21 | 0.828 | 4.00 | 0.866 | 3.60 |
| set 128 B (MB/s) | 412.90 | 113.58 | 160.40 | 238.81 | 124.27 | 39.93 | 154.59 | 31.98 | 147.81 | 35.53 |
| get 128 B (µs) | 0.084 | 2.15 | 1.34 | 0.855 | 2.58 | 5.08 | 2.28 | 5.12 | 2.32 | 5.10 |
| get 128 B (MB/s) | 1,523.81 | 59.48 | 95.59 | 149.71 | 49.59 | 25.19 | 56.09 | 25.01 | 55.08 | 25.09 |
| set 1024 B (µs) | 1.01 | 1.42 | 2.50 | 0.862 | 1.30 | 3.43 | 1.10 | 3.78 | 1.37 | 3.31 |
| set 1024 B (MB/s) | 1,015.87 | 722.65 | 409.60 | 1,187.94 | 788.91 | 298.46 | 930.91 | 270.61 | 747.99 | 309.74 |
| get 1024 B (µs) | 0.1 | 10.72 | 9.77 | 5.45 | 9.93 | 7.33 | 5.11 | 7.26 | 24.71 | 7.04 |
| get 1024 B (MB/s) | 10,240.00 | 95.50 | 104.82 | 187.82 | 103.08 | 139.80 | 200.35 | 140.99 | 41.45 | 145.50 |
| set 16384 B (µs) | 12.44 | 7.16 | 32.80 | 6.52 | 6.72 | 9.35 | 7.08 | 10.04 | 7.34 | 10.19 |
| set 16384 B (MB/s) | 1,316.94 | 2,287.31 | 499.51 | 2,514.43 | 2,438.46 | 1,751.74 | 2,312.82 | 1,631.22 | 2,231.85 | 1,607.22 |
| get 16384 B (µs) | 0.469 | 153.85 | 154.15 | 79.72 | 32.49 | 52.23 | 53.15 | 54.95 | 35.05 | 57.35 |
| get 16384 B (MB/s) | 34,933.90 | 106.49 | 106.29 | 205.51 | 504.31 | 313.72 | 308.26 | 298.16 | 467.45 | 285.68 |
| set 262144 B (µs) | 165.00 | 114.85 | 508.95 | 233.90 | 243.00 | 256.60 | 225.15 | 268.00 | 237.15 | 258.10 |
| set 262144 B (MB/s) | 1,588.75 | 2,282.49 | 515.07 | 1,120.75 | 1,078.78 | 1,021.61 | 1,164.31 | 978.15 | 1,105.39 | 1,015.67 |
| get 262144 B (µs) | 12.19 | 2,449.20 | 2,463.80 | 1,283.50 | 966.60 | 751.45 | 893.20 | 766.60 | 914.85 | 761.60 |
| get 262144 B (MB/s) | 21,508.37 | 107.03 | 106.40 | 204.24 | 271.20 | 348.85 | 293.49 | 341.96 | 286.54 | 344.20 |

**table-update**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create, total (ms) | 3.88 | 14.44 | 5.16 | 9.13 | 14.97 | 62.91 | 12.35 | 71.92 | 11.65 | 69.73 |
| create, per row (µs) | 1.94 | 7.22 | 2.58 | 4.57 | 7.49 | 31.45 | 6.17 | 35.96 | 5.83 | 34.87 |
| update (selected), total (ms) | 0.45 | 1.38 | 0.905 | 0.945 | 1.17 | 3.35 | 0.915 | 3.62 | 0.915 | 3.08 |
| update (selected), per row (µs) | 0.225 | 0.69 | 0.452 | 0.472 | 0.585 | 1.67 | 0.457 | 1.81 | 0.458 | 1.54 |
| clear (unselected), total (ms) | 1.70 | 4.00 | 3.48 | 2.44 | 4.74 | 14.73 | 4.04 | 19.29 | 3.27 | 17.58 |
| clear (unselected), per row (µs) | 0.847 | 2.00 | 1.74 | 1.22 | 2.37 | 7.37 | 2.02 | 9.64 | 1.63 | 8.79 |

</details>

<details><summary>Module load and initialization, median milliseconds</summary>

Elapsed browser time for dynamic import through instantiation, with the shared demo host already loaded. The browser process is reused, each page has HTTP caching disabled, and assets are served uncompressed over loopback. These timings include scheduling and local requests. JS is already loaded by the harness.

| Workload | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| attribute-churn | 12.66 | — | — | 9.46 | 22.50 | 9.68 | 24.41 | 9.82 | 23.71 |
| canvas-draw | 14.45 | — | — | 11.56 | 23.81 | 9.44 | 25.60 | 11.00 | 24.36 |
| canvas-pixels | 13.67 | — | — | 10.97 | 26.90 | 9.69 | 24.18 | 11.27 | 24.04 |
| dom-query | 13.30 | — | — | 11.01 | 25.60 | 10.03 | 24.77 | 11.54 | 23.10 |
| dom-traversal | 13.75 | 8.99 | 8.68 | 9.62 | 24.82 | 10.21 | 24.21 | 9.57 | 23.93 |
| string-marshalling | 11.45 | 8.04 | 7.23 | 9.36 | 21.99 | 9.74 | 22.89 | 10.35 | 22.02 |
| table-update | 12.56 | 8.70 | 8.26 | 11.07 | 24.30 | 10.11 | 24.60 | 9.93 | 25.54 |

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
