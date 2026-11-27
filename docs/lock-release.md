# Reentrant lock release

[Benchmark overview](../README.md)

### Local checkpoint for reentrant lock release

On the fork PR at `fe136cf1a`, a callback that acquires and releases the guest lock again can cause a later callback to run twice for one registration. The local FIFO change at `81c0d5d61` advances a shared cursor before invoking each callback. The inline Rust-generated bindings and checked runtime implement the same ordering. The runtime has a regression test for duplicate registrations, reentry, new registrations during release and a callback that throws. The final FIFO revision is local and its full demo matrix is pending.

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
