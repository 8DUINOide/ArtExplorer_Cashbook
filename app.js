"use strict";

const DB_NAME = "artexplorer-cashbook";
const DB_VERSION = 1;
const FIREBASE_VERSION = "13.3.0";
const CONFIG_KEY = "artexplorer-firebase-config-v1";
const CATEGORIES = {
  income: ["Printing", "Computer services", "Repair", "Other"],
  expense: ["Supplies", "Maintenance", "Utilities", "Other"]
};
let dbPromise;
let firebaseModules = null;
let firebaseAuth = null;
let firebaseDb = null;
let firebaseAppConfigString = "";
let currentUser = null;
let syncInProgress = false;
let syncRequested = false;
let toastTimer;
let lastRenderedDay = "";
let todayNetCashCents = 0;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve, reject) {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = function () {
      const db = request.result;
      if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "id" });
      if (!db.objectStoreNames.contains("lenders")) db.createObjectStore("lenders", { keyPath: "id" });
    };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
  return dbPromise;
}

async function readAll(storeName) {
  const db = await openDatabase();
  return new Promise(function (resolve, reject) {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = function () { resolve(request.result || []); };
    request.onerror = function () { reject(request.error); };
  });
}

async function readOne(storeName, id) {
  const db = await openDatabase();
  return new Promise(function (resolve, reject) {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(id);
    request.onsuccess = function () { resolve(request.result || null); };
    request.onerror = function () { reject(request.error); };
  });
}

async function writeOne(storeName, value) {
  const db = await openDatabase();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = function () { resolve(value); };
    tx.onerror = function () { reject(tx.error); };
    tx.onabort = function () { reject(tx.error || new Error("The local save was cancelled.")); };
  });
}

function makeId(prefix) {
  const id = window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
  return prefix ? prefix + "_" + id : id;
}

function todayKey() {
  const now = new Date();
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
}

