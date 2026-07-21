# Local transformer benchmark receipt — 2026-07-16

Status: **run** against the child-backed `minilm:Xenova/all-MiniLM-L6-v2:q4:384:cosine`
backend. The command used the isolated disk-backed model cache in this worktree,
performed one untimed warm-up per work limit, then recorded two 100-record
rounds at each limit. The complete machine-readable receipt is adjacent at
`local-transformer-benchmark-2026-07-16.json`.

| work limit | round 1 | round 2 | reported median | output | equality | child high-water | peak parent + child RSS |
| --- | ---: | ---: | ---: | --- | --- | ---: | ---: |
| 1 | 1342 ms | 1324 ms | 1333 ms | 100 × 384 | yes | 1 | 380,829,696 B |
| 2 | 1176 ms | 1257 ms | 1216.5 ms | 100 × 384 | yes | 2 | 343,068,672 B |
| 4 | 1310 ms | 1236 ms | 1273 ms | 100 × 384 | yes | 4 | 340,017,152 B |
| 8 | 1284 ms | 1259 ms | 1271.5 ms | 100 × 384 | yes | 8 | 338,210,816 B |

Every round reported zero errors, exact vector equality with the one-worker
baseline, full cardinality, and actual child high-water equal to its requested
limit. No higher limit cleared the receipt policy (at least 15% faster than one
while within 10% of the fastest median), so the safest default is **one**. The
receipt samples parent RSS and child `/proc/<pid>/status` RSS while jobs run;
combined RSS is their sampled sum, not a claim of an atomic kernel snapshot.
