/**
 * Vérification du compte ePost.
 *
 * N'envoie aucun courrier : demande la liste des tenants, puis un jeton. Si les
 * deux passent, la clé et les identifiants sont bons, et les identifiants de
 * tenant et de company s'affichent — ce sont eux qu'on fige ensuite dans .env.
 *
 * Usage (depuis d:/Projets/Helvetik/Server) :
 *   EPOST_API_KEY=... EPOST_USERNAME=... EPOST_PASSWORD=... \
 *     node <ce fichier>
 */

const BASE = process.env.EPOST_BASE_URL || 'https://api.epost.ch';
const KEY = process.env.EPOST_API_KEY;
const USER = process.env.EPOST_USERNAME;
const PASS = process.env.EPOST_PASSWORD;

if (!KEY || !USER || !PASS) {
  console.error('Il faut EPOST_API_KEY, EPOST_USERNAME et EPOST_PASSWORD.');
  process.exit(1);
}

async function main() {
  console.log(`Serveur : ${BASE}\n`);

  // --- 1. Les tenants. Seule la clé et le couple identifiant/mot de passe
  //        sont nécessaires : c'est le test le plus simple de la clé.
  const res = await fetch(`${BASE}/core/latest/tenants`, {
    method: 'POST',
    headers: { 'X-API-KEY': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  });

  const body = await res.text();
  if (!res.ok) {
    console.error(`Échec (${res.status}) sur /core/latest/tenants :\n${body}`);
    console.error('\n401 = clé refusée · 403 = identifiants refusés · 404 = mauvais serveur.');
    process.exit(1);
  }

  const tenants = JSON.parse(body);
  console.log('Tenants du compte :');
  console.log(JSON.stringify(tenants, null, 2));

  // --- 2. Un jeton sur le premier tenant, pour confirmer que le compte est
  //        réellement utilisable et pas seulement reconnu.
  const first = Array.isArray(tenants) ? tenants[0] : tenants?.tenants?.[0];
  if (!first) {
    console.error('\nAucun tenant : le compte existe mais n\'est rattaché à rien.');
    process.exit(1);
  }

  const tenantId = first.tenantId || first.id;
  const companyId = first.companyId || first.companies?.[0]?.companyId
    || first.companies?.[0]?.id;

  const fields = {
    grant_type: 'password',
    username: USER,
    password: PASS,
    ...(tenantId ? { tenant_id: String(tenantId) } : {}),
    ...(companyId ? { company_id: String(companyId) } : {})
  };

  const tok = await fetch(`${BASE}/core/latest/token`, {
    method: 'POST',
    headers: {
      'X-API-KEY': KEY,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(fields).toString()
  });

  const tokBody = await tok.text();
  if (!tok.ok) {
    console.error(`\nÉchec (${tok.status}) sur /core/latest/token :\n${tokBody}`);
    process.exit(1);
  }

  const token = JSON.parse(tokBody);
  console.log('\nJeton obtenu.');
  console.log(`  type    : ${token.token_type || '—'}`);
  console.log(`  validité: ${token.expires_in ? token.expires_in + ' s' : '—'}`);

  console.log('\nÀ mettre dans .env :');
  console.log(`  EPOST_TENANT_ID=${tenantId ?? ''}`);
  console.log(`  EPOST_COMPANY_ID=${companyId ?? ''}`);
}

main().catch((err) => {
  console.error('\nÉchec :', err.message);
  console.error('Un ECONNREFUSED ou un ENOTFOUND désigne EPOST_BASE_URL.');
  process.exit(1);
});
