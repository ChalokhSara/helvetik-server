import nodemailer, { Transporter } from 'nodemailer';

/**
 * Envoi d'emails via SMTP.
 *
 * En développement, docker-compose fournit Mailpit : les messages ne sortent
 * jamais de la machine et sont consultables sur http://localhost:8025.
 *
 * Sans `SMTP_HOST`, le transport est désactivé et le message est simplement
 * écrit dans les logs — l'API reste utilisable sans infrastructure email.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

const MAIL_FROM = process.env.MAIL_FROM || 'Helvetik <no-reply@helvetik.local>';

// `undefined` = pas encore initialisé, `null` = pas de SMTP configuré.
let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) {
    return transporter;
  }

  const host = process.env.SMTP_HOST;
  if (!host) {
    console.warn('[mail] SMTP_HOST non défini : les emails sont écrits dans les logs.');
    transporter = null;
    return null;
  }

  /**
   * Le relais interne (conteneur Postfix sur le réseau Docker) annonce
   * STARTTLS avec un certificat auto-signé, que nodemailer refuse : la
   * connexion se ferme et rien ne part. Sur un réseau Docker privé, le trafic
   * ne quitte pas la machine, on renonce donc à STARTTLS.
   *
   * Vers un relais accessible par Internet, ce réglage doit rester à `false` :
   * sans TLS, identifiants et messages circuleraient en clair.
   */
  const ignoreTLS = process.env.SMTP_IGNORE_TLS === 'true';
  const looksInternal = /^(mailer|mailpit|localhost|127\.0\.0\.1|smtp)$/i.test(host);
  if (ignoreTLS && !looksInternal) {
    console.warn(
      `[mail] SMTP_IGNORE_TLS est actif alors que le relais « ${host} » semble externe : ` +
      'les identifiants et les messages circuleraient en clair. Passez SMTP_IGNORE_TLS à false.'
    );
  }

  transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 1025),
    secure: process.env.SMTP_SECURE === 'true',
    ignoreTLS,
    // Mailpit accepte les connexions anonymes ; un relais réel exige des identifiants.
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' }
      : undefined
  });

  return transporter;
}

/** Repli de développement : sans ce log, un SMTP absent rend les comptes inconfirmables. */
function logMessage(message: MailMessage, reason: string): void {
  if (process.env.NODE_ENV === 'production') {
    // Le corps contient le jeton de confirmation : jamais dans les logs de production.
    console.error(`[mail] ${reason} — message à ${message.to} non envoyé.`);
    return;
  }
  console.log(`[mail] ${reason}\nà: ${message.to} | sujet: ${message.subject}\n${message.text}`);
}

/**
 * N'échoue jamais : un envoi raté ne doit pas faire échouer l'inscription,
 * qui est déjà enregistrée à ce stade. L'utilisateur peut demander un renvoi.
 */
export async function sendMail(message: MailMessage): Promise<boolean> {
  const transport = getTransporter();

  if (!transport) {
    logMessage(message, 'SMTP non configuré');
    return false;
  }

  try {
    await transport.sendMail({
      from: MAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text
    });
    return true;
  } catch (err) {
    console.error('[mail] Échec de l\'envoi:', err);
    logMessage(message, 'envoi SMTP en échec');
    return false;
  }
}

export function confirmationUrl(token: string, baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/auth/confirm-email?token=${token}`;
}

export interface CancellationReminder {
  to: string;
  insuredName: string;
  provider: string;
  productName: string;
  policyNumber: string;
  deadline: Date;
  endDate: Date;
  daysLeft: number;
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString('fr-CH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

export async function sendCancellationReminder(reminder: CancellationReminder): Promise<boolean> {
  const delay = reminder.daysLeft <= 0
    ? 'C\'est aujourd\'hui le dernier jour.'
    : `Il vous reste ${reminder.daysLeft} jour(s) pour agir.`;

  return sendMail({
    to: reminder.to,
    subject: `Helvetik — résiliation possible jusqu'au ${formatDate(reminder.deadline)} : ${reminder.provider}`,
    text: [
      `Bonjour,`,
      '',
      `Le contrat suivant peut être résilié jusqu'au ${formatDate(reminder.deadline)}.`,
      delay,
      '',
      `  Assuré       : ${reminder.insuredName}`,
      `  Prestataire  : ${reminder.provider}`,
      `  Offre        : ${reminder.productName}`,
      `  N° de police : ${reminder.policyNumber}`,
      `  Fin de la période en cours : ${formatDate(reminder.endDate)}`,
      '',
      'Passé cette date, le contrat sera reconduit pour une nouvelle période.',
      'Si vous souhaitez le conserver, aucune action n\'est nécessaire.',
      '',
      'L\'équipe Helvetik'
    ].join('\n')
  });
}

/**
 * `baseUrl` provient de la requête à l'origine de l'envoi (cf. utils/base-url),
 * pour que le lien pointe vers l'adresse par laquelle l'utilisateur est arrivé.
 */
export async function sendConfirmationEmail(
  to: string,
  token: string,
  baseUrl: string
): Promise<boolean> {
  const url = confirmationUrl(token, baseUrl);

  return sendMail({
    to,
    subject: 'Helvetik — confirmez votre adresse email',
    text: [
      'Bienvenue chez Helvetik.',
      '',
      'Confirmez votre adresse email en ouvrant ce lien :',
      url,
      '',
      'Ce lien expire dans 24 heures.'
    ].join('\n')
  });
}