function dayLabel(dateString) {
  const parts = dateString.split("-").map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  return date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function shortDate(dateString) {
  const parts = dateString.split("-").map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function centsFromInput(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

function money(cents) {
  return "₱" + (Number(cents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}

function getPaymentId(date, lenderId) {
  return "payment_" + date + "_" + lenderId;
}

function showToast(message, isError) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.toggle("error", Boolean(isError));
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(function () { toast.classList.remove("show"); }, 2800);
}

function setSyncBadge(state, label) {
  const pill = document.getElementById("sync-status");
  pill.className = "sync-pill" + (state ? " " + state : "");
  pill.lastElementChild.textContent = label;
}

function setFirebaseMessage(message, state) {
  const element = document.getElementById("firebase-message");
  element.textContent = message;
  element.className = "inline-message" + (state ? " " + state : "");
}

function readFirebaseConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || "null"); }
  catch (_) { return null; }
}

function configFromForm() {
  return {
    apiKey: document.getElementById("firebase-api-key").value.trim(),
    authDomain: document.getElementById("firebase-auth-domain").value.trim(),
    projectId: document.getElementById("firebase-project-id").value.trim(),
    appId: document.getElementById("firebase-app-id").value.trim()
  };
}

function hasConfig(config) {
  return Boolean(config && config.apiKey && config.authDomain && config.projectId && config.appId);
}

function loadSavedFirebaseConfig() {
  const config = readFirebaseConfig();
  if (!config) return;
  document.getElementById("firebase-api-key").value = config.apiKey || "";
  document.getElementById("firebase-auth-domain").value = config.authDomain || "";
  document.getElementById("firebase-project-id").value = config.projectId || "";
  document.getElementById("firebase-app-id").value = config.appId || "";
}

async function loadFirebaseSdk() {
  if (firebaseModules) return firebaseModules;
  if (!navigator.onLine) throw new Error("Firebase needs an internet connection. Your local records still work.");
  const base = "https://www.gstatic.com/firebasejs/" + FIREBASE_VERSION + "/";
  const loaded = await Promise.all([
    import(base + "firebase-app.js"),
    import(base + "firebase-auth.js"),
    import(base + "firebase-firestore.js")
  ]);
  firebaseModules = {
    app: loaded[0],
    auth: loaded[1],
    firestore: loaded[2]
  };
  return firebaseModules;
}

async function getFirebaseServices() {
  const config = readFirebaseConfig();
  if (!hasConfig(config)) throw new Error("Save all four Firebase Web app values in Setup first.");
  const sdk = await loadFirebaseSdk();
  let app = sdk.app.getApps().find(function (item) { return item.name === "artexplorer-cashbook"; });
  const configString = JSON.stringify(config);
  if (app && firebaseAppConfigString && firebaseAppConfigString !== configString) {
    await sdk.app.deleteApp(app);
    app = null;
    firebaseAuth = null;
    firebaseDb = null;
  }
  if (!app) app = sdk.app.initializeApp(config, "artexplorer-cashbook");
  firebaseAppConfigString = configString;
  firebaseAuth = sdk.auth.getAuth(app);
  firebaseDb = sdk.firestore.getFirestore(app);
  return sdk;
}

function cloudCollection(sdk, userId, name) {
  return sdk.firestore.collection(firebaseDb, "users", userId, name);
}

function withoutLocalFields(record) {
  const copy = Object.assign({}, record);
  delete copy.syncState;
  return copy;
}

async function markSyncState(storeName, record, state) {
  const next = Object.assign({}, record, { syncState: state });
  await writeOne(storeName, next);
  return next;
}

async function syncNow() {
  if (syncInProgress) {
    syncRequested = true;
    return;
  }
  if (!navigator.onLine) {
    setSyncBadge("", "Offline · saved here");
    return;
  }
  const config = readFirebaseConfig();
  if (!hasConfig(config) || !currentUser || !firebaseDb || !firebaseModules) {
    setSyncBadge("", "Local only");
    return;
  }
  syncInProgress = true;
  setSyncBadge("syncing", "Syncing");
  setFirebaseMessage("Syncing this device with Firebase…", "");
  try {
    const sdk = firebaseModules;
    const uid = currentUser.uid;
    await syncCollection(sdk, uid, "entries");
    await syncLenders(sdk, uid);
    setSyncBadge("online", "Synced");
    setFirebaseMessage("Connected as " + currentUser.email + ". This device is synced.", "success");
    document.getElementById("firebase-signout").hidden = false;
    await renderApp();
  } catch (error) {
    console.error("Firebase sync failed", error);
    setSyncBadge("error", "Sync needs attention");
    setFirebaseMessage(firebaseErrorText(error), "error");
  } finally {
    syncInProgress = false;
    if (syncRequested) {
      syncRequested = false;
      window.setTimeout(syncNow, 50);
    }
  }
}

async function syncCollection(sdk, uid, storeName) {
  const firestore = sdk.firestore;
  const reference = cloudCollection(sdk, uid, storeName);
  const snapshot = await firestore.getDocs(reference);
  const remote = new Map();
  snapshot.forEach(function (docSnapshot) {
    const data = docSnapshot.data();
    data.id = data.id || docSnapshot.id;
    remote.set(data.id, data);
  });
  const local = await readAll(storeName);
  const localById = new Map(local.map(function (record) { return [record.id, record]; }));

  for (const [id, cloudRecord] of remote) {
    const localRecord = localById.get(id);
    if (!localRecord || Number(cloudRecord.updatedAtMs || 0) > Number(localRecord.updatedAtMs || 0)) {
      await writeOne(storeName, Object.assign({}, cloudRecord, { syncState: "synced" }));
      localById.set(id, Object.assign({}, cloudRecord, { syncState: "synced" }));
    } else if (Number(cloudRecord.updatedAtMs || 0) === Number(localRecord.updatedAtMs || 0)) {
      const synced = Object.assign({}, localRecord, { syncState: "synced" });
      await writeOne(storeName, synced);
      localById.set(id, synced);
    }
  }

  for (const [id, localRecord] of localById) {
    const cloudRecord = remote.get(id);
    if (!cloudRecord || Number(localRecord.updatedAtMs || 0) > Number(cloudRecord.updatedAtMs || 0)) {
      await firestore.setDoc(firestore.doc(reference, id), withoutLocalFields(localRecord));
      const synced = await markSyncState(storeName, localRecord, "synced");
      localById.set(id, synced);
    }
  }
}

async function syncLenders(sdk, uid) {
  const firestore = sdk.firestore;
  const reference = cloudCollection(sdk, uid, "lenders");
  const snapshot = await firestore.getDocs(reference);
  const remote = new Map();
  snapshot.forEach(function (docSnapshot) {
    const data = docSnapshot.data();
    data.id = data.id || docSnapshot.id;
    remote.set(data.id, data);
  });
  const local = await readAll("lenders");
  const localById = new Map(local.map(function (record) { return [record.id, record]; }));
  for (const [id, cloudRecord] of remote) {
    const localRecord = localById.get(id);
    if (!localRecord || Number(cloudRecord.updatedAtMs || 0) > Number(localRecord.updatedAtMs || 0)) {
      const next = Object.assign({}, cloudRecord, { syncState: "synced" });
      await writeOne("lenders", next);
      localById.set(id, next);
    } else if (Number(cloudRecord.updatedAtMs || 0) === Number(localRecord.updatedAtMs || 0)) {
      const next = Object.assign({}, localRecord, { syncState: "synced" });
      await writeOne("lenders", next);
      localById.set(id, next);
    }
  }
  for (const [id, localRecord] of localById) {
    const cloudRecord = remote.get(id);
    if (!cloudRecord || Number(localRecord.updatedAtMs || 0) > Number(cloudRecord.updatedAtMs || 0)) {
      await firestore.setDoc(firestore.doc(reference, id), withoutLocalFields(localRecord));
      await markSyncState("lenders", localRecord, "synced");
    }
  }
}

function firebaseErrorText(error) {
  const code = error && error.code ? error.code : "";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") return "Email or password was not accepted.";
  if (code === "auth/email-already-in-use") return "That email already has an account. Use Sign in instead.";
  if (code === "auth/weak-password") return "Choose a stronger password (at least 6 characters).";
  if (code === "auth/operation-not-allowed") return "Enable Email/Password sign-in in Firebase Authentication.";
  if (code === "permission-denied") return "Firestore denied access. Publish the included security rules and try again.";
  if (code === "unavailable" || !navigator.onLine) return "No internet connection. Records remain saved on this device.";
  return (error && error.message) ? error.message : "Could not connect to Firebase. Local records remain safe on this device.";
}

function updateFirebaseLogin(user) {
  currentUser = user || null;
  if (user) {
    document.getElementById("firebase-signout").hidden = false;
    setFirebaseMessage("Connected as " + (user.email || "owner") + ".", "success");
    setSyncBadge("online", "Connected");
  } else {
    document.getElementById("firebase-signout").hidden = true;
    setSyncBadge("", "Local only");
  }
}

async function connectFirebase(createAccount) {
  const config = configFromForm();
  if (!hasConfig(config)) {
    setFirebaseMessage("Enter and save your Firebase Web app values first.", "error");
    return;
  }
  const saved = readFirebaseConfig();
  if (JSON.stringify(config) !== JSON.stringify(saved)) {
    setFirebaseMessage("Save the Firebase settings first, then sign in.", "error");
    return;
  }
  const email = document.getElementById("firebase-email").value.trim();
  const password = document.getElementById("firebase-password").value;
  if (!email || !password) {
    setFirebaseMessage("Enter the owner email and password.", "error");
    return;
  }
  setSyncBadge("syncing", createAccount ? "Creating account" : "Connecting");
  setFirebaseMessage("Connecting to Firebase…", "");
  try {
    const sdk = await getFirebaseServices();
    await sdk.auth.setPersistence(firebaseAuth, sdk.auth.browserLocalPersistence);
    const credential = createAccount
      ? await sdk.auth.createUserWithEmailAndPassword(firebaseAuth, email, password)
      : await sdk.auth.signInWithEmailAndPassword(firebaseAuth, email, password);
    updateFirebaseLogin(credential.user);
    document.getElementById("firebase-password").value = "";
    await syncNow();
  } catch (error) {
    console.error("Firebase connection failed", error);
    setSyncBadge("error", "Not connected");
    setFirebaseMessage(firebaseErrorText(error), "error");
  }
}

async function restoreFirebaseSession() {
  const config = readFirebaseConfig();
  if (!hasConfig(config) || !navigator.onLine) return;
  try {
    const sdk = await getFirebaseServices();
    const auth = firebaseAuth;
    const user = await new Promise(function (resolve) {
      let unsubscribe = null;
      unsubscribe = sdk.auth.onAuthStateChanged(auth, function (value) {
        if (unsubscribe) unsubscribe();
        resolve(value || null);
      }, function () { resolve(null); });
    });
    updateFirebaseLogin(user);
    if (user) await syncNow();
  } catch (error) {
    console.info("Firebase session is not available yet", error);
    setSyncBadge("", "Local only");
  }
}

function scheduleSync() {
  if (currentUser && navigator.onLine) window.setTimeout(syncNow, 150);
}

async function getActiveLenders() {
  const rows = await readAll("lenders");
  return rows.filter(function (row) { return row.active !== false; }).sort(function (a, b) {
    return Number(a.order || 0) - Number(b.order || 0) || String(a.name).localeCompare(String(b.name));
  });
}

async function getEntriesForDate(date) {
  const rows = await readAll("entries");
  return rows.filter(function (entry) { return entry.date === date; });
}

function entryDisplayTitle(entry) {
  if (entry.type === "income") return entry.category || "Income";
  if (entry.type === "expense") return entry.category || "Expense";
  if (entry.type === "lender_payment") return entry.lenderName || "Lender payment";
  if (entry.type === "reimbursement") return "Staff reimbursement";
  if (entry.type === "cash_close") return "End-of-day cash count";
  return "Record";
}

function entryMeta(entry) {
  const parts = [shortDate(entry.date)];
  if (entry.type === "income") parts.push(entry.source === "other" ? "Other payment" : "Cash received");
  if (entry.type === "expense") {
    parts.push(entry.source === "personal" ? "Paid personally by " + (entry.employeeName || "staff") : entry.source === "other" ? "Other payment" : "Paid from shop cash");
  }
  if (entry.type === "lender_payment") {
    const sources = [];
    if (entry.shopCents > 0) sources.push("shop cash " + money(entry.shopCents));
    if (entry.personalCents > 0) sources.push((entry.employeeName || "Staff") + " personal money " + money(entry.personalCents));
    parts.push(entry.unpaid ? "Not paid yet" : (sources.join(" + ") || "Payment"));
    if (!entry.unpaid && Number(entry.dueCents || 0) > Number(entry.amountCents || 0)) parts.push("Partial · " + money(entry.dueCents - entry.amountCents) + " remaining");
  }
  if (entry.type === "reimbursement") parts.push("Paid to " + (entry.employeeName || "staff"));
  if (entry.type === "cash_close") {
    const difference = Number(entry.differenceCents || 0);
    parts.push("Opening " + money(entry.openingCents) + " · Expected " + money(entry.expectedCents) + " · " + (difference < 0 ? "Short " : difference > 0 ? "Over " : "Matches ") + money(Math.abs(difference)));
  }
  if (entry.note) parts.push(entry.note);
  return parts.join(" · ");
}

function activityHtml(entry) {
  const symbol = entry.type === "income" ? "+" : entry.type === "cash_close" ? "" : "−";
  const icon = entry.type === "income" ? "↗" : entry.type === "expense" ? "↙" : entry.type === "lender_payment" ? "↘" : "↗";
  const voidControl = entry.voided ? '<span class="activity-meta voided-label">Voided</span>' : entry.unpaid ? '<span class="activity-meta voided-label">Not paid</span>' : entry.type === "lender_payment" || entry.type === "cash_close" ? '<span class="activity-meta">Saved</span>' : '<button class="text-button void-action" data-entry="' + escapeHtml(entry.id) + '" type="button">Void</button>';
  const amountLabel = entry.unpaid ? "Due " + money(entry.dueCents) : entry.type === "cash_close" ? "Count " + money(entry.countedCents) : symbol + money(entry.amountCents);
  return '<div class="activity-item' + (entry.voided ? " voided-item" : entry.unpaid ? " unpaid-item" : "") + '">' +
    '<span class="activity-icon ' + escapeHtml(entry.type) + '">' + icon + "</span>" +
    '<div><div class="activity-title">' + escapeHtml(entryDisplayTitle(entry)) + '</div><div class="activity-meta">' + escapeHtml(entryMeta(entry)) + "</div></div>" +
    '<div class="activity-trailing"><div class="activity-amount ' + escapeHtml(entry.type) + '">' + amountLabel + "</div>" + voidControl + "</div>" +
    "</div>";
}

function staffBalanceMap(entries) {
  const balances = new Map();
  function add(name, amount) {
    const key = String(name || "").trim();
    if (!key) return;
    const lookup = key.toLocaleLowerCase();
    const current = balances.get(lookup) || { name: key, amount: 0 };
    current.amount += amount;
    balances.set(lookup, current);
  }
  entries.forEach(function (entry) {
    if (entry.voided) return;
    if (entry.type === "lender_payment" && entry.personalCents > 0) add(entry.employeeName, entry.personalCents);
    if (entry.type === "expense" && entry.source === "personal") add(entry.employeeName, entry.amountCents);
    if (entry.type === "reimbursement") add(entry.employeeName, -entry.amountCents);
  });
  return balances;
}

function totalStaffOwed(entries) {
  let total = 0;
  staffBalanceMap(entries).forEach(function (person) { total += Math.max(0, person.amount); });
  return total;
}

function sourceName(entry) {
  if (entry.type === "lender_payment") {
    const sources = [];
    if (entry.shopCents > 0) sources.push("shop " + money(entry.shopCents));
    if (entry.personalCents > 0) sources.push("personal " + money(entry.personalCents));
    return sources.join(" + ");
  }
  if (entry.source === "personal") return "personal money";
  if (entry.source === "other") return "other payment";
  return "shop cash";
}

async function renderToday() {
  const date = todayKey();
  const lenders = await getActiveLenders();
  await ensureDailyChecklist(lenders, date);
  const datedEntries = await getEntriesForDate(date);
  const entries = datedEntries.filter(function (entry) { return !entry.voided; });
  const payments = new Map(entries.filter(function (entry) { return entry.type === "lender_payment"; }).map(function (entry) { return [entry.lenderId, entry]; }));
  let dueTotal = 0;
  let paidTotal = 0;
  let fullyPaid = 0;
  const lenderHost = document.getElementById("lender-list");
  lenderHost.innerHTML = "";
  lenders.forEach(function (lender) {
    const due = Number(lender.dailyCents || 0);
    const payment = payments.get(lender.id);
    const paid = payment ? Number(payment.amountCents || 0) : 0;
    const left = Math.max(0, due - paid);
    dueTotal += due;
    paidTotal += paid;
    if (paid >= due && due > 0) fullyPaid += 1;
    const row = document.createElement("div");
    row.className = "lender-row";
    let status = "";
    if (paid >= due && due > 0) {
      status = '<div class="paid-label">Paid · ' + escapeHtml(sourceName(payment)) + ' <button class="text-button edit-payment" data-lender="' + escapeHtml(lender.id) + '" type="button">Edit</button></div>';
    } else if (paid > 0) {
      status = '<div class="paid-label partial">Part paid · ' + money(paid) + ' · ' + money(left) + ' left</div>';
    } else {
      status = '<div class="lender-actions"><button class="mini-button shop-pay" data-lender="' + escapeHtml(lender.id) + '" type="button">Paid from shop</button><button class="mini-button personal personal-pay" data-lender="' + escapeHtml(lender.id) + '" type="button">Paid personally</button><button class="mini-button partial partial-pay" data-lender="' + escapeHtml(lender.id) + '" type="button">Partial</button></div>';
    }
    if (paid > 0 && paid < due) {
      status = '<div class="lender-actions"><button class="mini-button shop-pay" data-lender="' + escapeHtml(lender.id) + '" type="button">Pay remaining</button><button class="mini-button personal personal-pay" data-lender="' + escapeHtml(lender.id) + '" type="button">Personal</button><button class="mini-button partial partial-pay" data-lender="' + escapeHtml(lender.id) + '" type="button">Add partial</button></div>';
    }
    if (paid >= due && due > 0) {
      status = '<div class="paid-label">Paid · ' + escapeHtml(sourceName(payment)) + ' <button class="text-button edit-payment" data-lender="' + escapeHtml(lender.id) + '" type="button">Edit</button></div>';
    }
    row.innerHTML = '<div><span class="lender-name">' + escapeHtml(lender.name) + '</span><span class="lender-sub">' + (paid > 0 && paid < due ? "Paid " + money(paid) + " · " + money(left) + " remaining" : (payment && paid > 0 ? "Recorded today" : "Daily payment")) + '</span></div>' +
      '<div class="lender-due">' + money(due) + "</div>" + status;
    lenderHost.appendChild(row);
  });

  document.getElementById("empty-lenders").hidden = lenders.length > 0;
  document.getElementById("payments-summary").hidden = lenders.length === 0;
  document.getElementById("payments-summary").innerHTML =
    "<span>Due today <strong>" + money(dueTotal) + "</strong></span>" +
    "<span>Recorded <strong>" + money(paidTotal) + "</strong></span>" +
    "<span>Fully paid <strong>" + fullyPaid + " / " + lenders.length + "</strong></span>";
  document.getElementById("metric-lenders").innerHTML = fullyPaid + ' <small>/ ' + lenders.length + " paid</small>";
  document.getElementById("metric-lenders-amount").textContent = money(paidTotal);
  document.getElementById("metric-lenders-sub").textContent = lenders.length
    ? "paid today · " + money(Math.max(0, dueTotal - paidTotal)) + " remaining"
    : "Set up your daily list";
  document.getElementById("today-date").textContent = dayLabel(date);

  const income = entries.filter(function (entry) { return entry.type === "income"; }).reduce(function (sum, entry) { return sum + Number(entry.amountCents || 0); }, 0);
  const expenses = entries.filter(function (entry) { return entry.type === "expense"; }).reduce(function (sum, entry) { return sum + Number(entry.amountCents || 0); }, 0);
  const cashIncome = entries.filter(function (entry) { return entry.type === "income" && entry.source !== "other"; }).reduce(function (sum, entry) { return sum + Number(entry.amountCents || 0); }, 0);
  const cashExpenses = entries.filter(function (entry) { return entry.type === "expense" && entry.source === "shop_cash"; }).reduce(function (sum, entry) { return sum + Number(entry.amountCents || 0); }, 0);
  const lenderCash = entries.filter(function (entry) { return entry.type === "lender_payment"; }).reduce(function (sum, entry) { return sum + Number(entry.shopCents || 0); }, 0);
  const reimbursements = entries.filter(function (entry) { return entry.type === "reimbursement"; }).reduce(function (sum, entry) { return sum + Number(entry.amountCents || 0); }, 0);
  const allEntries = await readAll("entries");
  const staffOwed = totalStaffOwed(allEntries);
  const netCashChange = cashIncome - cashExpenses - lenderCash - reimbursements;
  todayNetCashCents = netCashChange;
  document.getElementById("metric-income").textContent = money(income);
  document.getElementById("metric-expenses").textContent = money(expenses);
  document.getElementById("metric-staff-owed").textContent = money(staffOwed);
  document.getElementById("cash-income").textContent = money(cashIncome);
  document.getElementById("cash-expenses").textContent = money(cashExpenses);
  document.getElementById("cash-loans").textContent = money(lenderCash);
  document.getElementById("cash-reimbursements").textContent = money(reimbursements);
  document.getElementById("cash-net").textContent = money(netCashChange);
  document.getElementById("cash-net-row").classList.toggle("negative", netCashChange < 0);
  document.getElementById("cash-net-row").classList.toggle("positive", netCashChange >= 0);
  renderClosingPanel(date, allEntries);
  const recent = entries.slice().sort(function (a, b) { return Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0); }).slice(0, 5);
  document.getElementById("today-activity").innerHTML = recent.length ? recent.map(activityHtml).join("") : '<div class="empty-state compact"><p>No entries today yet. Start with income, an expense, or a lender payment.</p></div>';

  lenderHost.querySelectorAll(".shop-pay").forEach(function (button) {
    button.addEventListener("click", function () {
      const lender = lenders.find(function (item) { return item.id === button.dataset.lender; });
      const old = payments.get(button.dataset.lender);
      if (lender) recordRemainingFromShop(lender, old);
    });
  });
  lenderHost.querySelectorAll(".personal-pay").forEach(function (button) {
    button.addEventListener("click", function () {
      const lender = lenders.find(function (item) { return item.id === button.dataset.lender; });
      const old = payments.get(button.dataset.lender);
      if (lender) openPaymentDialog(lender, old, "personal");
    });
  });
  lenderHost.querySelectorAll(".partial-pay").forEach(function (button) {
    button.addEventListener("click", function () {
      const lender = lenders.find(function (item) { return item.id === button.dataset.lender; });
      const old = payments.get(button.dataset.lender);
      if (lender) openPaymentDialog(lender, old, "partial");
    });
  });
  lenderHost.querySelectorAll(".edit-payment").forEach(function (button) {
    button.addEventListener("click", function () {
      const lender = lenders.find(function (item) { return item.id === button.dataset.lender; });
      if (lender) openPaymentDialog(lender, payments.get(lender.id), "edit");
    });
  });
}

