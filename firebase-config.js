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
  apiKey: "AIzaSyAFs2HyfKEfwxqbxOYRhd1gDdOoCXsYpyo",
  authDomain: "zav-sklad.firebaseapp.com",
  projectId: "zav-sklad",
  storageBucket: "zav-sklad.firebasestorage.app",
  messagingSenderId: "484651242362",
  appId: "1:484651242362:web:181fc8ea6ea0ad9bbefcc3"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
let storage = null;
try { storage = firebase.storage(); } catch (e) { /* Storage не подключён — фото будут недоступны, это ок */ }
