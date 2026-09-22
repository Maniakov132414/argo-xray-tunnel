```bash
# Cloudflare Tunnel ARGO_AUTH token
ARGO_AUTH=eyJhIjoiNWIzZjI2YjU2OTIxODViNzdhODZiYzI0...

# Tunnel domain
ARGO_DOMAIN=argo-xray.maniakov.bond

# UUID for VLESS/VMess
UUID=0f7cd3f5-f149-4c6e-aa25-bbbb8b468c38

# Optional: custom Trojan password (leave empty to use UUID)
TROJAN_PASSWORD=

# Optional: clean IP / edge IP
CFIP=104.17.200.1

# Edge port
CFPORT=443

# IPv4 for stability (fixes IPv6 issues)
EDGE_IP_VERSION=4

# Tunnel protocol
ARGO_PROTOCOL=http2

# Server ports
SERVER_PORT=3000
GATEWAY_PORT=2082
SOCKS_PORT=10808

# Node name prefix
NAME=sap
```
