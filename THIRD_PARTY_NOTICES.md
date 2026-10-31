# Third-party notices and acknowledgments

Foundry-Millwright's original code is licensed under the [MIT License](LICENSE), copyright (c) 2026 Jon Knepp.

**This document is a preliminary direct-component inventory, not a complete redistribution notice bundle.** Third-party software retains its own licenses and copyrights. Before publishing compiled container images, review the exact resolved dependencies and include all license texts and notices required by the versions actually shipped.

## Runtime components and upstream projects

| Project | Role | License/model | Upstream |
| --- | --- | --- | --- |
| Foundry Virtual Tabletop | Separately licensed VTT application | Proprietary; operator-supplied license | https://foundryvtt.com/ |
| felddy/foundryvtt | Foundry container wrapper | MIT (wrapper only) | https://github.com/felddy/foundryvtt |
| Caddy | HTTPS Gateway | Apache-2.0 | https://github.com/caddyserver/caddy |
| caddy-security | Gateway authentication extension | Apache-2.0; verify release | https://github.com/greenpau/caddy-security |
| caddy-dns/duckdns | Gateway DNS-01 extension | MIT; verify release | https://github.com/caddy-dns/duckdns |
| Node.js | Millwright Service runtime | MIT-based with third-party components | https://nodejs.org/ |
| Alpine Linux | Container operating system | Mixed package licenses | https://alpinelinux.org/ |
| Fastify | Service HTTP framework | MIT | https://github.com/fastify/fastify |
| Zod | Service validation | MIT | https://github.com/colinhacks/zod |
| Socket.IO client | Service communications | MIT | https://github.com/socketio/socket.io |
| SQLite | Service persistence | Public-domain core; verify bundled bindings | https://www.sqlite.org/ |

## Build and development tools

- [xcaddy](https://github.com/caddyserver/xcaddy) — Apache-2.0; builds the custom Gateway binary.
- [TypeScript](https://github.com/microsoft/TypeScript) — Apache-2.0.
- [tsx](https://github.com/privatenumber/tsx) — MIT.
- [DefinitelyTyped / @types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) — MIT.
- [Docker Compose](https://github.com/docker/compose) — Apache-2.0; host-side orchestration.

## Host software and external services

These are dependencies or integrations, **not components that Millwright itself redistributes**:

- [Docker Desktop](https://www.docker.com/legal/docker-subscription-service-agreement/) — separate subscription/service agreement; free use depends on user and organization eligibility.
- [Discord](https://discord.com/developers/docs/) — authentication and API integration.
- [DuckDNS](https://www.duckdns.org/) — DNS hosting and API.
- [Let's Encrypt](https://letsencrypt.org/repository/) — certificate authority and subscriber agreement.

## Release-time notices

For each published Gateway, Service, or future Setup image, the release process must inventory all included direct and transitive components, preserve the required copyright/license texts and notices, and publish an SBOM. A link to an upstream repository does **not** replace a required bundled license or NOTICE file.

The Foundry container wrapper's permissive license does not grant rights to redistribute the proprietary Foundry VTT application.
