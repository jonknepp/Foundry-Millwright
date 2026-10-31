# Foundry-Millwright

## Purpose and audience

**Foundry-Millwright is a self-hosted stack for running Foundry Virtual Tabletop securely on a home network.** It is designed for game masters and gaming groups who want to host Foundry on an existing computer without dedicated server hardware, shared Millwright infrastructure, or a managed hosting subscription.

Millwright aims to simplify deployment, remote access, player onboarding, session administration, and routine operations while leaving control of Foundry worlds and data with the operator.

## Simple access for players

Players need just **one easy-to-remember URL**, such as `https://example-vtt.duckdns.org:8443/`. Millwright presents the game through an HTTPS Gateway with a publicly trusted TLS certificate and Discord sign-in. Players do not need to know the host computer's IP address, configure port forwarding, install a VPN, or track changes to the host's public IP address. DuckDNS keeps the hostname associated with the host's current public IP address when DNS updates are working.

The GM handles the one-time hosting and networking setup; players open the shared URL in their browsers and authenticate with Discord. If the Gateway is exposed on standard HTTPS port **443**, the address can be even simpler: `https://example-vtt.duckdns.org/`.

## Built around Discord for game night

Many virtual tabletop groups already use Discord for voice communication during their sessions. Millwright builds on that familiar setup rather than introducing another account system for players: the same Discord identity they use with their gaming group is used to sign in to the hosted Foundry experience.

Discord was chosen deliberately as a natural extension of the tools groups already use on game night. Millwright handles access to Foundry through Discord authentication; **voice chat stays in Discord**, with no separate audio bridge or always-running Discord bot required.

## No paid infrastructure required