function renderClosingPanel(date, allEntries) {
  const todayClose = allEntries.find(function (entry) { return entry.type === "cash_close" && entry.date === date && !entry.voided; });
  const previousClose = allEntries.filter(function (entry) { return entry.type === "cash_close" && entry.date < date && !entry.voided; })
    .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })[0];
  const openingCents = todayClose ? Number(todayClose.openingCents || 0) : previousClose ? Number(previousClose.countedCents || 0) : 0;
  document.getElementById("opening-cash").value = (openingCents / 100).toFixed(2);
  document.getElementById("counted-cash").value = todayClose ? (Number(todayClose.countedCents || 0) / 100).toFixed(2) : "";
  updateClosingPreview();
  const cashActivity = allEntries.filter(function (entry) {
    if (entry.date !== date || entry.voided) return false;
    return (entry.type === "income" && entry.source !== "other") ||
      (entry.type === "expense" && entry.source === "shop_cash") ||
      (entry.type === "lender_payment" && Number(entry.shopCents || 0) > 0) ||
      entry.type === "reimbursement";
  });
  const lastMovement = cashActivity.reduce(function (latest, entry) { return Math.max(latest, Number(entry.updatedAtMs || 0)); }, 0);
  const stale = Boolean(todayClose && lastMovement > Number(todayClose.updatedAtMs || 0));
  document.getElementById("closing-state").textContent = todayClose ? (stale ? "Recount needed" : "Count saved") : "Not counted";
  document.getElementById("closing-state").className = "closing-state" + (stale ? " warning" : todayClose ? " saved" : "");
  document.getElementById("closing-note").textContent = stale
    ? "Cash activity changed after this count. Save a new count before closing."
    : previousClose && !todayClose
      ? "Opening cash was copied from the last saved closing count. Adjust it if the drawer changed before opening."
      : !previousClose && !todayClose
        ? "First day? Enter the actual cash in the drawer when the shop opens."
        : "You can update the count if the drawer is counted again.";
}

