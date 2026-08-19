import { IClient } from '../models/client.model';
import { InsurerMailingAddress } from './premium-catalogue.service';

/**
 * Envoi des courriers par ePost (plateforme oneAPI de la Poste).
 *
 * Deux modes, et c'est la distinction structurante :
 *
 *   PREVIEW — interroge `/epost/preview/delivery-prices`, qui annonce les
 *             canaux et le prix « without sending any document ». Tout le
 *             chemin est exercé — jeton, multipart, adresses, appariement du
 *             destinataire — sans qu'aucune lettre ne parte. C'est le mode par
 *             défaut, et le seul actif tant que personne ne demande l'autre.
 *
 *   LIVE    — poste réellement, en recommandé, via
 *             `/epost/v2/synchronous-deliveries`.
 *
 * Le mode n'est jamais déduit : il est lu dans la configuration. Un envoi
 * postal est irréversible et facturé ; il ne doit pas pouvoir se déclencher
 * parce qu'une variable a changé de sens.
 *
 * L'authentification demande **deux** en-têtes simultanés : la clé d'API du
 * compte et un jeton d'accès obtenu par mot de passe. Le jeton est mis en
 * cache et renouvelé avant son expiration.
 */

const DEFAULT_BASE_URL = 'https://api.epost.ch';
const TIMEOUT_MS = 60_000;

/** Marge avant expiration : un jeton qui expire en vol coûte une requête. */
const TOKEN_MARGIN_MS = 60_000;

export type EpostMode = 'PREVIEW' | 'LIVE';

/**
 * Affranchissements proposés par ePost.
 *
 * `REGISTERED` est le seul valable pour une résiliation LAMal : la loi veut
 * que le courrier soit *parvenu* à la caisse avant le 30 novembre, et seul le
 * recommandé en fournit la preuve.
 */
export type Postage = 'A_POST' | 'B_POST' | 'B_POST_LARGEVOLUME' | 'A_PLUS' | 'REGISTERED';

export interface EpostConfig {
  enabled: boolean;
  mode: EpostMode;
  baseUrl: string;
  apiKey: string;
  username: string;
  password: string;
  /** Facultatifs : découverts via /core/latest/tenants quand ils manquent. */
  tenantId?: string;
  companyId?: string;
  postage: Postage;
}

export function epostConfig(): EpostConfig {
  const mode = String(process.env.EPOST_MODE || 'PREVIEW').toUpperCase();

  return {
    // Sans clé ni identifiants, le service reste éteint plutôt que d'échouer
    // à chaque clic : l'assuré télécharge ses lettres, comme avant.
    enabled: process.env.EPOST_ENABLED === 'true',
    // Toute valeur autre que LIVE — y compris une faute de frappe — laisse le
    // mode sans envoi. L'erreur par défaut doit être inoffensive.
    mode: mode === 'LIVE' ? 'LIVE' : 'PREVIEW',
    baseUrl: (process.env.EPOST_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: process.env.EPOST_API_KEY || '',
    username: process.env.EPOST_USERNAME || '',
    password: process.env.EPOST_PASSWORD || '',
    tenantId: process.env.EPOST_TENANT_ID || undefined,
    companyId: process.env.EPOST_COMPANY_ID || undefined,
    postage: (process.env.EPOST_POSTAGE as Postage) || 'REGISTERED'
  };
}

export class EpostError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
  }
}

// ------------------------------------------------------------------- jetons

export interface EpostTenant {
  tenant_id: string;
  company_id: number;
  company_name: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refreshToken?: string;
  refresh_token?: string;
  refresh_expires_in?: number;
  token_type?: string;
}

let cached: { token: string; expiresAt: number; refreshToken?: string } | null = null;

/** Efface le jeton en cache — utile après un changement de configuration. */
export function resetEpostToken(): void {
  cached = null;
}

async function form(
  config: EpostConfig,
  path: string,
  fields: Record<string, string>
): Promise<Response> {
  const body = new URLSearchParams(fields);

  return fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // La clé d'API accompagne toutes les requêtes, y compris celles qui
      // n'exigent pas encore de jeton.
      ...(config.apiKey ? { 'X-API-KEY': config.apiKey } : {}),
      Accept: 'application/json'
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
}

/**
 * Tenants du compte.
 *
 * Sert à découvrir `tenant_id` et `company_id`, tous deux nécessaires pour
 * demander un jeton. Une fois connus, ils sont figés en configuration : les
 * redécouvrir à chaque démarrage coûterait un aller-retour et exposerait le
 * mot de passe plus souvent que nécessaire.
 */
