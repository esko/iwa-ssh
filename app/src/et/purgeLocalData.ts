import { credentialVault } from '../security/credentialVault';
import { purgeAllEtLocalData as purgeEtStores, summarizeEtLocalData, type EtLocalDataSummary } from '../storage/indexedDb';
import { resetSessionCheckpointFlushes } from './sessionStore';

export type { EtLocalDataSummary };

export async function readEtLocalDataSummary(): Promise<EtLocalDataSummary> {
  return summarizeEtLocalData();
}

/** Wipe ET sessions, recovery data, device key, and dependent saved-password crypto. */
export async function purgeAllEtLocalData(): Promise<{ sessions: number; savedPasswords: number }> {
  resetSessionCheckpointFlushes();
  const result = await purgeEtStores();
  credentialVault.clearCache();
  return result;
}