function updateClosingPreview() {
  const opening = centsFromInput(document.getElementById("opening-cash").value);
  const expected = opening + todayNetCashCents;
  document.getElementById("expected-cash").textContent = money(expected);
  const countedValue = document.getElementById("counted-cash").value;
  const differenceNode = document.getElementById("cash-difference");
  if (countedValue === "") {
    differenceNode.textContent = "Enter the closing count";
    differenceNode.className = "";
    return;
  }
  const difference = centsFromInput(countedValue) - expected;
  differenceNode.textContent = difference === 0 ? "Matches" : (difference > 0 ? "Over by " : "Short by ") + money(Math.abs(difference));
  differenceNode.className = difference === 0 ? "match" : difference > 0 ? "over" : "short";
}

async function saveClosingCount(event) {
  event.preventDefault();
  const openingCents = centsFromInput(document.getElementById("opening-cash").value);
  const countedValue = document.getElementById("counted-cash").value;
  if (openingCents < 0 || countedValue === "" || centsFromInput(countedValue) < 0) {
    showToast("Enter the opening amount and the physical closing count.", true);
    return;
  }
  const date = todayKey();
  const id = "cash_close_" + date;
  const existing = await readOne("entries", id);
  const countedCents = centsFromInput(countedValue);
  const expectedCents = openingCents + todayNetCashCents;
  const now = Date.now();
  await writeOne("entries", {
    id: id,
    type: "cash_close",
    date: date,
    amountCents: countedCents,
    openingCents: openingCents,
    countedCents: countedCents,
    expectedCents: expectedCents,
    differenceCents: countedCents - expectedCents,
    createdAtMs: existing ? Number(existing.createdAtMs || now) : now,
    updatedAtMs: now,
    syncState: "pending"
  });
  await renderApp();
  scheduleSync();
  showToast("Closing cash count saved.");
}

