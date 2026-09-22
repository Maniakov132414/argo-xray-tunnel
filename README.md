# Argo Xray Multi-Protocol Tunnel

Multi-protocol proxy (VLESS/Trojan/VMess over XHTTP/WS) via Cloudflare Argo Tunnel.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ARGO_AUTH` | **Yes** | Cloudflare Tunnel token |
| `ARGO_DOMAIN` | **Yes** | Tunnel domain (e.g. `tunnel.example.com`) |
| `UUID` | **Yes** | VLESS/VMess UUID |
| `TROJAN_PASSWORD` | No | Trojan password (defaults to UUID) |
| `CFIP` | No | Clean IP / edge IP (default: `ip.sb`) |
| `CFPORT` | No | Edge port (default: `443`) |
| `EDGE_IP_VERSION` | No | `4`, `6`, or `auto` (default: `auto`) |
| `ARGO_PROTOCOL` | No | `http2`, `quic`, or `auto` (default: `http2`) |
| `SERVER_PORT` / `PORT` | No | Web server port (default: `3000`) |
| `GATEWAY_PORT` | No | Internal gateway port (default: `2082`) |
| `NAME` | No | Node name prefix |

## Endpoints

- `GET /jd` - Base64 subscription
- `GET /clash` - Clash YAML subscription
- `GET /raw` - Raw subscription links
- `GET /debug` - Debug info (JSON)

## IPv6 Issue Analysis

The question was: **"节点在有ipv6的环境下不通是咋回事"** (nodes don't work in IPv6 environments)

### Root Cause

The `EDGE_IP_VERSION` variable controls cloudflared's `--edge-ip-version` flag:

```js
const EDGE_IP_MODE = ["4", "6", "auto"].includes(...)
  ? ... : "auto";
```

When set to `"auto"`, cloudflared may prefer IPv6 to connect to Cloudflare edge.
If the host has IPv6 but the network path is broken/filtered, the tunnel fails silently.

### Fixes

1. **Force IPv4**: Set `EDGE_IP_VERSION=4`
2. **Or fix IPv6 connectivity** on the host
3. The Xray outbound uses `domainStrategy: "UseIP"` which resolves via system DNS.
   On dual-stack hosts this may resolve to AAAA records. Change to `"UseIPv4"` if needed.

## Deploy

```bash
npm install
# Set environment variables first
node server.js
```
