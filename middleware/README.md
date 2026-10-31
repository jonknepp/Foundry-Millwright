# Millwright Service

The **Millwright Service** is the backend for Discord identity mappings, Foundry session access, session management, and Millwright Dashboard administration. It is implemented in TypeScript using Fastify and SQLite.

The source directory, package name, and Docker Compose service retain the identifier `middleware` for compatibility. **Service** is the user-facing component name.

## Responsibilities

- Receive and verify Discord identity information forwarded by the Millwright Gateway.
- Maintain world-scoped mappings between Discord identities and Foundry user accounts.
- Retrieve Foundry account IDs, display names, and roles to support review and verification of mappings.
- Synchronize account information used by administrative interfaces and mapping validation.
- Determine whether a Discord identity is eligible to establish a Foundry session.
- Orchestrate Foundry session authentication using the dedicated integration account.
- Provide Dashboard administration for mappings, session access, and session termination.
- Persist operational state and securely stored integration credentials.

**The Service administers access to Foundry sessions; it does not administer Foundry user accounts or assign Foundry roles.**

## Component boundaries

| Component | Responsibility |
| --- | --- |
| **Millwright Gateway** | HTTPS ingress, Discord OAuth2, and protected routing |
| **Millwright Service** | Discord-to-Foundry mappings, session access, and Dashboard administration |
| **Millwright Module** | Foundry-native account creation, modification, deletion, role assignment, and integration-account provisioning |
| **Foundry VTT** | Authoritative user records, roles, permissions, and session authentication |

The Module performs account operations through Foundry's native APIs under the appropriate Foundry user authority. The Service stores mappings and integration credentials; it does not independently create ordinary Foundry users.

## Foundry account discovery and synchronization

The Service retrieves the active world's account inventory from Foundry's join interface. Each discovered account includes its **Foundry user ID, display name, and role**.

This information makes the Dashboard's Account Mappings interface useful for session-access administration:

- Identify the Foundry account associated with a Discord identity.
- See whether the target account is a Player, Trusted Player, Assistant GM, or Gamemaster.
- Verify or change mappings before granting access to a Foundry session.
- Investigate access failures or stale mappings.

The current implementation also uses account discovery and synchronization to maintain its account records and validate mappings. Synchronization may reconcile mappings against the accounts Foundry currently reports.

These records support administration and session orchestration; they are **not a separate authority over Foundry accounts or permissions**. Foundry determines whether the target account exists and whether a requested session can be established.

The dedicated Millwright integration account must not be mapped to an ordinary Discord identity. The Service enforces this restriction at the API boundary, not merely in the Dashboard.

## Authentication and trust boundaries

The Gateway authenticates the Discord identity through OAuth2. The Service verifies Gateway-forwarded identity information before using it for access decisions; an untrusted browser-supplied identity or role is not sufficient.

For a mapped user, the Service coordinates authentication to the corresponding Foundry account. A mapping alone does not create an authenticated Foundry session. If Foundry rejects the login, the user does not receive an authenticated Foundry session.

Millwright Dashboard administrator privileges are distinct from Foundry GM privileges. Foundry remains authoritative for in-world roles and permissions.

The Millwright Module provisions the dedicated integration account through Foundry's native APIs. The Service stores and uses its credentials for authorized session operations. Integration credentials and Gateway authentication secrets must not be exposed to browsers or logs.

The Service is reachable on the internal Docker network rather than through a published host port. Network isolation supplements, but does not replace, application-level authorization.

See [Foundry account authority](../docs/architecture/foundry-account-authority.md) for the detailed trust model.

## Deployment and operations

The Service is deployed as part of the Millwright Docker Compose stack. Its Compose service name is `middleware`, and persistent Service data resides beneath `<MILLWRIGHT_DATA_DIR>/middleware/`.

From the repository root, use the supported lifecycle scripts:

```powershell
.\scripts\Start-Millwright.ps1
.\scripts\Stop-Millwright.ps1
```

For updates:

```powershell
.\scripts\Update-Millwright.ps1
```

Follow the root [README](../README.md) and deployment guides for initial configuration, secrets, Gateway routing, and recovery. Avoid independently recreating production containers without accounting for persistent configuration and integration dependencies.

## Development

The Service source is in `middleware/src/`. Its package name is `@millwright/middleware`, and its Node.js engine requirement is version 22 or later.

| Package script | Purpose |
| --- | --- |
| `npm run dev` | Run the TypeScript development watcher |
| `npm run build` | Compile TypeScript |
| `npm run start` | Run the compiled Service |
| `npm run typecheck` | Type-check without emitting files |
| `npm test` | Run the TypeScript regression tests |

The host installation path uses Docker; operators do not need a host Node.js installation.

### Run development checks with Docker (no host Node.js or npm)

From the **repository root** in PowerShell, use an ephemeral Node 22 container with the Service source mounted. This uses the project's declared development dependencies without changing the running production Service:

```powershell
docker run --rm -v "${PWD}/middleware:/app" -w /app node:22-alpine sh -c "npm ci --no-audit --no-fund && npm test && npm run typecheck && npm run build"
```

This command mounts `middleware/` read-write, so `node_modules/` and `dist/` may be created on the host; they are ignored by Git. The container is removed after completion. It does **not** run inside the production `middleware` Compose image, which intentionally omits source files and development dependencies. Docker Desktop must be running.

For a production-image build check, separately run:

```powershell
docker compose --profile middleware build middleware
```


Relevant regression coverage includes Gateway identity validation, administrator authorization, mapping changes, integration-account mapping restrictions, Foundry login success/failure, session expiration and termination, and persistence across container recreation.

## Related documentation

- [Project overview](../README.md)
- [Discord configuration](../docs/discord-setup.md)
- [Foundry account authority](../docs/architecture/foundry-account-authority.md)
- [Millwright Module](../foundry-module/README.md)