export async function listTenants(config = epostConfig()): Promise<EpostTenant[]> {
  const response = await form(config, '/core/latest/tenants', {
    username: config.username,
    password: config.password
  });

  const text = await response.text();
  if (!response.ok) {
    throw new EpostError(
      `ePost a refusé la liste des tenants (HTTP ${response.status}).`,
      response.status,
      text.slice(0, 400)
    );
  }
  return JSON.parse(text) as EpostTenant[];
}

/**
 * Jeton d'accès, mis en cache jusqu'à peu avant son expiration.
 *
 * Le rafraîchissement passe par `refresh_token` quand il est disponible : il
 * évite de renvoyer le mot de passe à chaque renouvellement.
 */
export async function accessToken(config = epostConfig()): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + TOKEN_MARGIN_MS) {
    return cached.token;
  }

  const base = { username: config.username, password: config.password };
  let tenantId = config.tenantId;
  let companyId = config.companyId;

  if (!tenantId || !companyId) {
    const tenants = await listTenants(config);
    if (!tenants.length) {
      throw new EpostError('Ce compte ePost ne porte aucun tenant.');
    }
    tenantId = tenants[0].tenant_id;
    companyId = String(tenants[0].company_id);
    console.info(
      `[ePost] tenant découvert : ${tenants[0].company_name} ` +
      `(tenant_id=${tenantId}, company_id=${companyId}). ` +
      'Figez-les dans EPOST_TENANT_ID et EPOST_COMPANY_ID.'
    );
  }

  // Le rafraîchissement d'abord : il n'expose pas le mot de passe.
  const fields: Record<string, string> = cached?.refreshToken
    ? { grant_type: 'refresh_token', refresh_token: cached.refreshToken,
        tenant_id: tenantId, company_id: companyId }
    : { grant_type: 'password', ...base, tenant_id: tenantId, company_id: companyId };

  let response = await form(config, '/core/latest/token', fields);

  // Un jeton de rafraîchissement périmé se rattrape par le mot de passe,
  // plutôt que de faire échouer un envoi déjà engagé.
  if (!response.ok && cached?.refreshToken) {
    cached = null;
    response = await form(config, '/core/latest/token', {
      grant_type: 'password', ...base, tenant_id: tenantId, company_id: companyId
    });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new EpostError(
      `ePost a refusé les identifiants (HTTP ${response.status}).`,
      response.status,
      text.slice(0, 400)
    );
  }

  const token = JSON.parse(text) as TokenResponse;
  cached = {
    token: token.access_token,
    expiresAt: Date.now() + (token.expires_in || 300) * 1000,
    refreshToken: token.refreshToken || token.refresh_token
  };
  return cached.token;
}

// ---------------------------------------------------------------- livraison

export interface LetterDispatch {
  /** PDF à poster. */
  pdf: Buffer;
  filename: string;
  /** Assuré expéditeur : son adresse est imprimée sur le courrier. */
  sender: IClient;
  /** Caisse destinataire, adresse postale officielle comprise. */
  recipient: InsurerMailingAddress;
  /** Titre affiché dans le suivi ePost. */
  title: string;
  /** Référence propre à Helvetik, pour retrouver l'envoi. */
  reference: string;
}

export interface DispatchResult {
  mode: EpostMode;
  /** Identifiant ePost, absent en mode aperçu. */
  deliveryId?: string;
  /** Canaux jugés disponibles pour ce destinataire. */
  channels: string[];
  /** Prix annoncé, quand ePost le communique. */
  price?: number;
  status?: string;
  /** Message d'erreur renvoyé par ePost pour ce destinataire. */
  error?: string;
  /** Réponse brute, conservée pour le journal d'exploitation. */
  raw: unknown;
}

function senderName(client: IClient): string {
  return [client.firstname, client.name].filter(Boolean).join(' ').trim() || client.email;
}

/**
 * Découpe une adresse suisse « Avenue de France 1 » en rue et numéro.
 *
 * ePost accepte les deux formes — la rue entière dans `street`, ou séparée —
 * mais l'appariement est meilleur quand le numéro est isolé.
 */
function splitStreet(road: string): { street: string; streetNumber?: string } {
  const match = road.trim().match(/^(.*?)\s+(\d+\s*[a-zA-Z]?)$/);
  return match
    ? { street: match[1].trim(), streetNumber: match[2].replace(/\s+/g, '') }
    : { street: road.trim() };
}

