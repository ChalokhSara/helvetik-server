import PDFDocument from 'pdfkit';
import { IClient } from '../models/client.model';
import { IInsurance } from '../models/insurance.model';

/**
 * Lettres de résiliation et d'affiliation, en PDF.
 *
 * Changer de caisse maladie tient en deux courriers recommandés à envoyer
 * avant le 30 novembre : l'un résilie l'assurance de base actuelle, l'autre
 * demande l'affiliation à la nouvelle. Les caisses les acceptent sur papier
 * libre, mais elles y exigent des mentions précises — sans le numéro de
 * police, sans la date de naissance ou sans signature manuscrite, le courrier
 * est écarté et l'assuré s'en aperçoit en janvier.
 *
 * D'où un document produit ici plutôt qu'un modèle à remplir à la main : les
 * champs viennent de la fiche de l'assuré et de son contrat, et rien ne peut
 * être oublié.
 *
 * Le PDF est engendré en mémoire et renvoyé tel quel. Aucune trace sur le
 * disque : la lettre porte le nom, l'adresse et le numéro d'assuré, et elle se
 * reconstruit à l'identique à la demande suivante.
 */

/** Marges d'une lettre commerciale suisse, en points (1 pt = 1/72 pouce). */
const MARGIN = 64;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

export type LetterKind = 'CANCELLATION' | 'ENROLMENT';

export interface LetterRecipient {
  /** Nom de la caisse, tel qu'il figure au catalogue officiel. */
  name: string;
  /** Adresse postale officielle, telle que l'OFSP la publie. */
  lines?: string[];
}

export interface LetterInput {
  kind: LetterKind;
  client: IClient;
  recipient: LetterRecipient;
  /** Année d'effet : la résiliation prend effet au 31.12 de l'année précédente. */
  effectiveYear: number;
  /** Contrat résilié — sa police et sa caisse figurent dans la lettre. */
  contract?: IInsurance;
  /** Caisse quittée, nommée dans la lettre d'affiliation. */
  currentInsurerName?: string;
  /** Franchise choisie chez la nouvelle caisse. */
  franchise?: number;
  /** Modèle choisi, cité pour lever toute ambiguïté à la souscription. */
  tariffLabel?: string;
  /** Vrai quand l'employeur couvre l'accident : la LAMal l'exclut alors. */
  employerAccidentCoverage?: boolean;
  /** Signature manuscrite, image PNG ou JPEG déchiffrée. */
  signature?: Buffer;
  /** Lieu d'émission, repris de la localité de l'assuré. */
  place?: string;
  date?: Date;
}

const MONTHS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
];

// Les dates du projet sont toutes en UTC — dates de naissance comprises, qui
// n'ont pas d'heure. Les lire en heure locale décalerait certaines d'un jour.
function longDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function shortDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`;
}

/** Nom complet, ou l'email à défaut : une lettre sans nom reste envoyable. */
function fullName(client: IClient): string {
  return [client.firstname, client.name].filter(Boolean).join(' ').trim() || client.email;
}

/**
 * Date limite de résiliation de l'assurance de base.
 *
 * La loi veut que la résiliation soit *parvenue* à la caisse le 30 novembre au
 * plus tard, pas seulement postée. La lettre le rappelle, parce que c'est la
 * seule échéance qui compte et celle qu'on manque.
 */
export function cancellationDeadlineFor(effectiveYear: number): Date {
  // En UTC, comme toutes les dates du projet : construite en heure locale,
  // elle s'affichait au 29 novembre sur un serveur réglé sur Europe/Zurich,
  // le formatage se faisant lui en UTC. Un jour d'écart sur cette échéance-là
  // ferait manquer le changement d'une année entière.
  return new Date(Date.UTC(effectiveYear - 1, 10, 30));
}

export function letterTitle(kind: LetterKind, effectiveYear: number): string {
  return kind === 'CANCELLATION'
    ? `Résiliation de l'assurance obligatoire des soins au 31.12.${effectiveYear - 1}`
    : `Adhésion à l'assurance obligatoire des soins dès le 1er janvier ${effectiveYear}`;
}

/** Nom de fichier proposé au téléchargement. */
export function letterFilename(input: LetterInput): string {
  const who = fullName(input.client)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const what = input.kind === 'CANCELLATION' ? 'resiliation' : 'affiliation';
  return `${what}-${who}-${input.effectiveYear}.pdf`;
}

