# Pairing

Pairing links OpenCompanion on this machine to one SaaS backend using RFC 8628 device authorization:
OpenCompanion asks the backend to start a grant, you approve it in your browser while signed in to
that SaaS, and the daemon stores the resulting session bearer locally (encrypted). No API key is
copied or pasted, and the backend never sees a credential of yours. A pairing dispatches nothing
until you connect a coding CLI to it, and you can pair with more than one backend.

```sh
opencompanion pair --url https://your-saas.example/api   # link this machine to a backend
opencompanion connect                                    # detect, install, and log in your CLIs
opencompanion backends                                   # device id, connected CLIs, ceiling, daemon state
```
