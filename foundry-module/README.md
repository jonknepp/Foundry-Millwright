# Millwright Module

The **Millwright Module** extends Foundry VTT v14 with account administration, Discord identity linking, and integration with the Millwright Service. It is a world-scoped Foundry module, enabled separately for each world.

Foundry remains authoritative for user accounts, roles, permissions, and authentication. The Module uses Foundry's native APIs for account operations; the Service manages Discord-to-Foundry mappings and session access.

## GM account administration

In an active world, a Foundry GM can open **Discord Account Linking** from the Settings sidebar, next to Foundry's native User Management control.

The interface supports:

- Viewing Foundry usernames and roles alongside their Discord associations.
- Creating Foundry accounts with a selected role and linking them to Discord members.
- Linking, changing, and unlinking Discord associations for existing accounts.
- Renaming Foundry users and changing their Foundry roles.
- Deleting eligible Foundry accounts and removing their associated mappings.

The account interface obtains Foundry users directly from `game.users` and retrieves Discord members and saved mappings from the Millwright Service. Mapping changes require Millwright administrator authorization in addition to the Foundry GM requirement for the interface.

The dedicated Millwright service account is excluded from normal account-linking controls. The interface does not offer deletion of the active Foundry user or Gamemaster-role accounts.

### Account creation and recovery

Creating and linking an account performs two distinct operations: Foundry creates the user through `User.create()`, then the Module requests a Discord mapping from the Service.

If Foundry creation succeeds but linking fails, **the Foundry account remains**. The interface offers **Retry linking** rather than creating a duplicate. If a new account is not yet in the Service's inventory, the Module can request account synchronization and retry the mapping.

Deleting an account similarly performs native Foundry deletion first and then removes its mapping. If mapping cleanup fails, the interface directs the administrator to synchronize Foundry accounts in the Dashboard.

## Service account

The Module provides **Game Settings → Millwright → Service Account** for provisioning or completing setup of a dedicated Foundry Gamemaster integration account.

On first world load, the Module offers a native Foundry confirmation dialog to provision the service account. Provisioning occurs only after GM confirmation; declining leaves it available from Game Settings. The provisioning sequence is:

1. The Module requests provisioning details from the Millwright Service.
2. The Module creates the integration account using Foundry's native user API.
3. The Module records the new Foundry user ID in a restricted world setting.
4. The Service verifies the account credentials and completes integration.

If completion fails after account creation, the recorded ID supports retry without creating another account. An existing account is never adopted merely because its name matches.

On world readiness, a GM is prompted to provision an unconfigured service account. After provisioning, the Module optionally offers to link the current Gamemaster to the authenticated Discord administrator. It also offers a guided Discord Account Linking tutorial, which can be replayed through **Game Settings → Millwright → Discord Account Linking Tutorial**.

## Other integration features

### Session observation

When a world finishes loading, the Module reports its world ID and the browser's active Foundry user ID and role to the Service through:

`/millwright/api/worlds/:worldId/session/observe`

This is **client-observed telemetry**, not independent proof of Foundry identity, GM authority, or authorization. The Module does not itself establish player sessions or perform automatic login.

