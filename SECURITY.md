# Security policy

Agent Deck is experimental. Security fixes target the latest version; there is
no supported older release branch yet.

Report suspected vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/noti0nS/agent-deck/security/advisories/new).
The repository owner must enable private vulnerability reporting as part of the
public launch (GitHub may not offer it while the repository is private).
If that channel is unavailable, open an issue requesting
a private contact **without posting the vulnerability, credentials or sessions**.

Include the affected version, access required, minimal reproduction with dummy
data, and expected versus actual behavior. Do not test against another person's
collector or send real agent history.

## Trust model

- Access on the collector's own machine is trusted.
- Tailscale Serve proxies into loopback and is intentionally trusted. Tailnet
  access rules determine who can view the monitor; no extra pairing is required.
- Direct private-LAN access requires a short-lived pairing code and a device
  cookie. Device sessions can be revoked locally with the CLI.
- Do not expose the collector through an arbitrary loopback reverse proxy,
  public tunnel, Tailscale Funnel or public port forwarding. Such a proxy would
  also inherit local trust. The application is not a multi-user hosted service.

Plain HTTP LAN mode is intended for trusted networks; it does not encrypt session
content or cookies in transit. Prefer Tailscale HTTPS for remote use. Redaction
is best-effort, not a guarantee that arbitrary prompts contain no secrets.
See [privacy and data lifecycle](docs/privacy.md).