/** Corps de la lettre, paragraphe par paragraphe. */
function bodyParagraphs(input: LetterInput): string[] {
  const client = input.client;

  if (input.kind === 'CANCELLATION') {
    const police = input.contract?.policyNumber
      ? `, police n° ${input.contract.policyNumber}`
      : '';

    return [
      'Madame, Monsieur,',
      `Par la présente, je résilie mon assurance obligatoire des soins (LAMal)` +
      `${police} auprès de votre compagnie, avec effet au 31 décembre ` +
      `${input.effectiveYear - 1}.`,
      'Je vous prie de me faire parvenir une confirmation écrite de cette ' +
      'résiliation, ainsi que le décompte final de mes primes.',
      'Cette résiliation ne concerne que l\'assurance de base. Mes éventuelles ' +
      'assurances complémentaires ne sont pas visées par la présente.',
      'Je vous prie d\'agréer, Madame, Monsieur, mes salutations distinguées.'
    ];
  }

  // Affiliation : la caisse doit pouvoir ouvrir le dossier sans nous relancer,
  // d'où la franchise, le modèle et la couverture accident dès le courrier.
  const franchise = input.franchise !== undefined
    ? `avec une franchise annuelle de ${input.franchise} francs`
    : 'avec la franchise légale minimale';
  const accident = input.employerAccidentCoverage
    ? 'sans couverture du risque accidents, celui-ci étant couvert par mon employeur'
    : 'avec couverture du risque accidents';
  const model = input.tariffLabel
    ? ` Je souhaite le modèle « ${input.tariffLabel} ».`
    : '';

  return [
    'Madame, Monsieur,',
    `Par la présente, je vous demande de m'affilier dès le 1er janvier ` +
    `${input.effectiveYear} à l'assurance obligatoire des soins (LAMal) auprès de ` +
    `votre compagnie, ${franchise}, ${accident}.${model}`,
    input.currentInsurerName
      ? `Je vous prie de transmettre dans les meilleurs délais une attestation ` +
        `d'assurance à mon assureur actuel, ${input.currentInsurerName}, afin ` +
        `qu'il n'y ait aucune interruption de ma couverture.`
      : 'Je vous prie de transmettre dans les meilleurs délais une attestation ' +
        'd\'assurance à mon assureur actuel, afin qu\'il n\'y ait aucune ' +
        'interruption de ma couverture.',
    'Vous trouverez ci-joint une copie de ma pièce d\'identité.',
    'Dans l\'attente de votre confirmation, je vous prie d\'agréer, Madame, ' +
    'Monsieur, mes salutations distinguées.'
  ];
}

/**
 * Produit la lettre et renvoie le PDF complet.
 *
 * La mise en page suit l'usage suisse : expéditeur en haut à gauche,
 * destinataire à droite dans la zone de la fenêtre d'enveloppe, lieu et date,
 * objet en gras, corps justifié, signature en bas.
 */
export function renderLetter(input: LetterInput): Promise<Buffer> {
  const client = input.client;
  // Le jour courant tel que l'assuré le voit : les autres dates de la lettre
  // sont stockées en UTC, celle-ci est une date de rédaction.
  const now = input.date ?? new Date();
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const place = input.place || client.location;

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: {
      Title: letterTitle(input.kind, input.effectiveYear),
      Author: fullName(client)
    }
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // --- expéditeur
  const senderTop = doc.y;
  doc.fontSize(10).font('Helvetica');
  const sender = [
    fullName(client),
    client.road,
    `${client.plz} ${client.location}`,
    client.birthdate ? `Né(e) le ${shortDate(client.birthdate)}` : null,
    client.avsNum ? `N° AVS ${client.avsNum}` : null
  ].filter(Boolean) as string[];
  doc.text(sender.join('\n'), MARGIN, senderTop, { width: CONTENT_WIDTH / 2 });

  // --- destinataire, dans la zone de la fenêtre d'enveloppe
  const recipientLeft = MARGIN + CONTENT_WIDTH / 2;
  doc.font('Helvetica-Bold').text('RECOMMANDÉ', recipientLeft, senderTop, {
    width: CONTENT_WIDTH / 2
  });
  doc.moveDown(0.8);
  doc.font('Helvetica').text(
    [input.recipient.name, ...(input.recipient.lines || [])].join('\n'),
    recipientLeft,
    doc.y,
    { width: CONTENT_WIDTH / 2 }
  );

  // --- lieu et date, sous les deux blocs
  const afterHeader = Math.max(doc.y, senderTop + 110);
  doc.text(`${place}, le ${longDate(date)}`, recipientLeft, afterHeader + 24, {
    width: CONTENT_WIDTH / 2
  });

  // --- objet
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text(letterTitle(input.kind, input.effectiveYear), MARGIN, doc.y + 36, {
    width: CONTENT_WIDTH
  });

  // --- corps
  doc.font('Helvetica').fontSize(11);
  doc.moveDown(1.5);
  for (const paragraph of bodyParagraphs(input)) {
    doc.text(paragraph, { width: CONTENT_WIDTH, align: 'justify' });
    doc.moveDown(1);
  }

  // --- signature
  doc.moveDown(1.5);
  const signatureTop = doc.y;
  doc.fontSize(10).text('Signature :', MARGIN, signatureTop, { width: CONTENT_WIDTH });

  if (input.signature) {
    try {
      // Hauteur bornée : une signature capturée sur téléphone peut être très
      // grande, et elle ne doit pas repousser la mention légale sur une
      // seconde page.
      doc.image(input.signature, MARGIN, signatureTop + 14, { fit: [200, 70] });
      doc.y = signatureTop + 14 + 70;
    } catch {
      // Une image illisible ne doit pas empêcher d'imprimer la lettre : on
      // laisse la place pour une signature à la main.
      doc.y = signatureTop + 70;
    }
  } else {
    doc.y = signatureTop + 70;
  }

  doc.moveDown(0.5);
  doc.fontSize(10).text(fullName(client), MARGIN, doc.y, { width: CONTENT_WIDTH });

  // --- rappel de l'échéance, en pied de page
  if (input.kind === 'CANCELLATION') {
    const deadline = cancellationDeadlineFor(input.effectiveYear);
    doc.moveDown(2);
    doc.fontSize(8).fillColor('#555555').text(
      `À envoyer en recommandé. La résiliation doit être parvenue à la caisse le ` +
      `${shortDate(deadline)} au plus tard : c'est la date de réception qui fait foi, ` +
      'pas celle de l\'envoi.',
      MARGIN, doc.y, { width: CONTENT_WIDTH }
    );
  }

  doc.end();
  return done;
}
