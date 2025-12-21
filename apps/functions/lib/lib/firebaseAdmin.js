import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
export { Timestamp, FieldValue };
let cached;
export function ensureAdminApp() {
    if (getApps().length === 0)
        initializeApp();
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
