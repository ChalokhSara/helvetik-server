import { Setting, SettingKey } from '../models/setting.model';

/**
 * Interrupteurs de fonctionnalités.
 *
 * Ils ne suppriment rien : ils court-circuitent. Le code désactivé reste en
 * place, testé et prêt à resservir.
 *
 * Chaque réglage a deux sources, dans cet ordre :
 *   1. la base, alimentée par la console d'administration ;
 *   2. la variable d'environnement, qui donne la valeur initiale.
 *
 * Les valeurs sont tenues en mémoire pour que la lecture reste synchrone et
 * gratuite — elle a lieu à chaque connexion. Le cache est rafraîchi au
 * démarrage, à chaque enregistrement, et périodiquement pour le cas où
 * plusieurs instances tourneraient en parallèle.
 */

const REFRESH_INTERVAL_MS = 60_000;

const cache = new Map<SettingKey, string>();
let refreshTimer: NodeJS.Timeout | undefined;

/** Recharge les réglages depuis la base. Silencieux en cas d'échec : les
 *  valeurs d'environnement prennent alors le relais. */
export async function loadSettings(): Promise<void> {
  try {
    const settings = await Setting.find();
    cache.clear();
    for (const setting of settings) {
      cache.set(setting.key, setting.value);
    }
  } catch (err) {
    console.error('[réglages] chargement impossible, valeurs par défaut utilisées:', err);
  }
}

/** Démarre le rafraîchissement périodique du cache. */
export function startSettingsRefresh(): void {
  if (refreshTimer) {
    return;
  }
  refreshTimer = setInterval(() => { void loadSettings(); }, REFRESH_INTERVAL_MS);
  // Ne pas retenir le processus en vie pour ce seul minuteur.
  refreshTimer.unref?.();
}

function readBoolean(key: SettingKey, envDefault: boolean): boolean {
  const stored = cache.get(key);
  if (stored !== undefined) {
    return stored === 'true';
  }
  return envDefault;
}

/** Valeur d'origine d'un réglage, telle que configurée à l'environnement. */
export function environmentDefault(key: SettingKey): boolean {
  if (key === 'EMAIL_CONFIRMATION_REQUIRED') {
    return process.env.EMAIL_CONFIRMATION_REQUIRED !== 'false';
  }
  return false;
}

/** Vrai si le réglage a été fixé depuis la console, faux s'il suit l'environnement. */
export function isOverridden(key: SettingKey): boolean {
  return cache.has(key);
}

export function settingValue(key: SettingKey): boolean {
  return readBoolean(key, environmentDefault(key));
}

/**
 * Confirmation d'adresse email obligatoire avant de pouvoir se connecter.
 *
 * Désactivée, l'inscription rend le compte actif immédiatement et n'envoie
 * aucun email. Toute la mécanique reste en place : jetons, route de
 * confirmation, renvoi. Réactiver le réglage rétablit le parcours complet,
 * y compris pour les comptes créés entre-temps, qui restent utilisables.
 */
export function emailConfirmationRequired(): boolean {
  return settingValue('EMAIL_CONFIRMATION_REQUIRED');
}

/** Enregistre un réglage et met le cache à jour dans la foulée. */
export async function saveSetting(
  key: SettingKey,
  value: boolean,
  updatedBy?: string
): Promise<void> {
  await Setting.findOneAndUpdate(
    { key },
    { $set: { value: String(value), updatedBy } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  cache.set(key, String(value));
}

/** Rend la main à la valeur d'environnement. */
export async function resetSetting(key: SettingKey): Promise<void> {
  await Setting.deleteOne({ key });
  cache.delete(key);
}

/** Métadonnées d'un réglage, pour l'affichage dans la console. */
export async function describeSetting(key: SettingKey) {
  const stored = await Setting.findOne({ key });
  return {
    key,
    value: settingValue(key),
    overridden: Boolean(stored),
    environmentDefault: environmentDefault(key),
    updatedAt: stored?.updatedAt,
    updatedBy: stored?.updatedBy
  };
}
