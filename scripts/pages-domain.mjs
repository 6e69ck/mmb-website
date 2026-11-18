import { cloudflare, accountId } from './cloudflare-client.mjs';

export async function connectDomain(project, hostname) {
  let domain = await cloudflare(`/accounts/${accountId}/pages/projects/${project.name}/domains/${hostname}`, { allowMissing: true });
  if (!domain) domain = await cloudflare(`/accounts/${accountId}/pages/projects/${project.name}/domains`, { method: 'POST', body: { name: hostname } });
  const zones = await cloudflare('/zones?name=nickly.me');
  const zone = zones.find(zone => zone.status === 'active');
  if (!zone) throw new Error('The nickly.me zone is not active.');
  const records = await cloudflare(`/zones/${zone.id}/dns_records?name=${hostname}`);
  if (records.some(record => record.type !== 'CNAME' || record.content.replace(/\.$/, '') !== project.subdomain)) {
    throw new Error(`An existing DNS record for ${hostname} points elsewhere and was preserved.`);
  }
  if (!records.length) await cloudflare(`/zones/${zone.id}/dns_records`, { method: 'POST', body: { type: 'CNAME', name: hostname, content: project.subdomain, proxied: true, ttl: 1 } });
  if (domain.status !== 'active') domain = await cloudflare(`/accounts/${accountId}/pages/projects/${project.name}/domains/${hostname}`, { method: 'PATCH' });
  console.log(`Connected ${hostname} to ${project.subdomain}; certificate status: ${domain.status}.`);
}

if (process.argv[1]?.endsWith('/pages-domain.mjs')) {
  for (const [name, domain] of [['mmb-website', 'mmb.nickly.me'], ['mmb-admin-dashboard', 'admin.mmb.nickly.me']]) {
    const project = await cloudflare(`/accounts/${accountId}/pages/projects/${name}`, { allowMissing: true });
    if (project) await connectDomain(project, domain);
  }
}
