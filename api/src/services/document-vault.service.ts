import { readFile } from 'fs/promises';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from 'crypto';
import {
  DocumentSide,
  IIdentityDocument,
  IdentityDocument
} from '../models/identity-document.model';

/**
 * Coffre des pièces d'identité.
 *
 * Les copies de cartes d'identité doivent être conservées : les caisses
 * exigent une pièce jointe aux lettres de résiliation et d'affiliation. Ce
 * sont donc des documents durables, et non plus des fichiers analysés puis
 * jetés — ce qui change entièrement les précautions à prendre.
 *
 * Ce qui est fait ici :
 *   - chiffrement AES-256-GCM avant écriture, avec un vecteur d'initialisation
 *     tiré au hasard pour chaque document ;
 *   - authentification du chiffré : une base altérée est détectée au
 *     déchiffrement, elle ne produit pas un fichier silencieusement faux ;
 *   - clé hors de la base, lue dans l'environnement : voler une sauvegarde
 *     MongoDB ne suffit alors pas à lire les pièces.
 *
 * Ce qui n'est pas fait, et doit être assumé : la clé est en clair dans
 * l'environnement du conteneur. Quiconque obtient un accès root sur l'hôte
 * peut la lire. La protection vise le vol de sauvegarde et l'accès à la base,
 * pas la compromission complète de la machine.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Une photo de pièce d'identité dépasse rarement quelques mégaoctets. */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

/** Formats acceptés : ce qui sort d'un téléphone, ou un scan. */
const ACCEPTED_MIMETYPES = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/i;
const ACCEPTED_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif|pdf)$/i;

let cachedKey: Buffer | null = null;

/**
 * Clé de chiffrement, lue une fois.
 *
 * En production, elle est obligatoire : sans elle, mieux vaut refuser le dépôt
 * que d'écrire des pièces d'identité en clair. En développement, une clé fixe
 * dérivée d'une phrase connue prend le relais — les documents déposés restent
 * lisibles d'un redémarrage à l'autre, ce qu'une clé éphémère interdirait.
 */
function encryptionKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }

  const configured = process.env.DOCUMENT_ENCRYPTION_KEY;
  if (configured) {
    // Base64 ou hexadécimal : les deux sortent naturellement d'openssl et de
    // crypto.randomBytes, autant accepter l'une et l'autre.
    const raw = /^[0-9a-f]{64}$/i.test(configured)
      ? Buffer.from(configured, 'hex')
      : Buffer.from(configured, 'base64');

    if (raw.length !== KEY_BYTES) {
      throw new Error(
        `DOCUMENT_ENCRYPTION_KEY doit faire ${KEY_BYTES} octets ` +
        `(${raw.length} lu). Générez-la avec : ` +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
      );
    }
    cachedKey = raw;
    return cachedKey;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'DOCUMENT_ENCRYPTION_KEY est absent : les pièces d\'identité ne peuvent pas ' +
      'être chiffrées, et ne seront donc pas enregistrées.'
    );
  }

  cachedKey = createHash('sha256').update('helvetik-cle-de-developpement').digest();
  return cachedKey;
}

/**
 * Vérifie la configuration au démarrage, plutôt qu'au premier dépôt.
 * Un dépôt refusé six mois après la mise en production serait découvert par
 * l'assuré, pas par l'exploitant.
 */
