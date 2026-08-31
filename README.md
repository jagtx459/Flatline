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
3. For an action to arm, endpoints must be placed in a **Flatline Group**. A group fails when configured failure conditions are met; either **all** of them or **any** one, per group.

<div align="center"><img src="https://github.com/jagtx459/Flatline/blob/main/docs/screenshots/endpoints.png?raw=true" alt="icon" width="340" height="400"></div>

4. A failing group will arm the grace period. If it recovers before the group's grace period elapses, it disarms; otherwise the group's assigned **Action Group** will run.
5. **Action Groups** are created from **Action Targets** and run stages/steps in the order you set. **Action Targets** are specific infrastructure for running script(s) against to, for example, shutdown or remove workloads in your environment.

<div align="center"><img src="https://github.com/jagtx459/Flatline/blob/main/docs/screenshots/actions.png?raw=true" alt="icon" width="340" height="400"></div>

6. There are four different **Action Target** types. 

    | Type           | Details                                                                                         |
    | -------------- | ----------------------------------------------------------------------------------------------- |
    | **SSH**        | Password or private key                                                                         |
    | **WinRM**      | Windows host via remote PowerShell (NTLM), over HTTP (5985) or HTTPS (5986, with per-target TLS) |
    | **Kubernetes** | Cordons and drains every node or raw API request with Bearer token or kubeconfig                |
    | **HTTP(S)**    | REST API with no auth, Bearer/JWT, custom header token, Basic auth, or 2-step auth. Per-target TLS (accept self-signed, or verify against a supplied CA) |

    Each type also has an optional **Restore** procedure for when the **Action Target** and **Flatline Endpoint** are up. See [docs/RESTORATION.md](docs/RESTORATION.md) for more details.

    **kubeconfig auth supports a static token, client cert/key, or basic auth, but exec credential plugins (EKS/GKE) are not currently supported 

## Notifications

Flatline supports a few, but more planned in future releases, notification platforms for event triggers with basic template support for messages. Currently supported platforms are:
- Discord
- Ntfy
- Apprise
- Webhooks
- Email

## Security **Please Read!* *

****Again, Flatline is still a work in progress and intended for homelab use; do NOT expose to the internet!*** *

- **Optional, but recommended login**: set a password on the `/config` page or via `FLATLINE_PASSWORD` (which overrides when both are set). 

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
  ghcr.io/jagtx459/flatline:latest
```

Tags available on both registries: `latest`, the release version (e.g. `0.3.0`), and `sha-<commit>`.

### Build from source

```sh
docker compose up -d --build
# or
docker build -t flatline .
docker run -d --name flatline -p 3131:3131 -v flatline-data:/data flatline
```

Optional environment variables: 
  - `FLATLINE_DATA_DIR` data directory location
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
npm run tests:k8s  # ...plus the Kubernetes cases against a real cluster in Docker
npm run dev        # demo instance, everything healthy
npm run dev:tests  # demo with planned looping events
```

## Additional run dev flags
```sh
npm run dev -- --reset  # reset dev database to factory default (cannot use with --reseed or --test flags)
npm run dev -- --reseed # seeds dev database with mock endpoints, targets, and groups
npm run dev -- --tests  # same as npm run dev:tests
```

`dev` uses `data/dev` and mock targets, never your real `data/`

See [docs/LOCAL-TESTING.md](docs/LOCAL-TESTING.md) for details

## AI

This application's development was AI assisted using Claude.ai, contributions are welcome using the templates provided.    
