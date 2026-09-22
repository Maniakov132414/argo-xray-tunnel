const https = require('https');

const TOKEN = "cfoat_IjNA_DXw_M4Oi-ouAR-1Hm9E-pdS5oddpKM0r0BZf6c.sp1tCas95qsTKD1_lwm9R6yOW-QqEfhJR9IIyJSsU84";
const ACCOUNT_ID = "5b3f26b5692185b77a86bc24917a968f";
const ZONE_ID = "6a6fa8f93e9842174e8b67572987c7f2";
const TUNNEL_ID = "d6370657-b96a-4a6d-85ad-0812ee6d3c13";
const TUNNEL_TOKEN = "eyJhIjoiNWIzZjI2YjU2OTIxODViNzdhODZiYzI0OTE3YTk2OGYiLCJ0IjoiZDYzNzA2NTctYjk2YS00YTZkLTg1YWQtMDgxMmVlNmQzYzEzIiwicyI6InF1NlBYSDVDTEQxVFNkQjhvbXVQM2grNVh3VkZneFp0c3pGU1B0Ri9VYkk9In0=";

async function apiCall(method, fullPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.cloudflare.com',
      path: fullPath,
      method,
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else {
          resolve({ success: false, errors: [{ code: res.statusCode, message: data }] });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log("=== Summary ===");
  console.log(`Tunnel ID: ${TUNNEL_ID}`);
  console.log(`ARGO_AUTH: ${TUNNEL_TOKEN}`);
  console.log(`ARGO_DOMAIN: argo-xray.maniakov.bond`);
  console.log(`Cloudflared gateway: localhost:2082`);

  // Try to create a DNS CNAME record using the zone API
  console.log("\n=== Creating DNS CNAME via Zone API ===");
  
  const dnsRecord = await apiCall('POST', `/client/v4/zones/${ZONE_ID}/dns_records`, {
    type: 'CNAME',
    name: 'argo-xray.maniakov.bond',
    content: `${TUNNEL_ID}.cfargotunnel.com`,
    ttl: 1,
    proxied: true,
  });

  if (dnsRecord.success) {
    console.log("DNS CNAME created successfully!");
    console.log(`DNS: argo-xray.maniakov.bond CNAME -> ${TUNNEL_ID}.cfargotunnel.com`);
    return;
  }

  console.log("Failed to create DNS CNAME via Zone API:", JSON.stringify(dnsRecord.errors, null, 2));

  // Try using the tunnel route API instead
  console.log("\n=== Creating tunnel route ===");
  
  const route = await apiCall('POST', `/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/routes/dns`, {
    hostname: "argo-xray.maniakov.bond",
    service: "http://localhost:2082",
    network: "http2",
    protocol: "http2",
    delete: false,
  });

  if (route.success) {
    console.log("Tunnel route created successfully!");
    return;
  }

  console.log("Failed to create tunnel route:", JSON.stringify(route, null, 2));
}

main().catch(e => console.error(e));
