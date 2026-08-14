# Confinement and what a backend can ask for

A dispatched run is floored structurally, not by a setting you tune. Whatever a backend asks for, the
run gets no file access, no shell, and no local MCP servers, and any MCP server the backend tries to
push is dropped. AgentRunner enforces this on your machine rather than trusting the backend to
ask nicely, and there is no configuration that raises it.

Every run is also confined to a single `work/<product>/` folder. The rest of your machine, including
AgentRunner's own state and secrets, is off-limits.

Network is the one capability a run can obtain: a dispatched run that ASKS for egress gets it, so
your coding CLI keeps its own web tools. A run that asks for nothing stays off the network.

A dispatched Codex run is REFUSED outright where its sandbox is not enforced by the operating
system, so an unconfined run is not something a backend can ask for.

## Refusing work outright

What you DO control is whether this machine accepts a class of work at all, per backend:

```sh
agentrunner origin show                                # automation / app-dispatched: allowed or refused
agentrunner origin set --url https://your-saas.example/api --automation deny --dispatch deny
```

A chat turn is your own request and always runs. `--automation deny` refuses runs a backend fires on a
schedule; `--dispatch deny` refuses runs its product code starts. Both default to allowed, and
unpairing removes the backend's access entirely.

A terminal session is you at your own keyboard, so it is deliberately not floored the same way.
`agentrunner approvals set --mode prompt|bypass` decides whether your CLI keeps its own
approval prompts there.
