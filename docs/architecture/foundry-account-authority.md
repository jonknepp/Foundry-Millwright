# Foundry account authority and integration trust boundaries

## Responsibilities

**Foundry VTT** is authoritative for world user accounts, roles, and native permissions. Foundry's own authenticated GM operations create, modify, and delete accounts. Millwright does not directly edit Foundry user data files.

**Millwright Module** provides the GM-facing account-management and Discord-linking interface within an active Foundry world. It uses Foundry's native user APIs under the authenticated GM's browser context to manage Foundry users. Through an explicit GM-initiated configuration action, the Module also provisions the dedicated Millwright service account using the authorized GM's Foundry context.

**Millwright Service** persists Discord-to-Foundry account associations, authorizes access based on authenticated Discord identities, and orchestrates Foundry sessions. It securely stores the provisioned service-account credentials and uses its integration with Foundry for session operations such as `loginAs`. It does **not** create or administer ordinary Foundry user accounts.

**Millwright Gateway** authenticates the Discord identity and enforces the Service's ingress decisions before allowing access to Foundry. A Foundry session cookie alone must not bypass the Gateway.

Millwright Dashboard administrator authorization is distinct from Foundry GM permissions. A client-reported Foundry role does not grant Dashboard administrator access.

## Trust boundaries

- The Module runs in connected browsers. Browser-supplied world IDs, user IDs, GM roles, or session observations are **not** trusted server-to-server assertions and must not independently authorize privileged Service operations.
- The Gateway authenticates the Discord identity before forwarding it to the Service. The Service verifies the Gateway-held proxy secret; callers must not be able to spoof the authenticated identity by supplying headers directly.
- The dedicated `foundry-control` Docker network provides isolation, **not** application authentication.
- Foundry service-account credentials and integration secrets must never be sent to browser clients. Credentials stored by the Service must be protected at rest.
- Do not reuse the Gateway-to-Service proxy secret as a Foundry integration credential.
- Privileged operations must be authorized server-side and fail closed on authentication, integration, or service failure.
- The service account is not an ordinary player account and must not be offered for Discord linking or normal user deletion.

## Discord mapping and Foundry session authority

The Service's mapping associates an authenticated Discord user ID with a Foundry user ID in a particular world. The mapping is an **eligibility record**, not a Foundry login session or a grant of Foundry-native permissions.

The Service uses the mapped account when requesting Foundry session creation through `loginAs`. Only successful Foundry authentication can produce an authenticated Foundry session. A mapping alone cannot do so.

If a mapped Foundry account has been deleted, `loginAs` fails and no authenticated Foundry session is returned to that Discord user. The stale mapping is an operational issue that administrators can resolve through the Module or the Service's account synchronization and mapping administration.

The Service currently retrieves Foundry account IDs, display names, and roles to support the Dashboard's mapping review, account validation, and synchronization workflows. These operational capabilities are retained. They help administrators verify which Foundry accounts and permission levels are associated with Discord identities, but they do not make the Service authoritative for Foundry accounts or permissions.

## Service-account provisioning

The dedicated integration account is provisioned by the Module using Foundry's native account APIs under an authenticated GM browser session when the GM explicitly initiates provisioning. The Service does not independently provision that Foundry account. Provisioning completion verifies the service account's ability to authenticate to Foundry before storing its encrypted credentials.

The integration account is used for authorized session orchestration, not to make the Service the authority over ordinary Foundry accounts. Account provisioning must avoid adopting an unrelated existing account based only on its name; provisioning and recovery must protect existing users and credentials.

## Validation and regression requirements

- Unauthenticated or unauthorized callers cannot invoke privileged Service or Foundry integration operations.
- Browser-reported Foundry identities and roles cannot elevate Service privileges.
- A valid Discord mapping without a corresponding Foundry account fails `loginAs` without returning an authenticated Foundry session.
- A successful `loginAs` establishes only the intended Foundry user's session; concurrent users remain isolated.
- Foundry outages, integration failures, and Service outages fail closed at the relevant authorization boundary.
- Revocation of Millwright access cannot be bypassed by navigating directly to Foundry routes or reusing an existing Foundry cookie.
- Integration credentials are not exposed to players or browser-side module code, and stored secrets remain protected.
- Changes to supported Foundry versions require compatibility tests for service-account provisioning, login/session behavior, and failure recovery.
- Tests should run inside Docker without requiring host Node.js/npm.

This document defines the required authority boundaries; it is not a claim that every listed regression test has already been executed.
