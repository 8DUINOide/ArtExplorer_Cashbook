"use strict";

const DB_NAME = "artexplorer-cashbook";
const DB_VERSION = 1;
const SUPABASE_JS_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
const CATEGORIES = {
  income: ["Printing", "Computer services", "Repair", "Other"],
  expense: ["Supplies", "Maintenance", "Utilities", "Other"]
};
let dbPromise;
let supabaseLoadPromise = null;
let supabaseClient = null;
let supabaseConfigString = "";
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

function setSupabaseMessage(message, state) {
  const element = document.getElementById("supabase-message");
  element.textContent = message;
  element.className = "inline-message" + (state ? " " + state : "");
}

function readSupabaseConfig() {
  return window.ARTEPLORER_SUPABASE_CONFIG || null;
}

function hasConfig(config) {
  return Boolean(config && config.url && config.publishableKey);
}

function loadSupabaseSdk() {
  if (window.supabase && window.supabase.createClient) return Promise.resolve(window.supabase);
  if (!navigator.onLine) return Promise.reject(new Error("An internet connection is needed to connect. Local records are still available."));
  if (!supabaseLoadPromise) {
    supabaseLoadPromise = new Promise(function (resolve, reject) {
      const script = document.createElement("script");
      script.src = SUPABASE_JS_URL;
      script.async = true;
      script.onload = function () {
        if (window.supabase && window.supabase.createClient) resolve(window.supabase);
        else reject(new Error("Could not load the cloud sync library."));
      };
      script.onerror = function () { reject(new Error("Could not load the cloud sync library. Check the internet connection.")); };
      document.head.appendChild(script);
    }).catch(function (error) {
      supabaseLoadPromise = null;
      throw error;
    });
  }
  return supabaseLoadPromise;
}

async function getSupabaseClient() {
  const config = readSupabaseConfig();
  if (!hasConfig(config)) throw new Error("Cloud sync is not configured yet. Ask the app administrator.");
  const configString = JSON.stringify(config);
  if (supabaseClient && supabaseConfigString === configString) return supabaseClient;
  const sdk = await loadSupabaseSdk();
  if (supabaseClient) {
    await supabaseClient.auth.signOut({ scope: "local" });
  }
  supabaseClient = sdk.createClient(config.url, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  supabaseConfigString = configString;
  return supabaseClient;
}

function withoutLocalFields(record) {
  const copy = Object.assign({}, record);
  delete copy.syncState;
  return copy;
}

function isUnpaidChecklistPlaceholder(record) {
  return Boolean(record && record.type === "lender_payment" && record.unpaid === true && Number(record.amountCents || 0) === 0);
}

function compareSyncPriority(localRecord, cloudRecord) {
  const localIsPlaceholder = isUnpaidChecklistPlaceholder(localRecord);
  const cloudIsPlaceholder = isUnpaidChecklistPlaceholder(cloudRecord);
  if (localIsPlaceholder !== cloudIsPlaceholder) return localIsPlaceholder ? -1 : 1;

  const localUpdatedAt = Number(localRecord.updatedAtMs || 0);
  const cloudUpdatedAt = Number(cloudRecord.updatedAtMs || 0);
  return localUpdatedAt === cloudUpdatedAt ? 0 : localUpdatedAt > cloudUpdatedAt ? 1 : -1;
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
  const config = readSupabaseConfig();
  if (!hasConfig(config) || !currentUser) {
    setSyncBadge("", "Local only");
    return;
  }
  syncInProgress = true;
  setSyncBadge("syncing", "Syncing");
  setSupabaseMessage("Syncing this device…", "");
  try {
    const client = await getSupabaseClient();
    const uid = currentUser.id;
    await syncTable(client, uid, "entries", "cashbook_entries");
    await syncTable(client, uid, "lenders", "cashbook_lenders");
    setSyncBadge("online", "Synced");
    setSupabaseMessage("Connected as " + currentUser.email + ". This device is synced.", "success");
    document.getElementById("supabase-signout").hidden = false;
    await renderApp();
  } catch (error) {
    console.error("Supabase sync failed", error);
    setSyncBadge("error", "Sync needs attention");
    setSupabaseMessage(supabaseErrorText(error), "error");
  } finally {
    syncInProgress = false;
    if (syncRequested) {
      syncRequested = false;
      window.setTimeout(syncNow, 50);
    }
  }
}

async function syncTable(client, uid, storeName, tableName) {
  const remoteRows = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const result = await client.from(tableName)
      .select("id,payload,updated_at_ms")
      .eq("owner_id", uid)
      .order("id")
      .range(offset, offset + pageSize - 1);
    if (result.error) throw result.error;
    remoteRows.push.apply(remoteRows, result.data || []);
    if (!result.data || result.data.length < pageSize) break;
  }
  const remote = new Map();
  remoteRows.forEach(function (row) {
    const data = Object.assign({}, row.payload || {}, {
      id: row.id,
      updatedAtMs: Number(row.updated_at_ms || (row.payload && row.payload.updatedAtMs) || 0)
    });
    remote.set(data.id, data);
  });
  const local = await readAll(storeName);
  const localById = new Map(local.map(function (record) { return [record.id, record]; }));

  for (const [id, cloudRecord] of remote) {
    const localRecord = localById.get(id);
    const priority = localRecord ? compareSyncPriority(localRecord, cloudRecord) : -1;
    if (!localRecord || priority < 0) {
      await writeOne(storeName, Object.assign({}, cloudRecord, { syncState: "synced" }));
      localById.set(id, Object.assign({}, cloudRecord, { syncState: "synced" }));
    } else if (priority === 0) {
      const synced = Object.assign({}, localRecord, { syncState: "synced" });
      await writeOne(storeName, synced);
      localById.set(id, synced);
    }
  }

  const toUpload = [];
  for (const [id, localRecord] of localById) {
    const cloudRecord = remote.get(id);
    if (!cloudRecord || compareSyncPriority(localRecord, cloudRecord) > 0) {
      toUpload.push({
        owner_id: uid,
        id: id,
        payload: withoutLocalFields(localRecord),
        updated_at_ms: Number(localRecord.updatedAtMs || Date.now())
      });
    }
  }
  for (let offset = 0; offset < toUpload.length; offset += pageSize) {
    const uploaded = await client.from(tableName).upsert(toUpload.slice(offset, offset + pageSize), { onConflict: "owner_id,id" });
    if (uploaded.error) throw uploaded.error;
  }
  for (const row of toUpload) {
    const localRecord = localById.get(row.id);
    if (localRecord) await markSyncState(storeName, localRecord, "synced");
  }
}

