# Cache-keepalive scripts

Runners for the prompt-cache keepalive feature and its profiler.

## Credentials

The profiler makes real, paid Anthropic requests. Provide a key either way:

- `export ANTHROPIC_API_KEY=sk-ant-...`, or
- put it in `secret.env` (git-ignored) next to these scripts:
  ```sh
  echo 'export ANTHROPIC_API_KEY="sk-ant-..."' > scripts/cache-keepalive/secret.env
  ```

## Scripts

| Script | Needs key | What it does |
| --- | --- | --- |
| `test.sh` | no | Deterministic keepalive unit tests (fake timers, no network). |
| `profile-quick.sh` | yes | Raw-request profiler, short idle (5s) across baseline/long/keepalive. ~1 min. |
| `profile-ttl.sh` | yes | Raw-request profiler, idle 5s vs 330s to cross Anthropic's ~5-min TTL. ~18 min. |
| `session-quick.sh` | yes | Multi-turn session: 5 rounds of prompt -> real bash wait (20s) -> reply; pings fire (interval 5s). ~2 min. |
| `session-ttl.sh` | yes | Multi-turn session: 2 rounds of real bash wait (330s past the TTL), baseline/long/keepalive. ~33 min. |
| `all.sh` | yes | `test.sh` then `profile-quick.sh`. |

`profile-*.sh` sleep manually between raw provider requests. `session-*.sh` drive
the actual agent loop over multiple rounds: each round the model calls a real
`bash` tool that runs a wait loop, and the loop's keepalive pings fire during that
tool execution. The conversation (and its cached prefix) grows every round, and
each round's resume request is measured (`--turns` controls the count, default 5).

Extra args pass through to `scripts/profile-session.ts`, e.g.:

```sh
scripts/cache-keepalive/profile-quick.sh --prefix-tokens 8000 --runs 3
scripts/cache-keepalive/profile-ttl.sh --idle 5,330,600
```

## Reading the output

Within one idle row, a warm cache keeps `cacheRead` high and `ttft` low. If
`baseline`'s `cacheRead` collapses at a large idle while `long`/`keepalive` hold
it, the cache was being evicted — and keeping it warm helped.

Caveat: this reliably demonstrates **TTL** eviction. **LRU** eviction depends on
the provider's live cache pressure and cannot be reproduced on demand here.