async function ensureDailyChecklist(lenders, date) {
  let changed = false;
  for (const lender of lenders) {
    const id = getPaymentId(date, lender.id);
    const existing = await readOne("entries", id);
    if (!existing) {
      const now = Date.now();
      await writeOne("entries", {
        id: id,
        type: "lender_payment",
        date: date,
        lenderId: lender.id,
        lenderName: lender.name,
        dueCents: Number(lender.dailyCents || 0),
        amountCents: 0,
        shopCents: 0,
        personalCents: 0,
        employeeName: "",
        unpaid: true,
        createdAtMs: now,
        updatedAtMs: now,
        syncState: "pending"
      });
      changed = true;
    } else if (!existing.voided && existing.unpaid && (existing.dueCents !== lender.dailyCents || existing.lenderName !== lender.name)) {
      existing.dueCents = Number(lender.dailyCents || 0);
      existing.lenderName = lender.name;
      existing.updatedAtMs = Date.now();
      existing.syncState = "pending";
      await writeOne("entries", existing);
      changed = true;
    }
  }
  if (changed) scheduleSync();
}

async function renderSetupLenders() {
  const lenders = await getActiveLenders();
  const host = document.getElementById("setup-lender-list");
  host.innerHTML = "";
  lenders.forEach(function (lender) {
    const row = document.createElement("div");
    row.className = "setup-lender-item";
    row.innerHTML = '<label class="field">Name<input class="lender-setup-name" value="' + escapeHtml(lender.name) + '" maxlength="60" aria-label="Lender name"></label>' +
      '<label class="field">Daily amount<input class="lender-setup-amount" type="number" min="0.01" step="0.01" inputmode="decimal" value="' + (Number(lender.dailyCents || 0) / 100).toFixed(2) + '" aria-label="Daily amount"></label>' +
      '<button class="remove-button" type="button" aria-label="Remove lender" title="Remove lender">×</button>';
    const nameInput = row.querySelector(".lender-setup-name");
    const amountInput = row.querySelector(".lender-setup-amount");
    async function saveLenderEdit() {
      const name = nameInput.value.trim();
      const cents = centsFromInput(amountInput.value);
      if (!name || cents <= 0) {
        showToast("Enter a lender name and a positive daily amount.", true);
        return;
      }
      const updated = Object.assign({}, lender, { name: name, dailyCents: cents, updatedAtMs: Date.now(), syncState: "pending" });
      await writeOne("lenders", updated);
      lender.name = updated.name;
      lender.dailyCents = updated.dailyCents;
      lender.updatedAtMs = updated.updatedAtMs;
      renderApp();
      scheduleSync();
    }
    nameInput.addEventListener("change", saveLenderEdit);
    amountInput.addEventListener("change", saveLenderEdit);
    row.querySelector(".remove-button").addEventListener("click", async function () {
      if (!window.confirm("Remove " + lender.name + " from future daily checklists? Past payments will remain in the activity record.")) return;
      await writeOne("lenders", Object.assign({}, lender, { active: false, updatedAtMs: Date.now(), syncState: "pending" }));
      showToast("Lender removed from the daily list.");
      await renderApp();
      scheduleSync();
    });
    host.appendChild(row);
  });
}

async function renderActivity() {
  const allEntries = await readAll("entries");
  const filter = document.getElementById("activity-filter").value;
  const filtered = allEntries.filter(function (entry) { return filter === "all" || entry.type === filter; })
    .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0); });
  document.getElementById("all-activity").innerHTML = filtered.map(activityHtml).join("");
  document.getElementById("empty-activity").hidden = filtered.length > 0;
  document.getElementById("all-activity").querySelectorAll(".void-action").forEach(function (button) {
    button.addEventListener("click", async function () {
      const entry = await readOne("entries", button.dataset.entry);
      if (!entry || entry.voided) return;
      if (!window.confirm("Void this record? It will stay in the activity history but be excluded from totals.")) return;
      entry.voided = true;
      entry.voidedAtMs = Date.now();
      entry.updatedAtMs = Date.now();
      entry.syncState = "pending";
      await writeOne("entries", entry);
      showToast("Record voided. It remains in the activity history.");
      await renderApp();
      scheduleSync();
    });
  });
}

function chartAmount(cents) {
  const amount = Number(cents || 0) / 100;
  if (amount >= 1000000) return "₱" + (amount / 1000000).toFixed(1) + "m";
  if (amount >= 1000) return "₱" + (amount / 1000).toFixed(1) + "k";
  return "₱" + amount.toFixed(0);
}

function renderMonthlyChart(weeks) {
  const width = 760;
  const height = 330;
  const left = 65;
  const right = 18;
  const top = 18;
  const bottom = 48;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  let maximum = 0;
  weeks.forEach(function (week) {
    maximum = Math.max(maximum, week.income, week.expenses, week.loans);
  });
  const scaleMaximum = maximum > 0 ? maximum * 1.15 : 100;
  let svg = '<svg class="monthly-chart" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="Weekly income, expenses, and lender payment comparison">';
  for (let tick = 0; tick <= 4; tick += 1) {
    const y = top + plotHeight - (plotHeight * tick / 4);
    const value = scaleMaximum * tick / 4;
    svg += '<line x1="' + left + '" y1="' + y + '" x2="' + (width - right) + '" y2="' + y + '" class="chart-gridline"/>';
    svg += '<text x="' + (left - 8) + '" y="' + (y + 4) + '" text-anchor="end" class="chart-axis-label">' + chartAmount(value) + "</text>";
  }
  const groupWidth = plotWidth / Math.max(weeks.length, 1);
  const barWidth = Math.min(24, groupWidth / 5);
  const series = [
    { key: "income", color: "#438655" },
    { key: "expenses", color: "#dc9850" },
    { key: "loans", color: "#6479a4" }
  ];
  weeks.forEach(function (week, index) {
    const groupCenter = left + groupWidth * index + groupWidth / 2;
    const spacing = barWidth + 5;
    const startX = groupCenter - (spacing * 3 - 5) / 2;
    series.forEach(function (item, seriesIndex) {
      const value = Number(week[item.key] || 0);
      const barHeight = Math.max(value > 0 ? 2 : 0, plotHeight * value / scaleMaximum);
      const x = startX + seriesIndex * spacing;
      const y = top + plotHeight - barHeight;
      svg += '<rect x="' + x + '" y="' + y + '" width="' + barWidth + '" height="' + barHeight + '" rx="3" fill="' + item.color + '"><title>' + escapeHtml(week.label) + " · " + escapeHtml(item.key) + ": " + money(value) + "</title></rect>";
    });
    svg += '<text x="' + groupCenter + '" y="' + (height - 15) + '" text-anchor="middle" class="chart-axis-label">' + escapeHtml(week.shortLabel) + "</text>";
  });
  svg += "</svg>";
  document.getElementById("monthly-chart-wrap").innerHTML = svg;
}