function supabaseErrorText(error) {
  const message = String(error && error.message || "");
  if (/invalid login credentials|invalid credentials/i.test(message)) return "Email or password was not accepted.";
  if (/row-level security|permission denied|not allowed/i.test(message)) return "Cloud access is not set up correctly. Ask the app administrator to check the database policies.";
  if (/relation .* does not exist|could not find the table/i.test(message)) return "Cloud database setup is incomplete. Ask the app administrator to apply the database setup.";
  if (!navigator.onLine || /failed to fetch|network/i.test(message)) return "No internet connection. Records remain saved on this device.";
  return message || "Could not connect to the cloud database. Local records remain safe on this device.";
}

function updateSupabaseLogin(user) {
  currentUser = user || null;
  if (user) {
    document.getElementById("supabase-signout").hidden = false;
    setSupabaseMessage("Connected as " + (user.email || "owner") + ".", "success");
    setSyncBadge("online", "Connected");
  } else {
    document.getElementById("supabase-signout").hidden = true;
    setSyncBadge("", "Local only");
  }
}

async function connectSupabase() {
  if (!hasConfig(readSupabaseConfig())) {
    setSupabaseMessage("Cloud sync is not configured yet. Ask the app administrator.", "error");
    return;
  }
  const email = document.getElementById("supabase-email").value.trim();
  const password = document.getElementById("supabase-password").value;
  if (!email || !password) {
    setSupabaseMessage("Enter the owner email and password.", "error");
    return;
  }
  setSyncBadge("syncing", "Connecting");
  setSupabaseMessage("Connecting…", "");
  try {
    const client = await getSupabaseClient();
    const result = await client.auth.signInWithPassword({ email: email, password: password });
    if (result.error) throw result.error;
    updateSupabaseLogin(result.data.user);
    document.getElementById("supabase-password").value = "";
    await syncNow();
  } catch (error) {
    console.error("Supabase connection failed", error);
    setSyncBadge("error", "Not connected");
    setSupabaseMessage(supabaseErrorText(error), "error");
  }
}

