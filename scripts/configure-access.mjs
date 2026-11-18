import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { accountId, cloudflare, root } from './cloudflare-client.mjs';

const hostname = 'admin.mmb.nickly.me';
const email = 'nickly88@pm.me';
const base = `/accounts/${accountId}/access`;
const organization = await cloudflare(`${base}/organizations`);
if (!organization?.auth_domain) throw new Error('Enable Cloudflare Zero Trust on the Soldr account, then rerun this command.');
const applications = await cloudflare(`${base}/apps`);
const existing = applications.find(app => app.domain === hostname);
if (existing && existing.name !== 'MMB Gallery Admin') throw new Error('An unrelated Access application owns the admin domain; it was preserved.');
const providers = await cloudflare(`${base}/identity_providers`);
let pin = providers.find(provider => provider.type === 'onetimepin');
if (!pin) pin = await cloudflare(`${base}/identity_providers`, { method: 'POST', body: { name: 'Email code', type: 'onetimepin', config: {} } });
const application = await cloudflare(`${base}/apps${existing ? `/${existing.id}` : ''}`, {
  method: existing ? 'PUT' : 'POST',
  body: {
    name: 'MMB Gallery Admin', domain: hostname, type: 'self_hosted', session_duration: '8h',
    allowed_idps: [pin.id], auto_redirect_to_identity: true,
    policies: [{ name: 'Gallery administrators', decision: 'allow', include: [{ email: { email } }], exclude: [], require: [] }],
  },
});
if (!application.aud) throw new Error('Cloudflare did not return an Access audience; no admin deployment was performed.');
// Pages' certificate authority must reach this path without an Access login.
// A more-specific application bypasses only ACME validation, never admin routes.
const validationDomain = `${hostname}/.well-known/acme-challenge/*`;
const validationApp = applications.find(app => app.domain === validationDomain);
if (validationApp && validationApp.name !== 'MMB Admin Certificate Validation') throw new Error('An unrelated Access application owns the certificate-validation path; it was preserved.');
await cloudflare(`${base}/apps${validationApp ? `/${validationApp.id}` : ''}`, {
  method: validationApp ? 'PUT' : 'POST',
  body: {
    name: 'MMB Admin Certificate Validation', domain: validationDomain, type: 'self_hosted',
    policies: [{ name: 'Certificate validation only', decision: 'bypass', include: [{ everyone: {} }], exclude: [], require: [] }],
  },
});
await writeFile(path.join(root, 'apps/admin-dashboard/access.production.local.json'), JSON.stringify({
  ACCESS_TEAM_DOMAIN: `https://${organization.auth_domain}`,
  ACCESS_AUD: application.aud,
}, null, 2));
console.log(`Email-code sign-in configured for ${email} at ${hostname}.`);
