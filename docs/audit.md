# The audit log

AgentRunner keeps a local, append-only audit log of everything it does, authored by the daemon. No
backend can write to it, edit it, or read it. Every dispatched run is written to the log BEFORE it
executes, and the write is a hard precondition: if the entry cannot be durably written, the run does
not run - so no backend can cause a run that leaves no trace. Your prompt text is never written to
the log, only its SHA-256, so you can confirm which prompt ran without the log storing your
instructions or code.

```sh
agentrunner log                                        # newest 50 entries, pretty, oldest-first
agentrunner log --json | jq .                          # raw JSONL for piping
```