async function renderMonthly() {
  const selector = document.getElementById("month-selector");
  if (!selector.value) selector.value = todayKey().slice(0, 7);
  const monthKey = selector.value;
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return;
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const daysInMonth = new Date(year, month, 0).getDate();
  const allEntries = (await readAll("entries")).filter(function (entry) {
    return !entry.voided && entry.date.slice(0, 7) === monthKey;
  });
  const activities = allEntries.filter(function (entry) {
    return ["income", "expense", "lender_payment", "reimbursement"].includes(entry.type) && !(entry.type === "lender_payment" && entry.unpaid);
  });
  const weeks = [];
  for (let start = 1; start <= daysInMonth; start += 7) {
    const end = Math.min(start + 6, daysInMonth);
    weeks.push({ start: start, end: end, label: "Days " + start + "–" + end, shortLabel: "W" + (weeks.length + 1), income: 0, expenses: 0, loans: 0, advances: 0, netCash: 0 });
  }
  const totals = { income: 0, expenses: 0, loans: 0, advances: 0, netCash: 0 };
  allEntries.forEach(function (entry) {
    const day = Number(entry.date.slice(8, 10));
    const week = weeks[Math.min(weeks.length - 1, Math.floor((day - 1) / 7))];
    if (!week) return;
    if (entry.type === "income") {
      week.income += Number(entry.amountCents || 0);
      totals.income += Number(entry.amountCents || 0);
      if (entry.source !== "other") {
        week.netCash += Number(entry.amountCents || 0);
        totals.netCash += Number(entry.amountCents || 0);
      }
    } else if (entry.type === "expense") {
      week.expenses += Number(entry.amountCents || 0);
      totals.expenses += Number(entry.amountCents || 0);
      if (entry.source === "personal") {
        week.advances += Number(entry.amountCents || 0);
        totals.advances += Number(entry.amountCents || 0);
      } else if (entry.source === "shop_cash") {
        week.netCash -= Number(entry.amountCents || 0);
        totals.netCash -= Number(entry.amountCents || 0);
      }
    } else if (entry.type === "lender_payment") {
      week.loans += Number(entry.amountCents || 0);
      week.advances += Number(entry.personalCents || 0);
      totals.loans += Number(entry.amountCents || 0);
      totals.advances += Number(entry.personalCents || 0);
      week.netCash -= Number(entry.shopCents || 0);
      totals.netCash -= Number(entry.shopCents || 0);
    } else if (entry.type === "reimbursement") {
      week.netCash -= Number(entry.amountCents || 0);
      totals.netCash -= Number(entry.amountCents || 0);
    }
  });
  const titleDate = new Date(year, month - 1, 1);
  document.getElementById("monthly-chart-title").textContent = titleDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  document.getElementById("month-income").textContent = money(totals.income);
  document.getElementById("month-expenses").textContent = money(totals.expenses);
  document.getElementById("month-loans").textContent = money(totals.loans);
  document.getElementById("month-advances").textContent = money(totals.advances);
  document.getElementById("month-net").textContent = money(totals.netCash);
  renderMonthlyChart(weeks);
  document.getElementById("monthly-empty").hidden = activities.length > 0;
  document.getElementById("monthly-table-wrap").innerHTML =
    '<table class="monthly-table"><thead><tr><th>Week</th><th>Income</th><th>Expenses</th><th>Lender payments</th><th>Staff advances</th><th>Net shop cash</th></tr></thead><tbody>' +
    weeks.map(function (week) {
      return "<tr><th>" + escapeHtml(week.label) + "</th><td>" + money(week.income) + "</td><td>" + money(week.expenses) + "</td><td>" + money(week.loans) + "</td><td>" + money(week.advances) + "</td><td>" + money(week.netCash) + "</td></tr>";
    }).join("") + "</tbody></table>";
}

async function renderApp() {
  await renderToday();
  await renderMonthly();
  await renderSetupLenders();
  await renderActivity();
  await renderEmployeeSuggestions();
}

async function renderEmployeeSuggestions() {
  const balances = staffBalanceMap(await readAll("entries"));
  const names = [];
  balances.forEach(function (person) {
    if (person.amount > 0) names.push(person.name);
  });
  document.getElementById("employee-options").innerHTML = names.sort().map(function (name) {
    return '<option value="' + escapeHtml(name) + '"></option>';
  }).join("");
}

function openPage(pageId) {
  document.querySelectorAll(".page").forEach(function (page) { page.hidden = page.id !== pageId; });
  document.querySelectorAll(".nav-button").forEach(function (button) { button.classList.toggle("active", button.dataset.page === pageId); });
  if (pageId === "settings-page") loadSavedFirebaseConfig();
  if (pageId === "monthly-page") renderMonthly();
}

function openRecordDialog(type) {
  const dialog = document.getElementById("record-dialog");
  const form = document.getElementById("record-form");
  form.reset();
  document.getElementById("record-type").value = type;
  const isReimbursement = type === "reimbursement";
  const categorySelect = document.getElementById("record-category");
  const categories = CATEGORIES[type] || [];
  categorySelect.innerHTML = categories.map(function (category) { return '<option value="' + escapeHtml(category) + '">' + escapeHtml(category) + "</option>"; }).join("");
  document.getElementById("record-title").textContent = type === "income" ? "Record income" : type === "expense" ? "Record expense" : "Reimburse staff";
  document.getElementById("record-eyebrow").textContent = isReimbursement ? "STAFF PAYBACK" : "QUICK ENTRY";
  document.getElementById("record-category-wrap").hidden = isReimbursement;
  document.getElementById("record-source-wrap").hidden = isReimbursement;
  document.getElementById("record-employee-wrap").hidden = true;
  document.getElementById("record-employee").required = isReimbursement;
  document.getElementById("record-form-note").textContent = isReimbursement ? "Enter the amount paid back from shop cash. This reduces the amount owed to this staff member." : "";
  const source = document.getElementById("record-source");
  source.innerHTML = type === "income"
    ? '<option value="shop_cash">Cash received</option><option value="other">Other payment method</option>'
    : '<option value="shop_cash">Shop cash</option><option value="personal">Staff personal money</option><option value="other">Other payment method</option>';
  source.onchange = function () {
    const personal = type === "expense" && source.value === "personal";
    document.getElementById("record-employee-wrap").hidden = !personal;
    document.getElementById("record-employee").required = personal || isReimbursement;
  };
  if (isReimbursement) document.getElementById("record-employee-wrap").hidden = false;
  document.getElementById("record-employee").value = "";
  document.getElementById("record-amount").value = "";
  document.getElementById("record-note").value = "";
  dialog.showModal();
  document.getElementById("record-amount").focus();
}

