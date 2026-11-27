# Reentrant lock release

[Benchmark overview](../README.md)

## Why the runtime needs a shared cursor

On the fork PR at `fe136cf1a`, a callback that acquires and releases the guest lock again can cause a later callback to run twice for one registration. The FIFO follow-up at `81c0d5d61` advances a shared cursor before invoking each callback. The inline Rust-generated bindings and checked runtime implement the same ordering. The runtime has a regression test for duplicate registrations, reentry, new registrations during release and a callback that throws. The exact head passed 527 checked runtime tests, 197 Rust tests with internal bundling, 177 Rust tests with the external configuration, 71 integration fixtures and the embedded runtime consistency check. [FIFO follow-up PR](https://github.com/vados-cosmonic/jco/pull/65)

| Callbacks registered per release | Previous runtime, ns | FIFO runtime, ns | Paired FIFO / previous (individual 95% interval) |
| ---: | ---: | ---: | ---: |
| 0 | 36.39 | 19.54 | 0.476 (0.439–0.622) |
| 1 | 114.25 | 136.68 | 1.174 (0.981–1.427) |
| 4 | 253.45 | 170.44 | 0.680 (0.607–0.886) |
| 32 | 1,464.84 | 673.22 | 0.524 (0.381–0.551) |

Each timing includes acquiring the lock, registering that number of callbacks and releasing the lock. Sixteen independent Chromium processes exercised both checked package revisions. The probe also checked callback order outside the timed loop. The earlier set-based trial at `c19b56e82` took 2.64× the previous runtime's time with 32 callbacks. Its full demo run covers only that intermediate revision. [FIFO samples](../web/bench/results/lock-release-fifo-81c0d5d61.json.gz) · [FIFO package hashes](../web/bench/results/lock-release-fifo-assets-81c0d5d61.json.gz) · [Set trial](../web/bench/results/lock-release-set-c19b56e82.json.gz) · [Set-trial full matrix](../web/bench/results/lock-release-set-matrix-c19b56e82.json.gz)

To verify the FIFO results from the benchmark root, run the following command. To repeat the Chromium measurements, pass the same package inventory, the previous and new runtime dist directories and a fresh output path to `node web/bench/lock-release.mjs` with `CHROME_BIN` set.

```sh
python3 web/bench/lock-release-report.py web/bench/results/lock-release-fifo-81c0d5d61.json.gz web/bench/results/lock-release-fifo-assets-81c0d5d61.json.gz
```

## Independent callback repeat on the full-matrix assets

Sixteen more Chromium processes exercised the exact FIFO runtime and its preceding package. The direction and intervals repeat for zero and 32 callbacks. At one callback the repeat estimate was 16.8% slower, close to the first estimate of 17.4%. Both individual intervals include parity. Four callbacks were faster in the first trial, while the repeat interval included parity. No application-wide warm or first-result improvement was established by the paired matrix. [Repeat samples](../web/bench/results/lock-release-fifo-repeat-81c0d5d61.json.gz) · [Full browser matrix and controls](browser-performance.md#fifo-follow-up-on-pr-65)

| Callbacks | Preceding runtime, ns | FIFO runtime, ns | Paired FIFO / preceding time (individual 95% interval) |
| ---: | ---: | ---: | ---: |
| 0 | 49.96 | 26.58 | 0.535 (0.477–0.642) |
| 1 | 152.13 | 175.13 | 1.168 (0.930–1.295) |
| 4 | 340.88 | 280.00 | 0.744 (0.598–1.031) |
| 32 | 1,857.91 | 983.89 | 0.499 (0.387–0.611) |

```sh
python3 web/bench/lock-release-report.py web/bench/results/lock-release-fifo-repeat-81c0d5d61.json.gz web/bench/results/review-matrix-fifo-81c0d5d61.json.gz
```
