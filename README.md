<div align="center">
    
#  <a href="https://hub.docker.com/repository/docker/jagtx459/flatline"><img src="https://github.com/jagtx459/Flatline/blob/main/public/assets/Logo.png?raw=true" alt="icon" width="32" height="32"></a> Flatline
###

[![License](https://img.shields.io/github/license/jagtx459/flatline?style=flat-square)](LICENSE) 
[![Last Commit](https://img.shields.io/github/last-commit/jagtx459/flatline?style=flat-square)](https://github.com/jagtx459/flatline/commits/main) 
[![Issues](https://img.shields.io/github/issues/jagtx459/flatline?style=flat-square)](https://github.com/jagtx459/flatline/issues) 
[![Stars](https://img.shields.io/github/stars/jagtx459/flatline?style=flat-square)](https://github.com/jagtx459/flatline/stargazers) 

![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/jagtx459/flatline/ci.yml?style=flat-square&label=Validation%20%26%20Scan)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/jagtx459/flatline/docker-publish.yml?style=flat-square&label=Build%20%26%20Publish%20Image)
![GitHub package.json version](https://img.shields.io/github/package-json/v/jagtx459/flatline?style=flat-square) 
[![Docker Pulls](https://img.shields.io/docker/pulls/jagtx459/flatline?style=flat-square&label=pulls&logo=docker)](https://hub.docker.com/repository/docker/jagtx459/flatline)

</div>
A small self-hosted system monitor that pings or probes endpoints for availability with configurable mechanisms to run scripts in your environment. The intended use is for initiating graceful shutdowns or migrations of infrastructure during a power outage to avoid data corruption and loss.  
<br/>
<div align="center">
    <td>
        <tr><img src="https://github.com/jagtx459/Flatline/blob/main/docs/screenshots/dashboard.png?raw=true" alt="icon" width="340" height="400"> <img src="https://github.com/jagtx459/Flatline/blob/main/docs/screenshots/dashboard-dark.png?raw=true" alt="icon" width="340" height="400"></tr>
    </td> 
</div>
<br/>
<div align="center">
    
****This app is still a work in progress and is intended for homelab and testing environements only, use at your own risk!*** *
</div>

## How it works

1. Each **Flatline Endpoint** is checked on its own interval using ICMP or HTTP(s).
2. An endpoint flips DOWN after N consecutive failures and back UP after M consecutive successes.
3. For an action to arm, endpoints must be placed in a **Flatline Group**. A group fails when configured failure conditions are met; for example either **all** of them or **any** one, per group.

<div align="center"><img src="https://github.com/jagtx459/Flatline/blob/main/docs/screenshots/endpoints.png?raw=true" alt="icon" width="340" height="400"></div>

4. A failing group will arm the grace period. If it recovers before the group's grace period elapses, it disarms; otherwise the group's assigned **Action Group** will run.
5. **Action Groups** are created from **Action Targets** and run in the order you set. **Action Targets** are specific infrastructure for running script(s) against to, for example, shutdown or remove workloads in your environment.

<div align="center"><img src="https://github.com/jagtx459/Flatline/blob/main/docs/screenshots/actions.png?raw=true" alt="icon" width="340" height="400"></div>

### Action target kinds

| Kind | What it does on trigger |
| --- | --- |
| **SSH** | Signs in and runs a command. Password or private key. |
| **WinRM** | Runs a command on a Windows host via remote PowerShell (NTLM). |
| **Kubernetes** | Cordons and drains every node — holding the step open until the cluster is actually empty — or sends a raw API request you define. Bearer token or kubeconfig. |
| **HTTP(S)** | Sends one request you define. For webhooks, or a service with its own shutdown API. |

Each kind also has a **Restore** section that undoes what it did once the outage
is over, either from the target's Restore button or on its own when the Flatline
group recovers. SSH and WinRM can send a Wake-on-LAN packet (directly or through
a relay already on the target's network), wait for the host to answer, then run a
final step.

#### HTTP targets behind a login (2-Step auth)

Some APIs won't accept a static key: you have to authenticate first and use the
CSRF token that comes back. Pick the **2-Step auth** scheme and Flatline will sign
in ahead of each request, read the token out of the response, and send it on.
Because every service does this differently, all of it is configurable — the token
can be read from a path in the JSON body, a response header, or a cookie, and the
session it belongs to travels either in the cookies the login set or in one built
from a field in the response body. The form has worked examples for two common
shapes — UniFi OS, which is confirmed working, and Proxmox VE.

The login happens fresh every time, including on restore, since a token minted
during the outage would have expired by the time the service is back. It also
gives these targets something the others lack: a **safe Test connection**, which
proves the credentials without firing the real request.

TLS verification is set per target, because it is really a per-URL fact — the same
service reached through a reverse proxy presents a trusted certificate, while on a
bare IP it is usually the appliance's own self-signed one. Supply its CA, or
accept an untrusted certificate outright.

## Notifications

Flatline supports a few, but more planned in future releases, notification platforms for event triggers with basic template support for messages. Currently supported platforms are:
- Discord
- Ntfy
- Apprise

## Security **Please Read!* *

****Again, Flatline is still a work in progress and intended for homelab use; do NOT expose to the internet!*** *

- **Optional, but recommended login**: set a password on the `/config` page or via `FLATLINE_PASSWORD` (which overides when both are set). 

- **Non-root container**: the image runs as the unprivileged `node` user; only the `iputils` ping binary gets `cap_net_raw` so ICMP checks work without root.

- **Credentials**: Infrastructure credentials  (passwords, SSH keys, tokens, kubeconfigs, webhook URLs) are encrypted at rest with AES-256-GCM and are write-only through the API. The server only reports *which* fields are set, never their values. The key comes from `FLATLINE_SECRET_KEY` (32 bytes as 64 hex chars or base64) or is auto-generated in `<data dir>/secret.key` on first use. **Back that key up!**, as without it, stored credentials are unrecoverable and must be re-entered. The key can be rotated from the `/config` page. When rotated, a new key is staged, every encrypted blob is re-encrypted in a single transaction, and the key file is atomically swapped. If you are also using `FLATLINE_SECRET_KEY` and the key is rotated, you **must also** set the new key manually in the environment variable to match before the next restart or you will lose access to your data.

## Run with Docker (recommended)

### Pull the published image

Each release is built, tested for validation, scanned for vulnerabilities, and published to both the GitHub Container Registry and Docker Hub.

```sh
# GitHub Container Registry
docker pull ghcr.io/jagtx459/flatline:latest
# or Docker Hub
docker pull jagtx459/flatline:latest

docker run -d --name flatline -p 3131:3131 -v flatline-data:/data \
  --sysctl net.ipv4.ping_group_range="0 2147483647" \
  ghcr.io/jagtx459/flatline:latest
```

Tags available on both registries: `latest`, the release version (e.g. `0.3.0`), and `sha-<commit>`.

### Build from source

```sh
docker compose up -d --build
# or
docker build -t flatline .
docker run -d --name flatline -p 3131:3131 -v flatline-data:/data --sysctl net.ipv4.ping_group_range="0 2147483647" flatline
```

Optional environment variables: 
  - `FLATLINE_PASSWORD` (require a login) 
  - `FLATLINE_SECRET_KEY` (credential encryption key; otherwise auto-generated in `/data`)
  - `FLATLINE_ALLOWED_HOSTS` (extra hostnames allowed in the `Host` header, e.g. `flatline.lan`)
  - `FLATLINE_BASE_URL` (the address Flatline is reached at, used for the `{url}` link in notifications; also settable on the `/config` page)
  - `PORT`. 

## Run directly for dev and test

```sh
npm install
npm start          # http://localhost:3131 —> data stored in data/
npm run tests      # scripted assertions against the app and action engine
npm run dev        # seeded demo instance, everything healthy
npm run dev:tests  # seeded demo with planned looping events
```

`dev` uses `data/dev` and mock targets, never your real `data/`. Add `-- --reseed` for fresh data.

See [docs/LOCAL-TESTING.md](docs/LOCAL-TESTING.md) for details.

## AI

This application's development was AI assisted using Claude.ai, contributions are welcome using the templates provided.    
