import { initializeApp, getApps } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getStorage, connectStorageEmulator } from 'firebase/storage';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
};

function assertEnv(name: string, value: string | undefined) {
  if (!value) throw new Error(`Missing env var ${name}`);
}

export function getFirebaseApp() {
  assertEnv('NEXT_PUBLIC_FIREBASE_API_KEY', firebaseConfig.apiKey);
  assertEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', firebaseConfig.authDomain);
  assertEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', firebaseConfig.projectId);
  assertEnv('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET', firebaseConfig.storageBucket);
  assertEnv('NEXT_PUBLIC_FIREBASE_APP_ID', firebaseConfig.appId);

  if (getApps().length) return getApps()[0]!;
  return initializeApp(firebaseConfig);
}

export function getFirebaseAuth() {
  const auth = getAuth(getFirebaseApp());
  if (process.env.NEXT_PUBLIC_USE_EMULATORS === 'true') {
    try {
      connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
    } catch {
      // ignore double-connect
    }
  }
  return auth;
}

export function getFirebaseStorage() {
  const storage = getStorage(getFirebaseApp());
  if (process.env.NEXT_PUBLIC_USE_EMULATORS === 'true') {
    try {
      connectStorageEmulator(storage, 'localhost', 9199);
    } catch {
      // ignore double-connect
    }
  }
  return storage;
}