/** Métadonnées d'un envoi papier, telles que l'API les attend. */
function buildMetadata(dispatch: LetterDispatch, config: EpostConfig) {
  const sender = splitStreet(dispatch.sender.road);
  const to = dispatch.recipient;

  // La caisse se joint soit par sa rue, soit par sa case postale. Les deux ont
  // leurs champs propres chez ePost : « Postfach 2568 » rangé en rue donnait
  // une rue nommée « Postfach » portant le numéro 2568.
  const street = to.street ? splitStreet(to.street) : undefined;
  const boxNumber = to.poBox
    ? (to.poBox.match(/(\d+)\s*$/)?.[1] ?? '')
    : undefined;

  return {
    fileMetadata: [{
      fileName: dispatch.filename,
      // Un seul canal, jamais AUTO : une résiliation ne doit pas partir dans
      // une boîte aux lettres numérique au lieu du recommandé attendu.
      deliveryChannelPreferences: ['PHYSICAL'],
      documentTitle: dispatch.title,
      documentTypes: ['contract'],
      senderName: senderName(dispatch.sender),
      senderEndToEndId: dispatch.reference,
      documentReferenceDate: new Date().toISOString().slice(0, 10),
      recipients: [{
        senderUserId: dispatch.reference,
        unhashedCredentials: {
          companyName: to.name,
          ...(street ? { street: street.street } : {}),
          ...(street?.streetNumber ? { streetNumber: street.streetNumber } : {}),
          // La case postale prime pour l'acheminement quand la caisse en
          // publie une : c'est l'adresse qu'elle donne pour son courrier.
          ...(to.poBox ? {
            postOfficeBoxNumber: boxNumber || to.poBox,
            ...(to.plz ? { postOfficeBoxZip: to.plz } : {}),
            ...(to.city ? { postOfficeBoxTownName: to.city } : {})
          } : {}),
          ...(to.plz ? { zipCode: to.plz } : {}),
          ...(to.city ? { city: to.city } : {})
        }
      }],
      physicalAdditionalInfo: {
        postage: config.postage,
        envelopeSize: 'AUTO',
        duplex: false,
        windowLocation: 'LEFT',
        shippingCountry: 'CH',
        // L'expéditeur imprimé est l'assuré, pas Helvetik : c'est lui qui
        // résilie, et la caisse doit pouvoir lui répondre directement.
        senderAddress: {
          name: senderName(dispatch.sender),
          street: sender.street,
          ...(sender.streetNumber ? { streetNumber: sender.streetNumber } : {}),
          zipCode: dispatch.sender.plz,
          city: dispatch.sender.location
        }
      }
    }]
  };
}

async function multipart(
  config: EpostConfig,
  path: string,
  dispatch: LetterDispatch,
  metadata: unknown
): Promise<{ status: number; body: string }> {
  const token = await accessToken(config);

  const body = new FormData();
  body.append('files', new Blob([new Uint8Array(dispatch.pdf)], {
    type: 'application/pdf'
  }), dispatch.filename);
  body.append('metadata', new Blob([JSON.stringify(metadata)], {
    type: 'application/json'
  }));

  const response = await fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'X-API-KEY': config.apiKey,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  return { status: response.status, body: await response.text() };
}

/**
 * Envoie une lettre — ou en simule l'envoi, selon le mode configuré.
 *
 * En mode aperçu, l'appel porte sur `/epost/preview/delivery-prices` : ePost
 * annonce les canaux et le tarif sans rien poster. Le reste du chemin est
 * identique, si bien qu'un aperçu qui réussit garantit qu'un envoi réel
 * partirait.
 */
export async function dispatchLetter(
  dispatch: LetterDispatch,
  config = epostConfig()
): Promise<DispatchResult> {
  if (!config.enabled) {
    throw new EpostError('L\'envoi par ePost n\'est pas activé sur ce serveur.');
  }
  if (!config.apiKey || !config.username || !config.password) {
    throw new EpostError('Les identifiants ePost sont incomplets.');
  }

  const metadata = buildMetadata(dispatch, config);
  const preview = config.mode === 'PREVIEW';
  const path = preview
    ? '/epost/preview/delivery-prices'
    : '/epost/v2/synchronous-deliveries';

  const { status, body } = await multipart(config, path, dispatch, metadata);

  if (status >= 400) {
    throw new EpostError(
      `ePost a refusé l'envoi (HTTP ${status}).`, status, body.slice(0, 600)
    );
  }

  const parsed = body ? JSON.parse(body) : {};
  return preview ? readPreview(parsed) : readDelivery(parsed);
}

