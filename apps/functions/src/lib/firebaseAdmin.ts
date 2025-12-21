import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth, type Auth, type DecodedIdToken } from 'firebase-admin/auth';
import { getFirestore, type Firestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { getStorage, type Storage } from 'firebase-admin/storage';

export type { Auth, DecodedIdToken, Firestore, Storage };
export { Timestamp, FieldValue };

let cached:
  | {
      db: Firestore;
      auth: Auth;
      storage: Storage;
    }
  | undefined;

export function ensureAdminApp() {
  if (getApps().length === 0) initializeApp();
}

export function getAdmin() {
  ensureAdminApp();
  if (!cached) {
    cached = {
      db: getFirestore(),
      auth: getAuth(),
      storage: getStorage()
    };
  }
  return cached;
}
