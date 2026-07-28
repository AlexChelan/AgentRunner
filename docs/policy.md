# Policy and confinement

Each paired backend has a capability ceiling OpenCompanion enforces on every run it dispatches: a
permission mode (`read-only`, `auto-edit`, or `full`) that caps what a run may do to files, and a
network setting (`on` or `off`). The ceiling is a maximum, not a target - a backend can request a run
at or below it, OpenCompanion clamps anything higher down to the ceiling, and a backend can never
raise it. Every run is also confined to a single `work/<product>/` folder, and any MCP server a
backend tries to push is dropped - both enforced by the daemon on your machine, not trusted to the
backend.

```sh
opencompanion policy show                                # per-backend ceiling, network, and work folder
opencompanion policy set --url https://your-saas.example/api --permission-mode read-only --network off
```