/**
 * L'aperçu du prix revient de façon asynchrone : la première réponse ne porte
 * qu'un identifiant, le détail se lit ensuite sur `/status`. On rend donc
 * l'identifiant, à interroger via `previewStatus`.
 */
function readPreview(parsed: { id?: string }): DispatchResult {
  return {
    mode: 'PREVIEW',
    deliveryId: parsed.id,
    channels: [],
    status: 'PROCESSING',
    raw: parsed
  };
}

interface DeliveryStatusBody {
  deliveryId?: string;
  status?: string;
  document?: {
    failedDocument?: Array<{
      errorMessage?: string;
      detail?: Array<{ errorMessage?: string; deliveryChannel?: string }>;
    }>;
    deliveredDocument?: Array<{
      detail?: Array<{ deliveryChannel?: string; trackingNumber?: string }>;
    }>;
  };
}

function readDelivery(parsed: DeliveryStatusBody): DispatchResult {
  const failed = parsed.document?.failedDocument?.[0];
  const delivered = parsed.document?.deliveredDocument?.[0];

  return {
    mode: 'LIVE',
    deliveryId: parsed.deliveryId,
    channels: (delivered?.detail || [])
      .map((d) => d.deliveryChannel)
      .filter(Boolean) as string[],
    status: parsed.status,
    error: failed?.errorMessage || failed?.detail?.[0]?.errorMessage,
    raw: parsed
  };
}

/** Détail d'un aperçu de prix, une fois son traitement terminé. */
export async function previewStatus(
  previewId: string,
  config = epostConfig()
): Promise<DispatchResult> {
  const token = await accessToken(config);
  const response = await fetch(
    `${config.baseUrl}/epost/preview/delivery-prices/${encodeURIComponent(previewId)}/status`,
    {
      headers: {
        'X-API-KEY': config.apiKey,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    }
  );

  const text = await response.text();
  if (!response.ok) {
    throw new EpostError(
      `Aperçu indisponible (HTTP ${response.status}).`, response.status, text.slice(0, 400)
    );
  }

  const parsed = JSON.parse(text) as {
    status?: string;
    pricePreview?: Array<{
      potentialPrices?: Array<{ channel?: string; price?: number; errorMessage?: string }>;
      errorMessage?: string;
    }>;
  };

  const first = parsed.pricePreview?.[0];
  const physical = first?.potentialPrices?.find((p) => p.channel === 'PHYSICAL');

  return {
    mode: 'PREVIEW',
    deliveryId: previewId,
    channels: (first?.potentialPrices || [])
      .filter((p) => p.price !== undefined)
      .map((p) => p.channel)
      .filter(Boolean) as string[],
    price: physical?.price,
    status: parsed.status,
    error: first?.errorMessage || physical?.errorMessage,
    raw: parsed
  };
}

/** Statut d'un envoi réel. */
export async function deliveryStatus(
  deliveryId: string,
  config = epostConfig()
): Promise<DispatchResult> {
  const token = await accessToken(config);
  const response = await fetch(
    `${config.baseUrl}/epost/v2/deliveries/${encodeURIComponent(deliveryId)}/status`,
    {
      headers: {
        'X-API-KEY': config.apiKey,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    }
  );

  const text = await response.text();
  if (!response.ok) {
    throw new EpostError(
      `Statut indisponible (HTTP ${response.status}).`, response.status, text.slice(0, 400)
    );
  }
  return readDelivery(JSON.parse(text) as DeliveryStatusBody);
}

/** Contrôle de configuration au démarrage, sans jamais rien envoyer. */
export function checkEpostConfiguration(): void {
  const config = epostConfig();

  if (!config.enabled) {
    console.info('[ePost] envoi des courriers désactivé (EPOST_ENABLED≠true).');
    return;
  }

  // La clé d'API n'est pas exigée : l'authentification passe par le seul
  // couple identifiant/mot de passe — vérifié contre api.epost.ch, où une clé
  // absente ou fantaisiste ne change rien à la réponse. Elle reste transmise
  // quand elle est configurée, au cas où un compte l'imposerait.
  const missing = [
    !config.username && 'EPOST_USERNAME',
    !config.password && 'EPOST_PASSWORD'
  ].filter(Boolean);

  if (missing.length) {
    console.error(`[ePost] activé mais incomplet : ${missing.join(', ')} manque(nt).`);
    return;
  }

  console.info(
    `[ePost] ${config.mode === 'LIVE'
      ? 'MODE RÉEL — les courriers partent en ' + config.postage
      : 'mode aperçu — aucun courrier ne part'} · ${config.baseUrl}`
  );
}
