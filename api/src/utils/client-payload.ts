import { IClient } from '../models/client.model';

/**
 * Normalisation du corps JSON décrivant un client (md_client).
 * Partagé entre l'inscription (client titulaire) et l'ajout d'un membre
 * de la famille. Les règles de fond (formats, énumérations, obligation)
 * restent portées par le schéma Mongoose : on ne les duplique pas ici.
 */

export interface ClientPayload {
  name: string;
  firstname: string;
  birthdate: Date;
  email: string;
  phone: string;
  road: string;
  plz: string;
  location: string;
  canton: string;
  nationality: string;
  avsNum: string;
  sexe: string;
}

export interface ClientPayloadResult {
  values?: ClientPayload;
  error?: string;
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

  const rawBirthdate = str('birthdate');
  if (!rawBirthdate) {
    return { error: 'La date de naissance est obligatoire.' };
  }

  const birthdate = new Date(rawBirthdate);
  if (Number.isNaN(birthdate.getTime())) {
    return { error: 'La date de naissance est invalide.' };
  }
  if (birthdate.getTime() > Date.now()) {
    return { error: 'La date de naissance ne peut pas être dans le futur.' };
  }

  return {
    values: {
      name: str('name'),
      firstname: str('firstname'),
      birthdate,
      email: (str('email') || defaults.email || '').toLowerCase(),
      phone: str('phone'),
      road: str('road'),
      plz: str('plz'),
      location: str('location'),
      canton: str('canton'),
      nationality: str('nationality'),
      avsNum: str('avsNum'),
      sexe: str('sexe')
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
