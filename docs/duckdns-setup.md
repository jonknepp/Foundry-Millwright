# DuckDNS setup for Millwright

DuckDNS provides a hostname such as `example-vtt.duckdns.org` that players can use instead of remembering a changing residential IP address. Millwright's current HTTPS configuration also uses DuckDNS for DNS-based certificate validation.

**DuckDNS does not open router ports or make Foundry reachable by itself.** Router connectivity and HTTPS certificate issuance are separate parts of setup.

## What you need

- A web browser and an account with a supported sign-in provider for [DuckDNS](https://www.duckdns.org/).
- PowerShell 7 on the Millwright host.
- An initialized Millwright data directory and a configured `.env` containing `MILLWRIGHT_DATA_DIR`.
- Access to your home router for the separate port-forwarding step.

DuckDNS account creation and domain registration do **not** require Windows Administrator privileges. The DuckDNS token is a credential: do not publish it, paste it into support requests, or include it in screenshots.

## 1. Create a DuckDNS hostname

1. Open [duckdns.org](https://www.duckdns.org/) and sign in using one of the sign-in options shown.
2. On your DuckDNS account page, locate the **domains** area and the field for adding a subdomain.
3. Enter a unique name for your gaming table, **without** the `.duckdns.org` suffix if the page supplies that suffix automatically. For example, enter `example-vtt` to register `example-vtt.duckdns.org`.
4. Select **add domain** (or the equivalent control). If the name is taken, choose another.
5. Confirm the new hostname appears in your DuckDNS domains list.
6. Locate the **token** shown on your account page. You will enter this into Millwright in a later step; treat it as a password.

**Screens and labels can change.** The required result is an active `<name>.duckdns.org` domain associated with your account, plus its API token. A screenshot is not necessary to complete these steps.

## 2. Configure DuckDNS in Millwright

From the directory containing Millwright's scripts, open **PowerShell 7**:

```powershell
Set-Location 'C:\Millwright'
.\scripts\Set-DuckDNSConfig.ps1
```

When prompted:

1. Enter the **full hostname**, for example `example-vtt.duckdns.org`. Do not include `https://`, a port number, or a URL path.
2. Enter your DuckDNS **API token** at the secure prompt.

The script writes `MILLWRIGHT_PUBLIC_HOSTNAME` and `MILLWRIGHT_DNS_PROVIDER=duckdns` to the project-local `.env` and stores the token in the persistent data directory at `secrets/duckdns-token`. It does not print the token.

To change an existing hostname or replace a stored token, run:

```powershell
.\scripts\Set-DuckDNSConfig.ps1 -Reconfigure
```

**What the script does not do:** It does not call DuckDNS, set the public IP address, verify the token, or obtain a TLS certificate. Do not interpret its success message as proof that remote access works.

## 3. Understand DNS updates and HTTPS

A residential internet connection may change its public IP address. DuckDNS needs a current IP record so players' browsers can find your home network.

Millwright's runtime DNS integration and HTTPS certificate workflow must be configured and running for their respective operations to occur. DNS-01 validation proves control of the DuckDNS hostname during certificate issuance; it does **not** prove that inbound traffic can reach the server.

The public hostname used for Discord OAuth2 redirect URIs must match the hostname configured for Millwright. If you change the DuckDNS hostname later, review the Discord application's redirect URI configuration as well.

## 4. Verify DNS resolution

Once the DuckDNS record has been updated with your public IP address, check it from PowerShell:

```powershell
Resolve-DnsName example-vtt.duckdns.org -Type A
```

Replace the example hostname with yours. Compare the returned IPv4 address with the **public WAN IPv4 address** reported by your router. Do not compare it to your computer's private `192.168.x.x` or `10.x.x.x` address.

If the record is missing or stale, check that the hostname was registered, the token is correct, and the DuckDNS updater is running. DNS changes can take time to propagate.

**Do not paste the DuckDNS token into a browser address bar to test it.** URLs containing credentials can leak into history, logs, and screenshots.

## Share the public URL with players

Give players the **Millwright Gateway URL**, not the Foundry container's internal address:

```text
https://<duckdns-hostname>:<external-https-port>/
```

For example, if your DuckDNS hostname is `example-vtt.duckdns.org` and the external HTTPS port is `8443`, share:

```text
https://example-vtt.duckdns.org:8443/
```

If your external HTTPS port is **443**, omit `:443`:

```text
https://example-vtt.duckdns.org/
```

The **external HTTPS port** is the public-facing port configured for router forwarding. It may differ from the Windows host port used by Docker. Do not substitute the Foundry application port, an internal LAN address, or a Docker container port.

Players start at the root URL (`/`); the Gateway handles the Discord sign-in and access routing. They should not need separate Foundry or Millwright administration links.

**If you change the hostname or external HTTPS port**, update the corresponding public Discord OAuth2 redirect URI and verify Millwright's network configuration before sharing the new URL.

## 5. Verify external HTTPS access

After configuring router forwarding and starting Millwright, test the configured **public HTTPS URL and port** from outside your home network, such as a phone with Wi-Fi disabled.

A successful DNS lookup alone is insufficient. You also need a reachable Gateway, valid HTTPS certificate, and functioning OAuth2 routing. The Foundry container's internal port should **not** be forwarded directly to the internet.

If your router's WAN address is private or within `100.64.0.0/10`, your ISP may be using carrier-grade NAT; ordinary port forwarding might not work. Confirm the ISP's connectivity arrangement before troubleshooting DuckDNS.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| DuckDNS hostname is rejected by the script | Enter one complete `<name>.duckdns.org` hostname, without a scheme, port, or slash. |
| Script reports missing `.env` or data directory | Configure `MILLWRIGHT_DATA_DIR` and run Millwright initialization first. |
| Hostname does not resolve | Confirm registration in your DuckDNS account and that a DNS update has occurred. |
| Hostname resolves to the wrong IP | Check the DuckDNS updater and compare against the router's WAN IPv4 address. |
| HTTPS fails despite correct DNS | Check Gateway startup, certificate issuance, router port forwarding, and ISP NAT restrictions. |
| OAuth2 redirect fails after renaming the hostname | Update the public redirect URI in the Discord Developer Portal and relevant Millwright configuration. |

## Permissions and security

- **DuckDNS account access:** Needed to create the hostname and retrieve or rotate its token.
- **Millwright host filesystem access:** Needed to run the configuration script and write its local settings.
- **Router administration:** Needed only for the separate forwarding configuration.
- **Windows Administrator:** Not required just to register a DuckDNS hostname or run `Set-DuckDNSConfig.ps1`, assuming the operator can write the configured files.

Millwright initialization applies Windows filesystem protections to its persistent secrets directory and may request elevation through UAC. The DuckDNS configuration script itself warns that it does not adjust Windows ACLs when writing the token; protect the persistent storage accordingly.

## Continue setup

- [Project overview](../README.md)
- [Downloading and updating Millwright](download-and-installation.md)
- [Discord setup](discord-setup.md)