async function saveRecord(event) {
  event.preventDefault();
  const type = document.getElementById("record-type").value;
  const amountCents = centsFromInput(document.getElementById("record-amount").value);
  const source = type === "reimbursement" ? "shop_cash" : document.getElementById("record-source").value;
  const employeeName = document.getElementById("record-employee").value.trim();
  if (amountCents <= 0) {
    showToast("Enter an amount greater than zero.", true);
    return;
  }
  if ((source === "personal" || type === "reimbursement") && !employeeName) {
    showToast("Enter the staff member’s name.", true);
    return;
  }
  if (type === "reimbursement") {
    const allEntries = (await readAll("entries")).filter(function (entry) { return !entry.voided; });
    const person = staffBalanceMap(allEntries).get(employeeName.toLocaleLowerCase());
    const owed = person ? Math.max(0, person.amount) : 0;
    if (amountCents > owed) {
      showToast("That is more than the recorded amount owed to " + employeeName + " (" + money(owed) + ").", true);
      return;
    }
  }
  const now = Date.now();
  const entry = {
    id: makeId(type),
    type: type,
    date: todayKey(),
    amountCents: amountCents,
    category: type === "reimbursement" ? "Staff reimbursement" : document.getElementById("record-category").value,
    note: document.getElementById("record-note").value.trim(),
    source: source,
    employeeName: employeeName,
    createdAtMs: now,
    updatedAtMs: now,
    syncState: "pending"
  };
  try {
    await writeOne("entries", entry);
    document.getElementById("record-dialog").close();
    await renderApp();
    scheduleSync();
    showToast(type === "reimbursement" ? "Reimbursement recorded." : "Record saved on this device.");
  } catch (error) {
    console.error(error);
    showToast("Could not save the record on this device.", true);
  }
}

async function recordRemainingFromShop(lender, existing) {
  const due = Number(lender.dailyCents || 0);
  const alreadyPaid = existing ? Number(existing.amountCents || 0) : 0;
  const remaining = Math.max(0, due - alreadyPaid);
  if (remaining <= 0) {
    openPaymentDialog(lender, existing, "edit");
    return;
  }
  await saveLenderPayment(lender, existing, Number(existing ? existing.shopCents || 0 : 0) + remaining, Number(existing ? existing.personalCents || 0 : 0), existing ? existing.employeeName || "" : "");
}

function openPaymentDialog(lender, existing, mode) {
  const dialog = document.getElementById("payment-dialog");
  document.getElementById("payment-form").reset();
  document.getElementById("payment-lender-id").value = lender.id;
  document.getElementById("payment-mode").value = mode;
  document.getElementById("payment-title").textContent = lender.name + " · " + money(lender.dailyCents);
  document.getElementById("payment-helper").textContent = mode === "partial"
    ? "Enter only this partial payment. It will be added to any amount already paid today. Personal money is added to the amount owed to that staff member."
    : "You can split today’s payment between shop cash and staff personal money. A personal amount is added to the amount owed to that staff member.";
  const currentShop = existing ? Number(existing.shopCents || 0) : 0;
  const currentPersonal = existing ? Number(existing.personalCents || 0) : 0;
  const paid = currentShop + currentPersonal;
  const due = Number(lender.dailyCents || 0);
  const remainder = Math.max(0, due - paid);
  let shop = currentShop;
  let personal = currentPersonal;
  if (mode === "partial") {
    shop = 0;
    personal = 0;
  } else if (mode === "personal" && !existing) personal = due;
  else if (mode === "personal") personal += remainder;
  else if (mode === "edit" && !existing) shop = due;
  else if (mode !== "edit" && !existing) shop = due;
  document.getElementById("payment-shop-label").textContent = mode === "partial" ? "Add partial amount from shop cash" : "Total paid today from shop cash";
  document.getElementById("payment-personal-label").textContent = mode === "partial" ? "Add partial amount from personal money" : "Total paid today with staff personal money";
  document.getElementById("payment-shop-amount").value = (shop / 100).toFixed(2);
  document.getElementById("payment-personal-amount").value = (personal / 100).toFixed(2);
  document.getElementById("payment-employee").value = existing ? existing.employeeName || "" : "";
  document.getElementById("payment-employee-wrap").hidden = personal <= 0;
  document.getElementById("payment-employee").required = personal > 0;
  document.getElementById("payment-personal-amount").oninput = function () {
    const hasPersonal = centsFromInput(this.value) > 0;
    document.getElementById("payment-employee-wrap").hidden = !hasPersonal;
    document.getElementById("payment-employee").required = hasPersonal;
  };
  dialog.showModal();
}

async function saveLenderPayment(lender, existing, shopCents, personalCents, employeeName) {
  const total = shopCents + personalCents;
  if (shopCents < 0 || personalCents < 0 || total <= 0) {
    showToast("Enter a payment amount greater than zero.", true);
    return;
  }
  if (personalCents > 0 && !employeeName.trim()) {
    showToast("Enter the staff member who used personal money.", true);
    return;
  }
  const now = Date.now();
  const entry = {
    id: getPaymentId(todayKey(), lender.id),
    type: "lender_payment",
    date: todayKey(),
    lenderId: lender.id,
    lenderName: lender.name,
    dueCents: Number(lender.dailyCents || 0),
    amountCents: total,
    shopCents: shopCents,
    personalCents: personalCents,
    employeeName: employeeName.trim(),
    unpaid: false,
    note: "",
    createdAtMs: existing ? Number(existing.createdAtMs || now) : now,
    updatedAtMs: now,
    syncState: "pending"
  };
  try {
    await writeOne("entries", entry);
    document.getElementById("payment-dialog").close();
    await renderApp();
    scheduleSync();
    showToast("Lender payment saved.");
  } catch (error) {
    console.error(error);
    showToast("Could not save the payment on this device.", true);
  }
}

async function submitPayment(event) {
  event.preventDefault();
  const lenderId = document.getElementById("payment-lender-id").value;
  const lender = (await getActiveLenders()).find(function (item) { return item.id === lenderId; });
  if (!lender) {
    showToast("This lender is no longer on the daily list.", true);
    return;
  }
  const stored = await readOne("entries", getPaymentId(todayKey(), lender.id));
  const old = stored && !stored.voided ? stored : null;
  const mode = document.getElementById("payment-mode").value;
  let shopCents = centsFromInput(document.getElementById("payment-shop-amount").value);
  let personalCents = centsFromInput(document.getElementById("payment-personal-amount").value);
  if (mode === "partial") {
    shopCents += old ? Number(old.shopCents || 0) : 0;
    personalCents += old ? Number(old.personalCents || 0) : 0;
  }
  await saveLenderPayment(
    lender,
    old,
    shopCents,
    personalCents,
    document.getElementById("payment-employee").value
  );
}

