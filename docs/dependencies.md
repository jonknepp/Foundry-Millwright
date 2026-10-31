# Dependencies and licensing

This inventory describes **direct, known dependencies** of the current source-based deployment. It is not a complete bill of materials or a verified list of all licenses in built container images. Refer to the source manifests, resolved lockfiles, and image SBOMs for exact versions and transitive dependencies.

## Containers and infrastructure

| Component | Where used | Licensing model | Source |
| --- | --- | --- | --- |
| Foundry Virtual Tabletop | Licensed application obtained by operator | Proprietary; separate Foundry license required | https://foundryvtt.com/ |
| felddy/foundryvtt | Upstream Foundry container wrapper | MIT (wrapper; **not** Foundry application) | https://github.com/felddy/foundryvtt |
| Caddy | Gateway runtime | Apache-2.0 | https://github.com/caddyserver/caddy |
| xcaddy | Gateway build tool | Apache-2.0 | https://github.com/caddyserver/xcaddy |
| caddy-security | Compiled into Gateway | Apache-2.0; verify selected version | https://github.com/greenpau/caddy-security |
| caddy-dns/duckdns | Compiled into Gateway | MIT; verify selected version | https://github.com/caddy-dns/duckdns |
| Node.js | Service build/runtime | MIT-based with separately licensed components | https://nodejs.org/ |
| Alpine Linux | Service image OS | Multiple package-specific licenses | https://alpinelinux.org/ |
| Docker Compose | Host orchestration | Apache-2.0 | https://github.com/docker/compose |
| Docker Desktop | Supported Windows host environment | Docker subscription/service agreement; free use subject to eligibility | https://www.docker.com/legal/docker-subscription-service-agreement/ |

## Direct Service dependencies

Declared in `middleware/package.json`; versions below are semver ranges, not necessarily the exact resolved versions.

| Package | Declared version | Role | Project license |
| --- | --- | --- | --- |
| fastify | ^5.0.0 | HTTP framework | MIT |
| zod | ^4.0.0 | Schema validation | MIT |
| socket.io-client | ^4.8.1 | Socket.IO client | MIT |
| @types/node (dev) | ^22.0.0 | Node type definitions | MIT |
| tsx (dev) | ^4.0.0 | TypeScript execution/testing | MIT |
| typescript (dev) | ^5.0.0 | Compiler | Apache-2.0 |

SQLite is used by the Service. SQLite's core is public domain; check the actual runtime/library packages and their licenses in the resolved image.

## External services

These services are **not redistributed** as Millwright software:

- [Discord](https://discord.com/developers/docs/) — OAuth2 and API access subject to Discord's terms and developer policies.
- [DuckDNS](https://www.duckdns.org/) — DNS hosting and update API subject to service terms.
- [Let's Encrypt](https://letsencrypt.org/repository/) — ACME certificate issuance subject to the applicable subscriber agreement.

## Distribution compliance checklist

Before a public image release:

1. Resolve and pin the exact base images, Caddy modules, and npm dependency versions.
2. Generate per-image SBOMs (CycloneDX JSON preferred) from the **built** Gateway and Service images and any future Setup image.
3. Review transitive npm, Go, OS, and other bundled components for license obligations.
4. Include required copyright/license texts and notices in release distributions as applicable.
5. Record source revisions, image digests, and relevant third-party attribution.
6. Confirm Foundry proprietary binaries are not included in Millwright-distributed images or archives.
7. Document Docker Desktop licensing eligibility and any other host prerequisites.

See [third-party notices](../THIRD_PARTY_NOTICES.md). Neither this inventory nor an SBOM alone establishes full license compliance.