export function checkVaultConfiguration(): void {
  try {
    encryptionKey();
    if (!process.env.DOCUMENT_ENCRYPTION_KEY) {
      console.warn(
        '[coffre] DOCUMENT_ENCRYPTION_KEY absent : clé de développement, connue et ' +
        'publique. À ne jamais utiliser avec de vraies pièces d\'identité.'
      );
    }
  } catch (err) {
    console.error(`[coffre] ${(err as Error).message}`);
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
}

export interface StoredDocument {
  side: DocumentSide;
  filename: string;
  mimetype: string;
  size: number;
  uploadedAt: Date;
  /** Vrai si ce dépôt a remplacé une pièce déjà présente. */
  replaced: boolean;
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Le fichier déposé est-il d'un type que l'on sait restituer ? */
export function isAcceptedDocument(mimetype: string, filename: string): boolean {
  return ACCEPTED_MIMETYPES.test(mimetype) || ACCEPTED_EXTENSIONS.test(filename);
}

/**
 * Chiffre puis enregistre une face, en remplaçant celle déjà déposée.
 *
 * Le fichier temporaire n'est pas effacé ici : l'appelant en reste maître,
 * car il doit encore le soumettre à la reconnaissance de texte.
 */
export async function storeDocument(options: {
  userUid: string;
  clientUid: string;
  side: DocumentSide;
  path: string;
  filename: string;
  mimetype: string;
}): Promise<StoredDocument> {
  const plain = await readFile(options.path);
  if (!plain.length) {
    throw new VaultError('Le fichier reçu est vide.');
  }
  if (plain.length > MAX_DOCUMENT_BYTES) {
    throw new VaultError(
      `Le fichier dépasse ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} Mo.`
    );
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const checksum = createHash('sha256').update(plain).digest('hex');

  const previous = await IdentityDocument.findOne({
    clientUid: options.clientUid,
    side: options.side
  });

  await IdentityDocument.findOneAndUpdate(
    { clientUid: options.clientUid, side: options.side },
    {
      $set: {
        userUid: options.userUid,
        mimetype: options.mimetype,
        filename: options.filename.slice(0, 200),
        size: plain.length,
        data: encrypted,
        iv,
        authTag,
        checksum,
        uploadedAt: new Date(),
        // Le compteur repart à zéro : c'est une nouvelle pièce, pas la même
        // qu'on aurait consultée dix fois.
        accessCount: 0
      },
      $unset: { lastAccessedAt: '' }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return {
    side: options.side,
    filename: options.filename,
    mimetype: options.mimetype,
    size: plain.length,
    uploadedAt: new Date(),
    replaced: Boolean(previous)
  };
}

export interface RetrievedDocument {
  content: Buffer;
  mimetype: string;
  filename: string;
}

/**
 * Déchiffre une pièce et enregistre l'accès.
 *
 * `reason` n'est pas décoratif : une pièce d'identité lue depuis la console
 * d'administration doit laisser une trace dans le journal, faute de quoi
 * personne ne peut dire qui a consulté quoi.
 */
export async function retrieveDocument(
  clientUid: string,
  side: DocumentSide,
  reason: string
): Promise<RetrievedDocument | null> {
  const document = await IdentityDocument
    .findOne({ clientUid, side })
    .select('+data +iv +authTag');

  if (!document) {
    return null;
  }

  let content: Buffer;
  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), document.iv);
    decipher.setAuthTag(document.authTag);
    content = Buffer.concat([decipher.update(document.data), decipher.final()]);
  } catch {
    // GCM refuse de produire un clair non authentifié : soit la base a été
    // altérée, soit la clé a changé. Dans les deux cas, ne rien restituer.
    throw new VaultError(
      'Cette pièce n\'a pas pu être déchiffrée. La clé de chiffrement a changé, ' +
      'ou le document a été altéré : il faut le redéposer.'
    );
  }

  // Contrôle d'intégrité de bout en bout : GCM protège le chiffré, l'empreinte
  // atteste que le clair restitué est bien celui qui avait été déposé.
  const actual = createHash('sha256').update(content).digest('hex');
  const expected = document.checksum;
  if (actual.length !== expected.length ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    throw new VaultError('L\'empreinte de cette pièce ne correspond pas. Redéposez-la.');
  }

  await IdentityDocument.updateOne(
    { uid: document.uid },
    { $set: { lastAccessedAt: new Date() }, $inc: { accessCount: 1 } }
  );
  console.info(`[coffre] pièce ${side} de ${clientUid} restituée — ${reason}`);

  return {
    content,
    mimetype: document.mimetype,
    filename: document.filename
  };
}

/** Métadonnées des pièces d'un assuré, sans jamais toucher au contenu. */
export async function listDocuments(clientUid: string): Promise<IIdentityDocument[]> {
  return IdentityDocument.find({ clientUid }).sort({ side: 1 });
}

/** Assurés d'un foyer possédant au moins une pièce, par uid. */
export async function documentsByClient(
  clientUids: string[]
): Promise<Map<string, IIdentityDocument[]>> {
  const documents = await IdentityDocument.find({ clientUid: { $in: clientUids } });
  const byClient = new Map<string, IIdentityDocument[]>();
  for (const document of documents) {
    const list = byClient.get(document.clientUid) || [];
    list.push(document);
    byClient.set(document.clientUid, list);
  }
  return byClient;
}

export async function deleteDocument(clientUid: string, side: DocumentSide): Promise<boolean> {
  const result = await IdentityDocument.deleteOne({ clientUid, side });
  return result.deletedCount > 0;
}
