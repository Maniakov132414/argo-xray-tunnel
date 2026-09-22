# Argo Xray Multi-Protocol Tunnel

Multi-protocol proxy (VLESS/Trojan/VMess over XHTTP/WS) via Cloudflare Argo Tunnel.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ARGO_AUTH` | **Yes** | Cloudflare Tunnel token |
| `ARGO_DOMAIN` deve | **Yes** | Tunnel domain (e.g. `argo-xray.maniakov.bond`) |
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

**When set to `"auto"`, cloudflared may prefer IPv6 to connect to Cloudflare edge.**
If the host has IPv6 but the network path is broken/filtered, the tunnel fails silently.

### Fixes

1. **Force IPv4**: Set `EDGE_IP_VERSION=4` (recommended for stable Xray connections)
2. **Or fix IPv6 connectivity** on the host
3. The Xray outbound uses `domainStrategy: "UseIP"` which resolves via system DNS.
   On dual-stack hosts this may resolve to AAAA records. Change to `"UseIPv4"` if needed.

## Cloudflare Tunnel Setup

This project uses **Cloudflare Argo Tunnel** to expose the internal Xray multi-protocol gateway to the public internet.

See `setup-tunnel.js` and `DEPLOYMENT.md` for detailed setup instructions:

- Run `node setup-tunnel.js` to create a new tunnel (you need to be authenticated with Cloudflare CLI: `wrangler login`)
- The script will output your `ARGO_AUTH` token and tunnel ID
- Create a DNS CNAME record pointing `<your-subdomain>.your-domain.com` to `<tunnel-id>.cfargotunnel.com`
- See `DEPLOYMENT.md` for example environment variables and deployment instructions

For IPv6 stability: Set `EDGE_IP_VERSION=4` in your environment variables.

## Deploy

```bash
# Install dependencies
npm install

# Set environment variables (see .env.example)
export ARGO_AUTH="..."
export ARGO_DOMAIN="argo-xray.maniakov.bond"
export EDGE_IP_VERSION="4"
export UUID="0f7cd3f5-f149-4c6e-aa25-bbbb8b468c38"

# Start the server
node server.js
```

## Docker Deployment (Optional)

For Docker/Kubernetes, use `Dockerfile`:

```bash
# Build the image
docker build -t argo-xray-tunnel .

# Run with environment variables
docker run -d -p 3000:3000 \
  -e ARGO_AUTH="..." \
  -e ARGO_DOMAIN="argo-xray.maniakov.bond" \
  -e EDGE_IP_VERSION="4" \
  -e UUID="0f7cd3f5-f149-4c6e-aa25-bbbb8b468c38" \
  argo-xray-tunnel
```

## GitHub Repository

The repository is available at: **[Maniakov132414/argo-xray-tunnel](https://github.com/Maniakov132414/argo-xray-tunnel)**

**README**: This file

**Issues**: For bug reports or feature requests, please create issues in the repository.

**Contributions**: Pull requests are welcome. Please follow the project's coding conventions and provide clear commit messages.

## Important Notes

1. **IPv4 Stability**: It's recommended to set `EDGE_IP_VERSION=4` for stable, predictable connections, especially in production environments.

2. **Security**: Keep `ARGO_AUTH` token secret. Anyone with this token can configure the tunnel.

3. **Domain Setup**: Ensure your DNS CNAME record points to the tunnel ID. Without this, the tunnel won't be reachable.

4. **Troubleshooting**: If the tunnel fails to connect, check:
   - Cloudflare tunnel status
   - Xray configuration (especially the inbound ports)
   - Network connectivity between host and Cloudflare edge

## Acknowledgments

This project is based on the original `argo-xray` concept and builds upon the excellent work of the Cloudflare community.

## License

This project is open source. See `LICENSE` for details.