async function addLender(event) {
  event.preventDefault();
  const name = document.getElementById("lender-name").value.trim();
  const dailyCents = centsFromInput(document.getElementById("lender-amount").value);
  if (!name || dailyCents <= 0) {
    showToast("Enter a lender name and a positive daily amount.", true);
    return;
  }
  const existing = await readAll("lenders");
  const lender = {
    id: makeId("lender"),
    name: name,
    dailyCents: dailyCents,
    active: true,
    order: existing.length,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    syncState: "pending"
  };
  await writeOne("lenders", lender);
  document.getElementById("lender-form").reset();
  await renderApp();
  scheduleSync();
  showToast("Lender added to the daily checklist.");
}

function downloadBackup() {
  Promise.all([readAll("entries"), readAll("lenders")]).then(function (results) {
    const backup = {
      app: "ArtExplorer Cashbook",
      version: 1,
      exportedAt: new Date().toISOString(),
      entries: results[0],
      lenders: results[1]
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "artexplorer-cashbook-backup-" + todayKey() + ".json";
    link.click();
    URL.revokeObjectURL(url);
    showToast("Backup downloaded.");
  }).catch(function (error) {
    console.error(error);
    showToast("Could not create a backup.", true);
  });
}

async function restoreBackupFile(file) {
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (!backup || backup.app !== "ArtExplorer Cashbook" || !Array.isArray(backup.entries) || !Array.isArray(backup.lenders)) {
      throw new Error("This file is not an ArtExplorer Cashbook backup.");
    }
    if (!window.confirm("Merge " + backup.entries.length + " records and " + backup.lenders.length + " lender setups into this device? Newer records already here will be kept.")) return;
    for (const entry of backup.entries) {
      if (!entry || !entry.id || !entry.type || !entry.date) continue;
      const current = await readOne("entries", entry.id);
      if (!current || Number(entry.updatedAtMs || 0) >= Number(current.updatedAtMs || 0)) {
        await writeOne("entries", Object.assign({}, entry, { syncState: "pending" }));
      }
    }
    for (const lender of backup.lenders) {
      if (!lender || !lender.id || !lender.name) continue;
      const current = await readOne("lenders", lender.id);
      if (!current || Number(lender.updatedAtMs || 0) >= Number(current.updatedAtMs || 0)) {
        await writeOne("lenders", Object.assign({}, lender, { syncState: "pending" }));
      }
    }
    await renderApp();
    scheduleSync();
    showToast("Backup merged into this device.");
  } catch (error) {
    console.error("Backup restore failed", error);
    showToast(error.message || "Could not restore that backup.", true);
  }
}

function wireEvents() {
  document.querySelectorAll(".nav-button").forEach(function (button) {
    button.addEventListener("click", function () { openPage(button.dataset.page); });
  });
  document.querySelectorAll("[data-page-link]").forEach(function (button) {
    button.addEventListener("click", function () { openPage(button.dataset.pageLink); });
  });
  document.querySelectorAll("[data-record]").forEach(function (button) {
    button.addEventListener("click", function () { openRecordDialog(button.dataset.record); });
  });
  document.getElementById("record-reimbursement").addEventListener("click", function () { openRecordDialog("reimbursement"); });
  document.getElementById("record-form").addEventListener("submit", saveRecord);
  document.getElementById("payment-form").addEventListener("submit", submitPayment);
  document.getElementById("closing-form").addEventListener("submit", saveClosingCount);
  document.getElementById("opening-cash").addEventListener("input", updateClosingPreview);
  document.getElementById("counted-cash").addEventListener("input", updateClosingPreview);
  document.querySelectorAll(".close-dialog,.cancel-dialog").forEach(function (button) { button.addEventListener("click", function () { document.getElementById("record-dialog").close(); }); });
  document.querySelectorAll(".close-payment-dialog,.cancel-payment-dialog").forEach(function (button) { button.addEventListener("click", function () { document.getElementById("payment-dialog").close(); }); });
  document.getElementById("lender-form").addEventListener("submit", addLender);
  document.getElementById("activity-filter").addEventListener("change", renderActivity);
  document.getElementById("month-selector").addEventListener("change", renderMonthly);
  document.getElementById("download-backup").addEventListener("click", downloadBackup);
  document.getElementById("download-backup-settings").addEventListener("click", downloadBackup);
  document.getElementById("restore-backup").addEventListener("click", function () { document.getElementById("restore-file").click(); });
  document.getElementById("restore-file").addEventListener("change", function () {
    restoreBackupFile(this.files && this.files[0]);
    this.value = "";
  });
  document.getElementById("firebase-config-form").addEventListener("submit", function (event) {
    event.preventDefault();
    const config = configFromForm();
    if (!hasConfig(config)) {
      setFirebaseMessage("Fill in all four Firebase Web app values before saving.", "error");
      return;
    }
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    firebaseModules = null;
    firebaseAuth = null;
    firebaseDb = null;
    currentUser = null;
    setFirebaseMessage("Firebase settings saved in this browser. Sign in to sync.", "success");
    setSyncBadge("", "Local only");
    showToast("Firebase settings saved.");
  });
  document.getElementById("firebase-signin").addEventListener("click", function () { connectFirebase(false); });
  document.getElementById("firebase-signup").addEventListener("click", function () { connectFirebase(true); });
  document.getElementById("firebase-signout").addEventListener("click", async function () {
    try {
      if (firebaseAuth && firebaseModules) await firebaseModules.auth.signOut(firebaseAuth);
      updateFirebaseLogin(null);
      setFirebaseMessage("Signed out. Local records remain on this device.", "");
      showToast("Signed out of Firebase.");
    } catch (error) {
      setFirebaseMessage(firebaseErrorText(error), "error");
    }
  });
  window.addEventListener("online", function () {
    setSyncBadge("", currentUser ? "Back online" : "Local only");
    if (currentUser) syncNow();
    else restoreFirebaseSession();
  });
  window.addEventListener("offline", function () {
    setSyncBadge("", "Offline · saved here");
    setFirebaseMessage("Offline. New records are saved on this device and can sync when online.", "");
  });
}

async function initialize() {
  wireEvents();
  document.getElementById("month-selector").value = todayKey().slice(0, 7);
  loadSavedFirebaseConfig();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./service-worker.js").catch(function (error) { console.info("Offline app shell could not be cached yet", error); });
  }
  try {
    await openDatabase();
    await renderApp();
    lastRenderedDay = todayKey();
    window.setInterval(function () {
      const currentDay = todayKey();
      if (currentDay !== lastRenderedDay) {
        lastRenderedDay = currentDay;
        renderApp();
      }
    }, 60000);
    if (!navigator.onLine) setSyncBadge("", "Offline · saved here");
    else if (hasConfig(readFirebaseConfig())) restoreFirebaseSession();
  } catch (error) {
    console.error(error);
    showToast("Could not open local storage. Use a supported browser profile.", true);
    setFirebaseMessage("Local database could not open. Records cannot be saved in this browser.", "error");
  }
}

initialize();
