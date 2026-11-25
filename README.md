# Component demos

This fork benchmarks the browser examples from [eqrion/component-demos at d0b9dd1](https://github.com/eqrion/component-demos/tree/d0b9dd1390a300978193adc623838fef4e4b632b). It runs the same compiled C, C++, and Rust WebAssembly components through jco 1.13.0, pinned upstream main, and a branch that optimizes synchronous host imports. The comparison also includes the demos’ JavaScript, Emscripten (Embind and EM_JS), and Rust wasm-bindgen implementations where available.

<!-- candidate:start -->

## Optimized browser bindings

The candidate uses js-component-bindgen’s internal Oxc bundler and the checked jco-cm-runtime. For eligible single-instance, synchronous components, a host import reuses the caller’s task. Components with async operations, cross-component resource transfers or call tracking keep the general adapter. [Jco commit `ac28d5d48`](https://github.com/vados-cosmonic/jco/commit/ac28d5d481f3cfca94bc4c62f3571511c19386d9)

All three Jco builds used the same guest binaries. Each value is the median of 7 fresh-page samples with one warm-up per page. The run collected 581 samples on 2026-11-25 with HeadlessChrome/156.0.8078.47 on Intel(R) Xeon(R) Processor @ 2.60GHz.

The candidate finished within **10× of the fastest available compiled shim in 21/21** headline comparisons. It matched or beat **1.13.0 in 5/21** and **stock main in 21/21**. The strictest shim comparison selects the lowest median among Embind, EM_JS and wasm-bindgen for each operation, including shims written in a different guest language. The phase tables in the original comparison describe workload differences and include raw JavaScript.

![Candidate runtime relative to the two targets by operation and language](web/bench/results/candidate-runtime.png)

| Operation | Guest | Unit | 1.13.0 | Stock main | Candidate | Candidate / 1.13.0 | Fastest shim | Shim time | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | µs | 2.98 | 11.17 | 3.37 | 1.13× | Embind | 2.83 | 1.19× |
| Attribute write | C++ | µs | 2.91 | 8.45 | 3.19 | 1.09× | Embind | 2.83 | 1.13× |
| Attribute write | Rust | µs | 3.38 | 8.95 | 3.73 | 1.10× | Embind | 2.83 | 1.32× |
| Canvas fillRect | C | µs | 2.73 | 9.93 | 2.62 | 0.96× | Embind | 4.03 | 0.65× |
| Canvas fillRect | C++ | µs | 2.63 | 9.18 | 1.86 | 0.71× | Embind | 4.03 | 0.46× |
| Canvas fillRect | Rust | µs | 2.32 | 8.24 | 2.34 | 1.01× | Embind | 4.03 | 0.58× |
| Canvas pixel read | C | µs | 820.00 | 879.70 | 837.20 | 1.02× | Embind | 486.40 | 1.72× |
| Canvas pixel read | C++ | µs | 678.10 | 892.50 | 578.10 | 0.85× | Embind | 486.40 | 1.19× |
| Canvas pixel read | Rust | µs | 697.50 | 900.60 | 831.30 | 1.19× | Embind | 486.40 | 1.71× |
| DOM ID lookup | C | µs | 3.24 | 12.36 | 3.59 | 1.11× | Embind | 2.92 | 1.23× |
| DOM ID lookup | C++ | µs | 3.21 | 13.05 | 3.76 | 1.17× | Embind | 2.92 | 1.29× |
| DOM ID lookup | Rust | µs | 2.86 | 10.72 | 3.31 | 1.16× | Embind | 2.92 | 1.13× |
| Tree traversal | C | ms | 20.80 | 173.41 | 31.81 | 1.53× | EM_JS | 8.44 | 3.77× |
| Tree traversal | C++ | ms | 27.79 | 168.20 | 40.74 | 1.47× | EM_JS | 8.44 | 4.83× |
| Tree traversal | Rust | ms | 27.72 | 213.20 | 37.96 | 1.37× | EM_JS | 8.44 | 4.50× |
| Read 1 KiB string | C | µs | 7.51 | 17.91 | 7.87 | 1.05× | wasm-bindgen | 7.72 | 1.02× |
| Read 1 KiB string | C++ | µs | 6.97 | 16.44 | 6.66 | 0.96× | wasm-bindgen | 7.72 | 0.86× |
| Read 1 KiB string | Rust | µs | 8.06 | 14.07 | 6.86 | 0.85× | wasm-bindgen | 7.72 | 0.89× |
| Table creation | C | ms | 36.80 | 182.79 | 52.28 | 1.42× | EM_JS | 12.94 | 4.04× |
| Table creation | C++ | ms | 24.72 | 159.16 | 47.72 | 1.93× | EM_JS | 12.94 | 3.69× |
| Table creation | Rust | ms | 37.22 | 184.95 | 50.03 | 1.34× | EM_JS | 12.94 | 3.87× |

Across all reported phases and string lengths, 80/84 comparable candidate medians were within 10× of the fastest compiled shim and 28/84 matched or beat 1.13.0. Totals and their subphases overlap. Each ratio compares the same phase on both sides.

| Phases above 10× | Phase | Guest | Shim | Candidate / shim |
| --- | --- | --- | --- | --- |
| dom-query | bulk: total ms | C | Embind | 748.78× |
| dom-query | bulk: total ms | C++ | Embind | 731.89× |
| dom-query | bulk: total ms | Rust | Embind | 732.22× |
| string-marshalling | get 8 B | C | wasm-bindgen | 10.09× |

The bulk DOM query returns a live collection to Embind, which discards it. The component host materializes the collection with `Array.from`, then the bindings lower every element into a WIT resource handle. The ratio includes that difference in work. [Embind loop](cpp/dom-query/emscripten/main.cpp) · [Component host](web/host/web-host.js) · [C guest loop](c/dom-query/main.c)

<details><summary>All timed phases and string lengths</summary>

| Demo | Phase | Guest | Candidate time | Candidate / 1.13.0 | Candidate / main | Fastest shim | Candidate / shim |
| --- | --- | --- | --- | --- | --- | --- | --- |
| attribute-churn | total time | C | 269.30 ms | 1.13× | 0.30× | Embind | 1.19× |
| attribute-churn | total time | C++ | 255.07 ms | 1.09× | 0.38× | Embind | 1.13× |
| attribute-churn | total time | Rust | 298.27 ms | 1.10× | 0.42× | Embind | 1.32× |
| attribute-churn | per setAttribute() | C | 3.37 µs | 1.13× | 0.30× | Embind | 1.19× |
| attribute-churn | per setAttribute() | C++ | 3.19 µs | 1.09× | 0.38× | Embind | 1.13× |
| attribute-churn | per setAttribute() | Rust | 3.73 µs | 1.10× | 0.42× | Embind | 1.32× |
| canvas-draw | total | C | 130.89 ms | 0.96× | 0.26× | Embind | 0.65× |
| canvas-draw | total | C++ | 92.84 ms | 0.71× | 0.20× | Embind | 0.46× |
| canvas-draw | total | Rust | 117.13 ms | 1.01× | 0.28× | Embind | 0.58× |
| canvas-draw | per fill_rect() | C | 2.62 µs | 0.96× | 0.26× | Embind | 0.65× |
| canvas-draw | per fill_rect() | C++ | 1.86 µs | 0.71× | 0.20× | Embind | 0.46× |
| canvas-draw | per fill_rect() | Rust | 2.34 µs | 1.01× | 0.28× | Embind | 0.58× |
| canvas-pixels | getImageData(): µs/call | C | 837.20 µs | 1.02× | 0.95× | Embind | 1.72× |
| canvas-pixels | getImageData(): µs/call | C++ | 578.10 µs | 0.85× | 0.65× | Embind | 1.19× |
| canvas-pixels | getImageData(): µs/call | Rust | 831.30 µs | 1.19× | 0.92× | Embind | 1.71× |
| canvas-pixels | putImageData(): µs/call | C | 635.60 µs | 1.05× | 1.38× | Embind | 1.53× |
| canvas-pixels | putImageData(): µs/call | C++ | 437.30 µs | 1.02× | 0.73× | Embind | 1.05× |
| canvas-pixels | putImageData(): µs/call | Rust | 618.60 µs | 1.33× | 0.89× | Embind | 1.49× |
| dom-query | individual: total ms | C | 71.81 ms | 1.11× | 0.29× | Embind | 1.23× |
| dom-query | individual: total ms | C++ | 75.23 ms | 1.17× | 0.29× | Embind | 1.29× |
| dom-query | individual: total ms | Rust | 66.19 ms | 1.16× | 0.31× | Embind | 1.13× |
| dom-query | bulk: total ms | C | 33.70 ms | 1.32× | 0.84× | Embind | 748.78× |
| dom-query | bulk: total ms | C++ | 32.94 ms | 1.31× | 0.76× | Embind | 731.89× |
| dom-query | bulk: total ms | Rust | 32.95 ms | 1.35× | 0.85× | Embind | 732.22× |
| dom-query | individual: µs/element | C | 3.59 µs | 1.11× | 0.29× | Embind | 1.23× |
| dom-query | individual: µs/element | C++ | 3.76 µs | 1.17× | 0.29× | Embind | 1.29× |
| dom-query | individual: µs/element | Rust | 3.31 µs | 1.16× | 0.31× | Embind | 1.13× |
| dom-traversal | build | C | 109.55 ms | 1.20× | 0.26× | EM_JS | 2.71× |
| dom-traversal | build | C++ | 144.15 ms | 1.53× | 0.34× | EM_JS | 3.57× |
| dom-traversal | build | Rust | 124.01 ms | 1.51× | 0.28× | EM_JS | 3.07× |
| dom-traversal | traverse (total) | C | 31.81 ms | 1.53× | 0.18× | EM_JS | 3.77× |
| dom-traversal | traverse (total) | C++ | 40.74 ms | 1.47× | 0.24× | EM_JS | 4.83× |
| dom-traversal | traverse (total) | Rust | 37.96 ms | 1.37× | 0.18× | EM_JS | 4.50× |
| dom-traversal | traverse (per node) | C | 1.63 µs | 1.53× | 0.18× | EM_JS | 3.77× |
| dom-traversal | traverse (per node) | C++ | 2.09 µs | 1.47× | 0.24× | EM_JS | 4.83× |
| dom-traversal | traverse (per node) | Rust | 1.94 µs | 1.37× | 0.18× | EM_JS | 4.50× |
| string-marshalling | set 8 B | C | 1.18 µs | 0.71× | 0.13× | EM_JS | 1.56× |
| string-marshalling | set 8 B | C++ | 1.66 µs | 1.39× | 0.23× | EM_JS | 2.18× |
| string-marshalling | set 8 B | Rust | 1.13 µs | 0.87× | 0.12× | EM_JS | 1.49× |
| string-marshalling | get 8 B | C | 3.45 µs | 0.83× | 0.26× | wasm-bindgen | 10.09× |
| string-marshalling | get 8 B | C++ | 2.54 µs | 0.72× | 0.33× | wasm-bindgen | 7.42× |
| string-marshalling | get 8 B | Rust | 2.82 µs | 0.54× | 0.32× | wasm-bindgen | 8.23× |
| string-marshalling | set 128 B | C | 1.57 µs | 0.98× | 0.18× | wasm-bindgen | 1.72× |
| string-marshalling | set 128 B | C++ | 1.11 µs | 0.88× | 0.15× | wasm-bindgen | 1.22× |
| string-marshalling | set 128 B | Rust | 1.31 µs | 0.71× | 0.20× | wasm-bindgen | 1.43× |
| string-marshalling | get 128 B | C | 4.80 µs | 0.90× | 0.57× | wasm-bindgen | 3.81× |
| string-marshalling | get 128 B | C++ | 4.26 µs | 0.97× | 0.45× | wasm-bindgen | 3.38× |
| string-marshalling | get 128 B | Rust | 3.14 µs | 0.62× | 0.30× | wasm-bindgen | 2.49× |
| string-marshalling | set 1024 B | C | 1.66 µs | 0.80× | 0.17× | wasm-bindgen | 1.32× |
| string-marshalling | set 1024 B | C++ | 2.03 µs | 1.20× | 0.27× | wasm-bindgen | 1.62× |
| string-marshalling | set 1024 B | Rust | 1.65 µs | 0.77× | 0.23× | wasm-bindgen | 1.31× |
| string-marshalling | get 1024 B | C | 7.87 µs | 1.05× | 0.44× | wasm-bindgen | 1.02× |
| string-marshalling | get 1024 B | C++ | 6.66 µs | 0.96× | 0.40× | wasm-bindgen | 0.86× |
| string-marshalling | get 1024 B | Rust | 6.86 µs | 0.85× | 0.49× | wasm-bindgen | 0.89× |
| string-marshalling | set 16384 B | C | 10.56 µs | 0.93× | 0.63× | wasm-bindgen | 0.90× |
| string-marshalling | set 16384 B | C++ | 10.41 µs | 0.98× | 0.66× | wasm-bindgen | 0.88× |
| string-marshalling | set 16384 B | Rust | 13.05 µs | 1.18× | 0.72× | wasm-bindgen | 1.11× |
| string-marshalling | get 16384 B | C | 74.55 µs | 1.06× | 0.78× | wasm-bindgen | 0.56× |
| string-marshalling | get 16384 B | C++ | 72.03 µs | 1.18× | 0.69× | wasm-bindgen | 0.54× |
| string-marshalling | get 16384 B | Rust | 78.28 µs | 1.12× | 0.77× | wasm-bindgen | 0.59× |
| string-marshalling | set 262144 B | C | 413.50 µs | 0.93× | 0.92× | Embind | 2.42× |
| string-marshalling | set 262144 B | C++ | 407.00 µs | 0.98× | 0.92× | Embind | 2.38× |
| string-marshalling | set 262144 B | Rust | 406.25 µs | 0.93× | 0.92× | Embind | 2.38× |
| string-marshalling | get 262144 B | C | 1,142.55 µs | 0.69× | 1.00× | wasm-bindgen | 0.58× |
| string-marshalling | get 262144 B | C++ | 1,162.40 µs | 0.71× | 0.97× | wasm-bindgen | 0.59× |
| string-marshalling | get 262144 B | Rust | 1,218.45 µs | 0.67× | 1.00× | wasm-bindgen | 0.61× |
| table-update | create: total ms | C | 52.28 ms | 1.42× | 0.29× | EM_JS | 4.04× |
| table-update | create: total ms | C++ | 47.72 ms | 1.93× | 0.30× | EM_JS | 3.69× |
| table-update | create: total ms | Rust | 50.03 ms | 1.34× | 0.27× | EM_JS | 3.87× |
| table-update | create: µs/row | C | 26.14 µs | 1.42× | 0.29× | EM_JS | 4.04× |
| table-update | create: µs/row | C++ | 23.86 µs | 1.93× | 0.30× | EM_JS | 3.69× |
| table-update | create: µs/row | Rust | 25.02 µs | 1.34× | 0.27× | EM_JS | 3.87× |
| table-update | update (selected): total ms | C | 3.60 ms | 1.23× | 0.38× | wasm-bindgen | 1.45× |
| table-update | update (selected): total ms | C++ | 3.48 ms | 1.26× | 0.56× | wasm-bindgen | 1.40× |
| table-update | update (selected): total ms | Rust | 3.69 ms | 1.27× | 0.37× | wasm-bindgen | 1.48× |
| table-update | update (selected): µs/row | C | 1.80 µs | 1.23× | 0.38× | wasm-bindgen | 1.45× |
| table-update | update (selected): µs/row | C++ | 1.74 µs | 1.26× | 0.56× | wasm-bindgen | 1.40× |
| table-update | update (selected): µs/row | Rust | 1.85 µs | 1.27× | 0.37× | wasm-bindgen | 1.48× |
| table-update | clear (unselected): total ms | C | 15.11 ms | 1.35× | 0.34× | wasm-bindgen | 2.46× |
| table-update | clear (unselected): total ms | C++ | 15.78 ms | 1.48× | 0.50× | wasm-bindgen | 2.57× |
| table-update | clear (unselected): total ms | Rust | 14.43 ms | 1.39× | 0.32× | wasm-bindgen | 2.35× |
| table-update | clear (unselected): µs/row | C | 7.55 µs | 1.35× | 0.34× | wasm-bindgen | 2.46× |
| table-update | clear (unselected): µs/row | C++ | 7.89 µs | 1.48× | 0.50× | wasm-bindgen | 2.57× |
| table-update | clear (unselected): µs/row | Rust | 7.21 µs | 1.39× | 0.32× | wasm-bindgen | 2.35× |

</details>

### Payload and startup

Payload medians cover 34 component inputs. Compression is per file. Startup is the median of the 21 per-workload and guest medians, from dynamic import through initialization, with browser caching disabled.

| Build | JS (KiB) | Core Wasm (KiB) | Total (KiB) | Gzip (KiB) | Brotli (KiB) | Startup (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1.13.0 | 19.4 | 64.4 | 85.4 | 29.3 | 24.1 | 22.31 |
| Stock main | 180.7 | 64.4 | 252.0 | 57.6 | 47.8 | 53.57 |
| Candidate | 147.5 | 64.4 | 215.7 | 53.5 | 44.5 | 47.31 |

<details><summary>Candidate startup and run-to-run variation by workload</summary>

| Operation | Guest | Startup median (ms) | Warm phase p25 | Warm phase p50 | Warm phase p75 | Phase unit |
| --- | --- | --- | --- | --- | --- | --- |
| Attribute write | C | 49.54 | 2.21 | 3.37 | 3.49 | µs |
| Attribute write | C++ | 49.00 | 2.71 | 3.19 | 3.38 | µs |
| Attribute write | Rust | 47.59 | 2.42 | 3.73 | 3.80 | µs |
| Canvas fillRect | C | 53.13 | 2.56 | 2.62 | 2.73 | µs |
| Canvas fillRect | C++ | 47.22 | 1.79 | 1.86 | 2.66 | µs |
| Canvas fillRect | Rust | 38.64 | 1.96 | 2.34 | 2.44 | µs |
| Canvas pixel read | C | 49.03 | 734.40 | 837.20 | 865.95 | µs |
| Canvas pixel read | C++ | 50.32 | 516.95 | 578.10 | 850.60 | µs |
| Canvas pixel read | Rust | 45.85 | 816.55 | 831.30 | 841.85 | µs |
| DOM ID lookup | C | 48.41 | 3.21 | 3.59 | 3.81 | µs |
| DOM ID lookup | C++ | 47.31 | 3.18 | 3.76 | 3.97 | µs |
| DOM ID lookup | Rust | 44.94 | 2.59 | 3.31 | 3.69 | µs |
| Tree traversal | C | 41.57 | 30.67 | 31.81 | 36.63 | ms |
| Tree traversal | C++ | 42.16 | 37.82 | 40.74 | 41.62 | ms |
| Tree traversal | Rust | 38.66 | 34.57 | 37.96 | 42.77 | ms |
| Read 1 KiB string | C | 39.51 | 6.62 | 7.87 | 8.99 | µs |
| Read 1 KiB string | C++ | 45.18 | 6.55 | 6.66 | 7.40 | µs |
| Read 1 KiB string | Rust | 34.16 | 6.21 | 6.86 | 8.24 | µs |
| Table creation | C | 49.99 | 43.16 | 52.28 | 53.23 | ms |
| Table creation | C++ | 49.15 | 34.71 | 47.72 | 52.46 | ms |
| Table creation | Rust | 48.41 | 39.87 | 50.03 | 54.90 | ms |

</details>

[Raw browser timings](web/bench/results/candidate-browser.json) · [File sizes, digests and generator revision](web/bench/results/candidate-sizes.json)

### Reproduce the candidate run

Run the dependency installation, main setup and size commands in [Reproduce the comparison](#reproduce-the-comparison), then run the following from the repository root. Cargo uses the Jco checkout’s pinned toolchain and lockfile.

```sh
git clone https://github.com/vados-cosmonic/jco ../jco-candidate
git -C ../jco-candidate checkout ac28d5d481f3cfca94bc4c62f3571511c19386d9
node web/bench/candidate.mjs ../jco-candidate
CHROME_BIN=/path/to/chrome BENCH_CANDIDATE=1 ROUNDS=7 node web/bench/browser.mjs
python3 web/bench/candidate-report.py
```

<!-- candidate:end -->

<!-- benchmark:start -->

## Browser performance

**jco 1.13.0 vs. main at `16f8fe48`** · 2026-11-25 · HeadlessChrome/156.0.8078.47 · Intel(R) Xeon(R) Processor @ 2.60GHz · linux 6.12.111 x64 · Node v26.13.0. [Upstream commit](https://github.com/bytecodealliance/jco/commit/16f8fe4805367bb5591f2fc23e7fbe42de61cff5) · [Transpiler build](https://github.com/bytecodealliance/jco/actions/runs/45650406951)

Across the seven operations below and three guest languages, main took longer in **19 of 21** median comparisons. The highest ratio was **8.10×** for the Rust guest in `dom-traversal`.

For 256 KiB string reads, the median time on main changed by -22% to -17% across the three guest languages. The phase tables below include every tested string size.

Each cell is the median of 7 fresh-page samples. The chart divides main’s median time by 1.13.0’s for the same guest and operation. A value below 1× means main finished faster.

![Median time on main divided by baseline time for seven operations and three guest languages](web/bench/results/runtime.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 1.05 | 3.98 | — | — | 4.26 | 17.01 | 3.98 | 16.26 | 4.30 | 15.47 |
| Canvas fillRect (µs) | 6.57 | 11.18 | — | — | 7.61 | 34.28 | 6.48 | 32.25 | 5.83 | 28.21 |
| Canvas pixel read (µs) | 546.40 | 618.60 | — | — | 1,447.50 | 1,446.90 | 986.90 | 1,400.90 | 1,268.10 | 1,219.40 |
| DOM ID lookup (µs) | 1.05 | 4.23 | — | — | 4.38 | 21.75 | 4.58 | 19.63 | 4.03 | 22.41 |
| Tree traversal (ms) | 2.54 | 102.14 | 13.94 | 25.09 | 74.37 | 465.89 | 60.09 | 413.75 | 69.02 | 559.05 |
| Read 1 KiB string (µs) | 0.285 | 34.59 | 29.75 | 15.08 | 15.29 | 29.93 | 14.60 | 28.79 | 13.68 | 29.64 |
| Table creation (ms) | 12.44 | 56.12 | 18.09 | 28.34 | 47.73 | 245.03 | 47.99 | 246.06 | 41.24 | 272.12 |

Embind and EM_JS are the C++ Emscripten variants. An em dash marks an unavailable combination. Across toolchains, the upstream implementations can do different amounts of work. For example, the JavaScript bulk DOM query obtains a live collection while the component host materializes a list.

<details><summary>Run-to-run variation for the two jco versions</summary>

Each cell spans the 25th to 75th percentile of measured times, using linear interpolation between sorted samples.

| Operation | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Attribute write (µs) | 3.86–4.55 | 14.93–17.31 | 3.68–4.78 | 13.90–19.12 | 4.17–4.41 | 14.44–18.28 |
| Canvas fillRect (µs) | 4.28–8.09 | 23.43–39.23 | 4.93–8.71 | 21.87–36.10 | 4.27–8.93 | 18.46–35.32 |
| Canvas pixel read (µs) | 1,018.15–2,797.50 | 1,287.80–1,505.35 | 826.40–1,966.55 | 1,321.25–2,641.60 | 1,045.30–1,380.30 | 1,069.55–1,338.45 |
| DOM ID lookup (µs) | 4.19–5.16 | 20.26–23.40 | 4.14–4.74 | 18.58–20.47 | 3.82–4.87 | 19.28–24.17 |
| Tree traversal (ms) | 50.12–76.17 | 408.15–562.53 | 48.75–82.86 | 392.07–495.23 | 57.57–80.11 | 519.82–733.05 |
| Read 1 KiB string (µs) | 13.26–15.97 | 28.17–33.78 | 13.92–15.87 | 27.66–31.29 | 13.01–17.37 | 27.16–31.30 |
| Table creation (ms) | 39.13–49.41 | 227.01–256.26 | 44.99–53.28 | 238.22–280.87 | 39.35–45.77 | 250.83–277.61 |

</details>

<details><summary>All workload phases, per-call timings, and string transfer rates</summary>

Times come from the tables rendered by the demos and retain their original reporting precision. Effective string throughput uses the ASCII payload length divided by median call time (decimal MB/s).

**attribute-churn**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total time (ms) | 84.30 | 318.58 | — | — | 341.02 | 1,361.14 | 318.17 | 1,300.98 | 344.02 | 1,237.83 |
| per setAttribute() (µs) | 1.05 | 3.98 | — | — | 4.26 | 17.01 | 3.98 | 16.26 | 4.30 | 15.47 |

**canvas-draw**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| total (ms) | 328.54 | 558.84 | — | — | 380.33 | 1,714.12 | 323.78 | 1,612.60 | 291.23 | 1,410.73 |
| per fill_rect() (µs) | 6.57 | 11.18 | — | — | 7.61 | 34.28 | 6.48 | 32.25 | 5.83 | 28.21 |

**canvas-pixels**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| getImageData() (µs) | 546.40 | 618.60 | — | — | 1,447.50 | 1,446.90 | 986.90 | 1,400.90 | 1,268.10 | 1,219.40 |
| putImageData() (µs) | 35.90 | 492.70 | — | — | 783.70 | 976.90 | 702.80 | 923.10 | 713.10 | 877.50 |

**dom-query**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| individual, total (ms) | 20.96 | 84.60 | — | — | 87.58 | 434.99 | 91.59 | 392.62 | 80.55 | 448.27 |
| bulk, total (ms) | 0.03 | 0.055 | — | — | 38.05 | 59.67 | 32.80 | 56.66 | 46.48 | 59.23 |
| individual: µs/element (µs) | 1.05 | 4.23 | — | — | 4.38 | 21.75 | 4.58 | 19.63 | 4.03 | 22.41 |

**dom-traversal**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| build (ms) | 47.33 | 177.09 | 67.39 | 99.23 | 232.52 | 1,257.25 | 245.89 | 1,038.62 | 266.30 | 1,021.19 |
| traverse (total) (ms) | 2.54 | 102.14 | 13.94 | 25.09 | 74.37 | 465.89 | 60.09 | 413.75 | 69.02 | 559.05 |
| traverse (per node) (µs) | 0.13 | 5.23 | 0.714 | 1.28 | 3.81 | 23.85 | 3.08 | 21.18 | 3.53 | 28.62 |

**string-marshalling**

![Median DOM textContent set and get latency by payload length for each guest and jco version, on logarithmic axes](web/bench/results/strings.png)

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| set 8 B (µs) | 0.542 | 4.84 | 1.18 | 1.60 | 2.42 | 34.94 | 2.70 | 41.70 | 2.28 | 37.40 |
| set 8 B (MB/s) | 14.76 | 1.65 | 6.79 | 5.00 | 3.30 | 0.229 | 2.96 | 0.192 | 3.50 | 0.214 |
| get 8 B (µs) | 0.202 | 3.46 | 0.856 | 0.852 | 7.17 | 27.89 | 7.97 | 29.43 | 7.92 | 33.69 |
| get 8 B (MB/s) | 39.60 | 2.31 | 9.35 | 9.39 | 1.12 | 0.287 | 1.00 | 0.272 | 1.01 | 0.237 |
| set 128 B (µs) | 0.876 | 4.58 | 2.22 | 1.69 | 2.86 | 16.29 | 2.81 | 14.49 | 2.63 | 15.09 |
| set 128 B (MB/s) | 146.12 | 27.95 | 57.74 | 75.96 | 44.69 | 7.86 | 45.47 | 8.83 | 48.67 | 8.48 |
| get 128 B (µs) | 0.235 | 6.85 | 3.83 | 3.05 | 7.78 | 29.86 | 9.74 | 27.24 | 7.64 | 31.50 |
| get 128 B (MB/s) | 544.68 | 18.68 | 33.45 | 41.95 | 16.46 | 4.29 | 13.14 | 4.70 | 16.75 | 4.06 |
| set 1024 B (µs) | 3.09 | 4.71 | 7.53 | 2.62 | 3.66 | 15.86 | 3.31 | 18.23 | 4.07 | 16.08 |
| set 1024 B (MB/s) | 331.61 | 217.64 | 136.03 | 390.69 | 279.48 | 64.58 | 309.09 | 56.19 | 251.47 | 63.68 |
| get 1024 B (µs) | 0.285 | 34.59 | 29.75 | 15.08 | 15.29 | 29.93 | 14.60 | 28.79 | 13.68 | 29.64 |
| get 1024 B (MB/s) | 3,592.98 | 29.61 | 34.42 | 67.90 | 66.98 | 34.22 | 70.14 | 35.56 | 74.88 | 34.55 |
| set 16384 B (µs) | 38.76 | 20.24 | 88.72 | 16.68 | 17.34 | 31.00 | 17.25 | 37.12 | 16.39 | 33.24 |
| set 16384 B (MB/s) | 422.70 | 809.33 | 184.66 | 982.20 | 944.98 | 528.52 | 949.80 | 441.32 | 999.76 | 492.93 |
| get 16384 B (µs) | 1.32 | 440.75 | 425.10 | 232.25 | 108.50 | 165.40 | 112.60 | 182.35 | 104.10 | 183.55 |
| get 16384 B (MB/s) | 12,383.98 | 37.17 | 38.54 | 70.54 | 151.00 | 99.06 | 145.51 | 89.85 | 157.39 | 89.26 |
| set 262144 B (µs) | 500.62 | 748.35 | 1,363.60 | 682.40 | 680.65 | 711.75 | 705.20 | 748.55 | 696.80 | 689.40 |
| set 262144 B (MB/s) | 523.63 | 350.30 | 192.24 | 384.15 | 385.14 | 368.31 | 371.73 | 350.20 | 376.21 | 380.25 |
| get 262144 B (µs) | 39.53 | 6,934.45 | 6,879.20 | 3,659.70 | 2,808.70 | 2,194.90 | 2,800.35 | 2,257.85 | 2,821.55 | 2,350.45 |
| get 262144 B (MB/s) | 6,631.35 | 37.80 | 38.11 | 71.63 | 93.33 | 119.43 | 93.61 | 116.10 | 92.91 | 111.53 |

**table-update**

| Operation | JS | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create, total (ms) | 12.44 | 56.12 | 18.09 | 28.34 | 47.73 | 245.03 | 47.99 | 246.06 | 41.24 | 272.12 |
| create, per row (µs) | 6.22 | 28.06 | 9.04 | 14.17 | 23.87 | 122.51 | 24.00 | 123.03 | 20.62 | 136.06 |
| update (selected), total (ms) | 1.55 | 3.69 | 3.17 | 3.08 | 3.29 | 10.94 | 3.77 | 11.23 | 2.88 | 12.10 |
| update (selected), per row (µs) | 0.778 | 1.85 | 1.59 | 1.54 | 1.64 | 5.47 | 1.88 | 5.62 | 1.44 | 6.05 |
| clear (unselected), total (ms) | 4.38 | 12.62 | 9.98 | 7.46 | 14.76 | 55.52 | 15.23 | 63.72 | 9.42 | 55.46 |
| clear (unselected), per row (µs) | 2.19 | 6.31 | 4.99 | 3.73 | 7.38 | 27.76 | 7.62 | 31.86 | 4.71 | 27.73 |

</details>

<details><summary>Module load and initialization, median milliseconds</summary>

Elapsed browser time for dynamic import through instantiation, with the shared demo host already loaded. The browser process is reused, each page has HTTP caching disabled, and assets are served uncompressed over loopback. These timings include scheduling and local requests. JS is already loaded by the harness.

| Workload | Embind | EM_JS | wasm-bindgen | C 1.13.0 | C main | C++ 1.13.0 | C++ main | Rust 1.13.0 | Rust main |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| attribute-churn | 59.01 | — | — | 47.10 | 89.65 | 54.48 | 101.47 | 43.62 | 93.15 |
| canvas-draw | 127.95 | — | — | 90.98 | 131.96 | 102.32 | 182.47 | 96.09 | 167.13 |
| canvas-pixels | 48.87 | — | — | 44.13 | 94.12 | 43.53 | 102.23 | 56.65 | 79.47 |
| dom-query | 66.30 | — | — | 49.58 | 108.97 | 61.03 | 88.98 | 46.16 | 91.76 |
| dom-traversal | 102.20 | 55.72 | 46.20 | 60.26 | 138.47 | 59.70 | 134.84 | 75.63 | 125.26 |
| string-marshalling | 57.71 | 31.23 | 35.22 | 35.44 | 99.14 | 40.43 | 95.75 | 45.95 | 82.01 |
| table-update | 39.66 | 31.86 | 29.08 | 34.11 | 87.07 | 38.84 | 72.68 | 34.95 | 81.02 |

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
