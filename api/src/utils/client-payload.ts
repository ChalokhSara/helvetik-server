import { IClient } from '../models/client.model';

/**
 * Normalisation du corps JSON décrivant un client (md_client).
 * Partagé entre l'inscription (client titulaire) et l'ajout d'un membre
 * de la famille. Les règles de fond (formats, énumérations, obligation)
 * restent portées par le schéma Mongoose : on ne les duplique pas ici.
 */

export interface ClientPayload {
  /** Identité : facultative, complétée après coup par lecture d'une pièce. */
  name?: string;
  firstname?: string;
  birthdate?: Date;
  nationality?: string;
  sexe?: string;
  email: string;
  phone?: string;
  road: string;
  plz: string;
  location: string;
  canton: string;
  avsNum: string;
}

export interface ClientPayloadResult {
  values?: ClientPayload;
  error?: string;
  /** Champ fautif, pour le signaler dans le formulaire. */
  field?: string;
}

export function readClientPayload(
  body: unknown,
  defaults: { email?: string } = {}
): ClientPayloadResult {
  if (!body || typeof body !== 'object') {
    return { error: 'Les données du client sont manquantes.' };
  }

  const source = body as Record<string, unknown>;
  const str = (key: string) => String(source[key] ?? '').trim();

  // La date de naissance n'est plus exigée : l'inscription se limite au
  // contact, à l'adresse et au numéro AVS. Elle reste vérifiée dès qu'elle
  // est fournie, car une date fausse fausserait toute la comparaison.
  let birthdate: Date | undefined;
  const rawBirthdate = str('birthdate');
  if (rawBirthdate) {
    birthdate = new Date(rawBirthdate);
    if (Number.isNaN(birthdate.getTime())) {
      return { error: 'La date de naissance est invalide.', field: 'birthdate' };
    }
    if (birthdate.getTime() > Date.now()) {
      return { error: 'La date de naissance ne peut pas être dans le futur.', field: 'birthdate' };
    }
  }

  // Les champs facultatifs vides sont omis plutôt qu'enregistrés à '' : une
  // chaîne vide échouerait sur les énumérations (sexe) et ferait passer une
  // fiche incomplète pour une fiche remplie.
  const optional = (key: string) => str(key) || undefined;

  return {
    values: {
      name: optional('name'),
      firstname: optional('firstname'),
      birthdate,
      nationality: optional('nationality'),
      sexe: optional('sexe'),
      email: (str('email') || defaults.email || '').toLowerCase(),
      phone: optional('phone'),
      road: str('road'),
      plz: str('plz'),
      location: str('location'),
      canton: str('canton'),
      avsNum: str('avsNum')
    }
  };
}

/** Représentation d'un client renvoyée à l'application mobile. */
export function serializeClient(client: IClient) {
  return {
    uid: client.uid,
    name: client.name,
    firstname: client.firstname,
    birthdate: client.birthdate,
    email: client.email,
    phone: client.phone,
    road: client.road,
    plz: client.plz,
    location: client.location,
    canton: client.canton,
    nationality: client.nationality,
    avsNum: client.avsNum,
    sexe: client.sexe,
    blocked: client.blocked
  };
}
