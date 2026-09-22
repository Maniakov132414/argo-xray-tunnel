const https = require('https');

const TOKEN = "cfoat_IjNA_DXw_M4Oi-ouAR-1Hm9E-pdS5oddpKM0r0BZf6c.sp1tCas95qsTKD1_lwm9R6yOW-QqEfhJR9IIyJSsU84";
const ACCOUNT_ID = "5b3f26b5692185b77a86bc24917a968f";

function cfApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.cloudflare.com',
      path: `/client/v4/accounts/${ACCOUNT_ID}${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  // 1. List existing tunnels
  console.log("=== Listing existing tunnels ===");
  const list = await cfApi('GET', '/cfd_tunnel?is_deleted=false&per_page=10');
  if (!list.success) {
    console.log("Failed to list tunnels:", JSON.stringify(list.errors));
    console.log("Token may lack tunnel permissions. Full response:", JSON.stringify(list).substring(0, 500));
    return;
  }
  
  for (const t of list.result || []) {
    console.log(`  ${t.name} | ${t.id} | ${t.status}`);
  }

  // 2. Create new tunnel for argo-xray
  console.log("\n=== Creating tunnel 'argo-xray-railway' ===");
  const secret = require('crypto').randomBytes(32).toString('base64');
  const create = await cfApi('POST', '/cfd_tunnel', {
    name: 'argo-xray-railway',
    tunnel_secret: secret,
    config_src: 'cloudflare',
  });
  
  if (!create.success) {
    console.log("Failed to create tunnel:", JSON.stringify(create.errors));
    return;
  }

  const tunnelId = create.result.id;
  const tunnelToken = create.result.token;
  console.log(`Tunnel created: ${tunnelId}`);
  console.log(`ARGO_AUTH token: ${tunnelToken}`);

  // 3. Configure tunnel to point to local gateway
  console.log("\n=== Configuring tunnel ingress ===");
  const config = await cfApi('PUT', `/cfd_tunnel/${tunnelId}/configurations`, {
    config: {
      ingress: [
        {
          hostname: "argo-xray.maniakov.bond",
          service: "http://localhost:2082",
          originRequest: {},
        },
        {
          service: "http_status:404",
        },
      ],
    },
  });

  if (!config.success) {
    console.log("Failed to configure tunnel:", JSON.stringify(config.errors));
  } else {
    console.log("Tunnel configured successfully");
  }

  // 4. Create DNS CNAME record
  console.log("\n=== Creating DNS record ===");
  // First get zone ID for maniakov.bond
  const zoneReq = await new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.cloudflare.com',
      path: '/client/v4/zones?name=maniakov.bond',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    r.on('error', reject);
    r.end();
  });

  if (!zoneReq.success || !zoneReq.result?.length) {
    console.log("Could not find zone for maniakov.bond:", JSON.stringify(zoneReq.errors));
    console.log("\n=== SUMMARY ===");
    console.log(`Tunnel ID: ${tunnelId}`);
    console.log(`ARGO_AUTH: ${tunnelToken}`);
    console.log(`ARGO_DOMAIN: argo-xray.maniakov.bond`);
    console.log("DNS record needs manual creation: CNAME argo-xray.maniakov.bond -> " + tunnelId + ".cfargotunnel.com");
    return;
  }

  const zoneId = zoneReq.result[0].id;
  console.log(`Zone ID: ${zoneId}`);

  const dns = await new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.cloudflare.com',
      path: `/client/v4/zones/${zoneId}/dns_records`,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    r.on('error', reject);
    r.write(JSON.stringify({
      type: 'CNAME',
      name: 'argo-xray',
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
    }));
    r.end();
  });

  if (!dns.success) {
    console.log("DNS creation failed:", JSON.stringify(dns.errors));
  } else {
    console.log("DNS record created: argo-xray.maniakov.bond -> tunnel");
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Tunnel ID: ${tunnelId}`);
  console.log(`ARGO_AUTH: ${tunnelToken}`);
  console.log(`ARGO_DOMAIN: argo-xray.maniakov.bond`);
}

main().catch(e => console.error(e));