async function restoreSupabaseSession() {
  const config = readSupabaseConfig();
  if (!hasConfig(config) || !navigator.onLine) return;
  try {
    const client = await getSupabaseClient();
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    const user = result.data.session && result.data.session.user;
    updateSupabaseLogin(user);
    if (user) await syncNow();
  } catch (error) {
    console.info("Supabase session is not available yet", error);
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

function entryMeta(entry, includeTimestamp) {
  const timestamp = Number(entry.updatedAtMs || entry.createdAtMs || 0);
  const time = includeTimestamp === true && timestamp > 0
    ? new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase()
    : "";
  const parts = [shortDate(entry.date) + (time ? ", " + time : "")];
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

function activityHtml(entry, includeTimestamp) {
  const symbol = entry.type === "income" ? "+" : entry.type === "cash_close" ? "" : "−";
  const icon = entry.type === "income" ? "↗" : entry.type === "expense" ? "↙" : entry.type === "lender_payment" ? "↘" : "↗";
  const voidControl = entry.voided ? '<span class="activity-meta voided-label">Voided</span>' : entry.unpaid ? '<span class="activity-meta voided-label">Not paid</span>' : entry.type === "lender_payment" || entry.type === "cash_close" ? '<span class="activity-meta">Saved</span>' : '<button class="text-button void-action" data-entry="' + escapeHtml(entry.id) + '" type="button">Void</button>';
  const amountLabel = entry.unpaid ? "Due " + money(entry.dueCents) : entry.type === "cash_close" ? "Count " + money(entry.countedCents) : symbol + money(entry.amountCents);
  return '<div class="activity-item' + (entry.voided ? " voided-item" : entry.unpaid ? " unpaid-item" : "") + '">' +
    '<span class="activity-icon ' + escapeHtml(entry.type) + '">' + icon + "</span>" +
    '<div><div class="activity-title">' + escapeHtml(entryDisplayTitle(entry)) + '</div><div class="activity-meta">' + escapeHtml(entryMeta(entry, includeTimestamp)) + "</div></div>" +
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
  let partiallyPaid = 0;
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
    else if (paid > 0) partiallyPaid += 1;
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
    "<span>Full payments <strong>" + fullyPaid + "</strong></span>" +
    "<span>Partial payments <strong>" + partiallyPaid + "</strong></span>";
  document.getElementById("metric-lenders").innerHTML = (fullyPaid + partiallyPaid) + ' <small>/ ' + lenders.length + " paid</small>";
  document.getElementById("metric-lenders-amount").textContent = money(paidTotal);
  document.getElementById("metric-lenders-breakdown").textContent = fullyPaid + " full · " + partiallyPaid + " partial";
  document.getElementById("metric-lenders-sub").textContent = lenders.length
    ? money(Math.max(0, dueTotal - paidTotal)) + " remaining"
    : "Set up your daily list";
  document.getElementById("today-date").textContent = dayLabel(date);

  const income = entries.filter(function (entry) { return entry.type === "income"; }).reduce(function (sum, entry) { return sum + Number(entry.amountCents || 0); }, 0);
  const expenses = entries.filter(function (entry) { return entry.type === "expense"; }).reduce(function (sum, entry) { return sum + Number(entry.amountCents || 0); }, 0);
  const cashIncome = entries.filter(function (entry) { return entry.type === "income" && entry.source !== "other"; }).reduce(function (sum, entry) { return sum + Number(entry.amountCents || 0); }, 0);
  const cashExpenses = entries.filter(function (entry) { return entry.type === "expense" && entry.source === "shop_cash"; }).reduce(function (sum, entry) { return sum + Number(entry.amountCents || 0); }, 0);
  const lenderCash = lenders.reduce(function (sum, lender) {
    const payment = payments.get(lender.id);
    return sum + Number(payment ? payment.shopCents || 0 : 0);
  }, 0);
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
  renderClosingPanel(date, allEntries, new Set(lenders.map(function (lender) { return lender.id; })));
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

function renderClosingPanel(date, allEntries, activeLenderIds) {
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
      (entry.type === "lender_payment" && activeLenderIds.has(entry.lenderId) && Number(entry.shopCents || 0) > 0) ||
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
  document.getElementById("all-activity").innerHTML = filtered.map(function (entry) { return activityHtml(entry, true); }).join("");
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

let monthlyChartSeries = "loans";
let monthlyChartSelectedDay = null;

function renderMonthlyChart(days) {
  const series = {
    income: { label: "Income", color: "#438655" },
    expenses: { label: "Expenses", color: "#dc9850" },
    loans: { label: "Lender payments", color: "#6479a4" }
  }[monthlyChartSeries];
  const chartHost = document.getElementById("monthly-chart-wrap");
  const width = Math.max(760, chartHost.clientWidth, 83 + days.length * 34);
  const height = 330;
  const left = 65;
  const right = 18;
  const top = 18;
  const bottom = 48;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  let maximum = 0;
  days.forEach(function (day) {
    maximum = Math.max(maximum, Number(day[monthlyChartSeries] || 0));
  });
  const scaleMaximum = maximum > 0 ? maximum * 1.15 : 100;
  let svg = '<svg class="monthly-chart" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="Daily ' + escapeHtml(series.label) + ' for the selected month">';
  for (let tick = 0; tick <= 4; tick += 1) {
    const y = top + plotHeight - (plotHeight * tick / 4);
    const value = scaleMaximum * tick / 4;
    svg += '<line x1="' + left + '" y1="' + y + '" x2="' + (width - right) + '" y2="' + y + '" class="chart-gridline"/>';
    svg += '<text x="' + (left - 8) + '" y="' + (y + 4) + '" text-anchor="end" class="chart-axis-label">' + chartAmount(value) + "</text>";
  }
  const step = plotWidth / Math.max(days.length - 1, 1);
  const points = days.map(function (day, index) {
    const value = Number(day[monthlyChartSeries] || 0);
    return { x: left + step * index, y: top + plotHeight - plotHeight * value / scaleMaximum, day: day, value: value };
  });
  svg += '<polyline fill="none" stroke="' + series.color + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="' + points.map(function (point) { return point.x + "," + point.y; }).join(" ") + '"/>';
  points.forEach(function (point) {
    const selected = point.day.dayNumber === monthlyChartSelectedDay;
    const ariaLabel = point.day.label + ", " + series.label + ": " + money(point.value) + ". Select to show details.";
    svg += '<circle cx="' + point.x + '" cy="' + point.y + '" r="3.5" fill="' + series.color + '" stroke="#fff" stroke-width="1.5" pointer-events="none"/>';
    svg += '<circle class="chart-point-hit-area' + (selected ? ' selected' : '') + '" data-day="' + point.day.dayNumber + '" cx="' + point.x + '" cy="' + point.y + '" r="12" fill="transparent" stroke="transparent" role="button" tabindex="0" aria-label="' + escapeHtml(ariaLabel) + '"><title>' + escapeHtml(point.day.label + " - " + series.label + ": " + money(point.value)) + "</title></circle>";
    svg += '<text x="' + point.x + '" y="' + (height - 15) + '" text-anchor="middle" class="chart-axis-label">' + escapeHtml(point.day.shortLabel) + "</text>";
  });
  svg += "</svg>";
  document.getElementById("monthly-chart-wrap").innerHTML = svg;
  const detail = document.getElementById("monthly-chart-detail");
  const selectedPoint = points.find(function (point) { return point.day.dayNumber === monthlyChartSelectedDay; });
  detail.textContent = selectedPoint
    ? selectedPoint.day.label + " - " + series.label + ": " + money(selectedPoint.value)
    : "Tap a chart point to see that day's " + series.label.toLowerCase() + " amount.";
  document.querySelectorAll(".chart-point-hit-area").forEach(function (pointButton) {
    function selectPoint() {
      monthlyChartSelectedDay = Number(pointButton.dataset.day);
      const point = points.find(function (item) { return item.day.dayNumber === monthlyChartSelectedDay; });
      detail.textContent = point.day.label + " - " + series.label + ": " + money(point.value);
      document.querySelectorAll(".chart-point-hit-area").forEach(function (otherPoint) {
        otherPoint.classList.toggle("selected", otherPoint === pointButton);
      });
    }
    pointButton.addEventListener("click", selectPoint);
    pointButton.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectPoint();
      }
    });
  });
  document.querySelectorAll("[data-chart-series]").forEach(function (button) {
    const selected = button.dataset.chartSeries === monthlyChartSeries;
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}
async function renderMonthly() {
  const selector = document.getElementById("month-selector");
  if (!selector.value) selector.value = todayKey().slice(0, 7);
  const monthKey = selector.value;
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return;
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const daysInMonth = new Date(year, month, 0).getDate();
  const activeLenderIds = new Set((await getActiveLenders()).map(function (lender) { return lender.id; }));
  const allEntries = (await readAll("entries")).filter(function (entry) {
    return !entry.voided && entry.date.slice(0, 7) === monthKey &&
      (entry.type !== "lender_payment" || activeLenderIds.has(entry.lenderId));
  });
  const activities = allEntries.filter(function (entry) {
    return ["income", "expense", "lender_payment", "reimbursement"].includes(entry.type) && !(entry.type === "lender_payment" && entry.unpaid);
  });
  const days = [];
  for (let dayNumber = 1; dayNumber <= daysInMonth; dayNumber += 1) {
    const label = new Date(year, month - 1, dayNumber).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    days.push({ dayNumber: dayNumber, label: label, shortLabel: String(dayNumber), income: 0, expenses: 0, loans: 0, advances: 0, netCash: 0 });
  }
  const totals = { income: 0, expenses: 0, loans: 0, advances: 0, netCash: 0 };
  allEntries.forEach(function (entry) {
    const day = Number(entry.date.slice(8, 10));
    const daily = days[day - 1];
    if (!daily) return;
    if (entry.type === "income") {
      daily.income += Number(entry.amountCents || 0);
      totals.income += Number(entry.amountCents || 0);
      if (entry.source !== "other") {
        daily.netCash += Number(entry.amountCents || 0);
        totals.netCash += Number(entry.amountCents || 0);
      }
    } else if (entry.type === "expense") {
      daily.expenses += Number(entry.amountCents || 0);
      totals.expenses += Number(entry.amountCents || 0);
      if (entry.source === "personal") {
        daily.advances += Number(entry.amountCents || 0);
        totals.advances += Number(entry.amountCents || 0);
      } else if (entry.source === "shop_cash") {
        daily.netCash -= Number(entry.amountCents || 0);
        totals.netCash -= Number(entry.amountCents || 0);
      }
    } else if (entry.type === "lender_payment") {
      daily.loans += Number(entry.amountCents || 0);
      daily.advances += Number(entry.personalCents || 0);
      totals.loans += Number(entry.amountCents || 0);
      totals.advances += Number(entry.personalCents || 0);
      daily.netCash -= Number(entry.shopCents || 0);
      totals.netCash -= Number(entry.shopCents || 0);
    } else if (entry.type === "reimbursement") {
      daily.netCash -= Number(entry.amountCents || 0);
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
  renderMonthlyChart(days);
  document.getElementById("monthly-empty").hidden = activities.length > 0;
  document.getElementById("monthly-table-wrap").innerHTML =
    '<table class="monthly-table"><thead><tr><th>Day</th><th>Income</th><th>Expenses</th><th>Lender payments</th><th>Staff advances</th><th>Net shop cash</th></tr></thead><tbody>' +
    days.map(function (daily) {
      return "<tr><th>" + escapeHtml(daily.label) + "</th><td>" + money(daily.income) + "</td><td>" + money(daily.expenses) + "</td><td>" + money(daily.loans) + "</td><td>" + money(daily.advances) + "</td><td>" + money(daily.netCash) + "</td></tr>";
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
  document.getElementById("month-selector").addEventListener("change", function () {
    monthlyChartSelectedDay = null;
    renderMonthly();
  });
  document.querySelectorAll("[data-chart-series]").forEach(function (button) {
    button.addEventListener("click", function () {
      monthlyChartSeries = button.dataset.chartSeries;
      renderMonthly();
    });
  });
  document.getElementById("download-backup").addEventListener("click", downloadBackup);
  document.getElementById("restore-backup").addEventListener("click", function () { document.getElementById("restore-file").click(); });
  document.getElementById("restore-file").addEventListener("change", function () {
    restoreBackupFile(this.files && this.files[0]);
    this.value = "";
  });
  document.getElementById("supabase-signin").addEventListener("click", function () { connectSupabase(); });
  document.getElementById("supabase-signout").addEventListener("click", async function () {
    try {
      if (supabaseClient) {
        const result = await supabaseClient.auth.signOut();
        if (result.error) throw result.error;
      }
      updateSupabaseLogin(null);
      setSupabaseMessage("Signed out. Local records remain on this device.", "");
      showToast("Signed out of cloud sync.");
    } catch (error) {
      setSupabaseMessage(supabaseErrorText(error), "error");
    }
  });
  window.addEventListener("online", function () {
    setSyncBadge("", currentUser ? "Back online" : "Local only");
    if (currentUser) syncNow();
    else restoreSupabaseSession();
  });
  window.addEventListener("offline", function () {
    setSyncBadge("", "Offline · saved here");
    setSupabaseMessage("Offline. New records are saved on this device and can sync when online.", "");
  });
}

async function initialize() {
  wireEvents();
  document.getElementById("month-selector").value = todayKey().slice(0, 7);
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
    else if (hasConfig(readSupabaseConfig())) restoreSupabaseSession();
  } catch (error) {
    console.error(error);
    showToast("Could not open local storage. Use a supported browser profile.", true);
    setSupabaseMessage("Local database could not open. Records cannot be saved in this browser.", "error");
  }
}

initialize();