**Millwright itself requires no paid subscription.** A valid Foundry VTT license is required. Millwright uses free-to-use components and services for self-hosting, including its Gateway, Service, Module, Discord integration, and DuckDNS hostname. Docker Desktop is free only for qualifying use; certain commercial organizations and government users require a paid Docker subscription. See [Docker Desktop's license terms](https://www.docker.com/legal/docker-subscription-service-agreement/).

The operator still supplies a compatible computer, internet connection, and electricity. Normal ISP charges apply, and some home networks may require configuration or ISP assistance to support inbound connections. Foundry licensing remains subject to Foundry's own terms.

## Design goals

- **Accessible self-hosting:** Reduce the setup and operational effort required to run Foundry on an existing home computer.
- **Secure remote access:** Use HTTPS, Discord OAuth2, and an access-controlled Gateway instead of exposing Foundry directly.
- **Identity-based session access:** Associate Discord identities with Foundry accounts in individual worlds, rather than granting access based on a Discord role.
- **Low overhead:** Avoid dedicated hardware, shared services, recurring hosting costs, and unnecessary background processes where practical.
- **Repeatable operations:** Provide scripts for initialization, configuration, startup, shutdown, and updates.
- **Foundry authority:** Keep user accounts, roles, permissions, game systems, worlds, and gameplay under Foundry's control.
- **Extensibility:** Leave room for future GM workflows, content preparation, integrations, and automation without becoming a multi-tenant hosting service.

## How Millwright works

| Component | Implementation | Responsibility |
| --- | --- | --- |
| **Foundry VTT** | Foundry container | Worlds, content, user accounts, roles, permissions, and gameplay |
| **Millwright Gateway** | Caddy | HTTPS, Discord OAuth2, routing, and enforcement of access decisions |
| **Millwright Service** | Node.js / Fastify / SQLite | Discord-to-Foundry mappings, session access, session administration, and operational state |
| **Millwright Module** | Foundry v14 module | GM-facing Foundry account administration, Discord identity linking, and integration-account provisioning |

The Gateway and Service are core stack components. The Module runs within each Foundry world where Millwright integration is enabled.

### Discord authentication and Foundry access

Discord integration is required. Each operator configures their own Discord application and selects the Discord server for their gaming group. Millwright uses OAuth2 to authenticate users and a bot credential for supported Discord member lookups; it does **not** require a continuously running Discord bot process.

Access to a Foundry session is based on an authenticated Discord identity and its world-specific Foundry account mapping. **A Discord server role is not the authorization gate.** Foundry ultimately determines whether the mapped account can establish a session and what permissions that account has inside the world.

The Service Dashboard is used to review mappings and manage session access. The Module provides Foundry-native account creation, deletion, renaming, role changes, and Discord linking.

For implementation details, see the [Service reference](middleware/README.md), [Module reference](foundry-module/README.md), and [account authority model](docs/architecture/foundry-account-authority.md).

## Network and hosting model

Millwright runs behind a residential broadband router. Remote users connect over HTTPS to the Gateway; Foundry's internal port should not be exposed directly to the internet.

Router connectivity can use compatible **UPnP** port mapping or **manual port forwarding**. The current public hostname and TLS workflow use DuckDNS. Inbound connectivity may be unavailable behind carrier-grade NAT or other ISP restrictions.

Millwright does not depend on a shared control plane or a centrally hosted Discord application.

## Supported platforms

**Initial target:** Windows with PowerShell 7 and Docker Desktop configured to use the **WSL2 backend (not Docker VMM)**. The host scripts manage configuration and container lifecycle.

Other Docker Desktop backends, including Hyper-V and Docker VMM, are not part of the initial validated Windows configuration. Linux host support is planned but is not yet a supported release capability.

The GM may run the stack, Discord, and a Foundry browser client on the same computer. Hardware requirements and a clean-install procedure still require release validation.

## Permissions and privileges

Millwright uses separate Windows, Discord, Millwright, and Foundry permission boundaries. Elevated access is needed for particular setup or administrative tasks, **not simply to play in a world**.

| Permission or authority | When it is needed | What it permits |
| --- | --- | --- |
| **Windows administrator** | Installing Docker Desktop, enabling WSL and Virtual Machine Platform if needed, and running Millwright initialization | Prepare the Docker/WSL2 host and apply Millwright's protected filesystem ACLs |
| **Docker Desktop access** | Running, stopping, updating, and inspecting the containers | Operate the stack after Docker Desktop is installed and configured |
| **Discord server owner or management permission** | Authorizing the application's bot installation and selecting the intended server during setup | Configure Discord integration; no Discord access role is used to grant Foundry sessions |
| **Millwright Dashboard administrator** | Administrator bootstrap and subsequent mapping, session-access, and Dashboard operations | Review and manage Discord-to-Foundry mappings and session access |
| **Foundry Gamemaster** | Enabling the Module in a world, managing Foundry users and roles, and explicitly provisioning the integration account | Perform Foundry-native account and world administration |

**These permissions are not interchangeable.** A Foundry Gamemaster is not automatically a Millwright Dashboard administrator, and Dashboard administration does not confer Foundry GM permissions. Discord server permissions do not themselves grant access to a Foundry session.

**Initialization requests Windows Administrator elevation through UAC** to apply filesystem access-control protections. Installing Docker Desktop or enabling WSL and Virtual Machine Platform can also require elevation. Routine configuration, startup, shutdown, and updates should run without an elevated PowerShell window when the operator has the necessary Docker and filesystem permissions. Exact host prerequisites will be verified during clean-install testing.

## Project status

Millwright is being prepared for its initial release. Clean-install and onboarding testing have been performed; crash-recovery verification, security review, and release-readiness checks remain in progress. Treat installation procedures as pre-release until validated.

## Getting started

**Supported pre-release installation path:** install and configure PowerShell 7, Git, and Docker Desktop using the WSL2 backend rather than Docker VMM. Follow Docker Desktop's own WSL2 prerequisites; Millwright imposes no additional WSL2 requirements. Obtain a licensed Foundry VTT Node.js distribution ZIP. Millwright checks dependencies but does not install them.

Clone the repository and run the guided installer from its root:

```powershell
.\Install-Millwright.ps1
```

The installer guides persistent storage, Foundry distribution selection, Discord integration, DuckDNS, networking, validation, and explicit activation. Create the Discord application/bot and DuckDNS account separately. On first activation, complete the Millwright administrator bootstrap in the browser using the challenge shown in the host PowerShell console.

Then complete Foundry license and application configuration, install a game system, create a world and its Gamemaster, enable the bundled Millwright Module, and follow the service-account and Discord account-linking prompts. Enter the Foundry server administrator password in Millwright Integration Settings; this is separate from the world Gamemaster account.

For detailed instructions and the tested workflow, see [Guided installation](docs/guided-installation.md). The [Discord setup guide](docs/discord-setup.md) describes the current identity-based access model; Discord roles are not a session authorization gate. The earlier [initial installation guide](docs/initial-installation.md) documents the standalone initialization phase rather than the complete guided installer.

The guided installation and Foundry/GM/player onboarding have been exercised in a disposable deployment. Normal container restarts and world persistence passed. External access through the public hostname has been verified. Automatic crash recovery remains unverified. This is still a pre-release workflow.

Do not expose Foundry's container port directly as a workaround for Gateway configuration problems.

## Project scope

Millwright aims to streamline the self-hosted Foundry experience, including deployment, security, administration, world preparation, integrations, and potential GM automation. It is not a replacement for Foundry VTT and is not a multi-tenant hosting platform.

Foundry VTT is a separate product and requires the operator to obtain and use it under its licensing terms.

## License and third-party components

Foundry-Millwright's original code is released under the [MIT License](LICENSE), copyright (c) 2026 Jon Knepp. This license does **not** apply to third-party software or to the proprietary Foundry VTT application.

Millwright builds on these upstream projects and services:

| Component | Purpose |
| --- | --- |
| [Foundry Virtual Tabletop](https://foundryvtt.com/) and [felddy/foundryvtt](https://github.com/felddy/foundryvtt-docker) | Licensed VTT application and its separately MIT-licensed Docker wrapper |
| [Caddy](https://caddyserver.com/), [xcaddy](https://github.com/caddyserver/xcaddy), [caddy-security](https://github.com/greenpau/caddy-security), [caddy-dns/duckdns](https://github.com/caddy-dns/duckdns) | Gateway, build tooling, authentication, and DNS-01 support |
| [Node.js](https://nodejs.org/), [Fastify](https://fastify.dev/), [Zod](https://zod.dev/), [Socket.IO](https://socket.io/), [SQLite](https://www.sqlite.org/) | Service runtime, validation, communication, and persistence |
| [Docker Desktop](https://www.docker.com/), [Docker Compose](https://docs.docker.com/compose/), [Alpine Linux](https://alpinelinux.org/) | Host container environment, orchestration, and image operating system |
| [Discord](https://discord.com/), [DuckDNS](https://www.duckdns.org/), [Let's Encrypt](https://letsencrypt.org/) | External identity, DNS, and certificate services |

See [Third-Party Notices](THIRD_PARTY_NOTICES.md) and the [dependency and licensing inventory](docs/dependencies.md) for details. These documents identify known direct components; a full license review and image SBOMs are required before distributing release container images.
