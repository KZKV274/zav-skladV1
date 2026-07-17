// ============================================================
// НАСТРОЙКА FIREBASE
// ============================================================
// 1. Зайди на https://console.firebase.google.com
// 2. Создай проект (или используй существующий)
// 3. Включи Firestore Database (режим "test mode" или свои правила — см. README.md)
// 4. Если хочешь прикреплять фото — включи Storage
// 5. Project settings → General → "Your apps" → Web app → скопируй объект
//    конфигурации и вставь его вместо примера ниже.
// ============================================================

const firebaseConfig = {
  apiKey: "ВСТАВЬ_СЮДА",
  authDomain: "ВСТАВЬ_СЮДА.firebaseapp.com",
  projectId: "ВСТАВЬ_СЮДА",
  storageBucket: "ВСТАВЬ_СЮДА.appspot.com",
  messagingSenderId: "ВСТАВЬ_СЮДА",
  appId: "ВСТАВЬ_СЮДА"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
let storage = null;
try { storage = firebase.storage(); } catch (e) { /* Storage не подключён — фото будут недоступны, это ок */ }
