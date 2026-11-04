# Devices

`telepathy bridge` lets sessions on your other devices message each other, over Tailscale or the local network.
Run it on each device:

```sh
telepathy bridge start                # one small daemon per device
telepathy bridge status               # this device, and the devices it can reach
telepathy bridge watch                # live view: devices, their sessions, and messages crossing between them
```

- **Your tailnet:** a device of the same Tailscale user is trusted as soon as both run the bridge. Telepathy asks the
  Tailscale CLI (`tailscale status`, `tailscale whois`), and traffic goes through Tailscale's WireGuard tunnel. A node
  shared in from another tailnet, or another user's device on a shared tailnet, is not trusted; pair it instead.
- **Same Wi-Fi, or any other device:** pair once. Run `telepathy bridge pair` on one device, then
  `telepathy bridge pair <device>` on the other (devices on the local network are found by mDNS; otherwise add one with
  `telepathy bridge add <host[:port]>`). Both screens show the same 6-digit code; confirm it on each. The devices
  exchange X25519 keys with a commitment, and every request after that is sealed with AES-256-GCM under the pair key.
  `telepathy bridge forget <device>` removes it.
- **Addresses:** a session on another device is `<agent>:<name>@<device>`, for example `codex:api-c3f@laptop`, and
  its ref is `codex-…@laptop`. `list_peers` and Claude's `ListAgents` list each device and its sessions. A message
  from another device carries that suffix in `reply-to`, so a reply needs nothing special.
- **Delivery:** the sender's bridge call carries its deadline. The other device delivers the message the same way a
  local send does and answers only once that transcript shows `telepathy-id:<message id>`, inside the sender's 110
  seconds. A device whose bridge is down fails at once, and nothing is queued. A copy that could not be confirmed is
  withdrawn on that device.
- **Where it listens:** port 47380 (`TELEPATHY_BRIDGE_PORT`, the same on every device) on loopback, this device's
  Tailscale address, and its private LAN addresses, never on every interface. `telepathy bridge start --no-lan` or
  `--no-tailscale` turns one off. macOS may ask once whether Node may accept incoming connections.
- **A device that can't accept connections:** a firewall (macOS holds `node` until someone clicks Allow, and asks
  again after a Node upgrade) or NAT can stop other devices from connecting to one, while it can still connect out.
  It then keeps one connection open to each device it reaches, and their messages to it travel back over that
  connection. Each request is checked there exactly as if it had come in directly, and the confirm rule is the same.
  `telepathy bridge status` says so on both devices, and on the blocked one prints the firewall commands that let
  devices connect directly.
- **Updates:** the bridge restarts itself into a new version. It notices when the telepathy it runs from is replaced
  (by auto-update, `telepathy update`, or `npm install -g telepathy-cli`), waits until the devices it reaches have
  that version too, and then they all restart at one moment they agree on, so your devices don't spend long on
  versions that can't talk to each other. A device that sees a newer version on another one checks for updates at
  once; what it installs comes from npm and GitHub, never from the other device. A device with auto-update off isn't
  waited for, and the wait ends after 10 minutes (`TELEPATHY_BRIDGE_RESTART_WAIT_MS`). A delivery in progress finishes
  first, and if the new bridge does not start, the running one keeps going. `telepathy bridge status` shows each
  device's version and when this bridge restarts. A device on a version this one can't talk to is still listed, with
  its version.
- **Names:** a device is called by its host name. `telepathy bridge name <name>` changes it.
- **Agents:** `start_agent` with `device` starts an agent on another device, once that device allows it
  (`telepathy bridge allow-agents <device>` there). See [On another device](subagents.md#on-another-device).
