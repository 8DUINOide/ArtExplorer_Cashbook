# ArtExplorer Cashbook

An offline-first cashbook for daily business use. It records income, expenses, daily lender payments, and money the business owes staff who paid from their own pocket.

## Run it on Windows

1. Install Python 3 if it is not already installed.
2. Double-click **Start ArtExplorer Cashbook.bat**.
3. The app opens in your browser. In Microsoft Edge, use **Install this site as an app** from the browser menu to get a desktop window.

The app stores records in the browser on this computer and the cached app shell can open offline after the first visit. Keep using the same browser profile so it can access the same local records. The local server window can be minimized while the app is open.

## Daily use

- Add each lender and their usual daily payment once under **Setup**.
- On the **Today** page, record a payment from shop cash or staff personal money. Personal payments are included in the amount owed to that staff member.
- Use **Partial** when less than the usual daily amount was paid. Later partial payments add to the amount already recorded that day.
- Record sales/service income and shop expenses with the two quick buttons.
- Use **Reimburse a staff member** when the business pays them back.
- At closing, enter the physical drawer count. The app compares it with the opening cash plus recorded shop cash movement; tomorrow’s opening can use that closing count.
- Download a JSON backup regularly under **Activity** or **Setup**. **Restore a backup** merges it with the records on this device.
- Use **Monthly** to compare income, expenses, lender payments, staff advances, and cash movement by week.

Amounts are displayed in Philippine pesos (₱).

## Firebase cloud sync

Local records work without Firebase. To sync to the cloud:

1. Create a Firebase project, add a Web app, enable Email/Password Authentication, and create a Cloud Firestore database.
2. In **Setup → Firebase sync**, enter the Web app's API key, Auth domain, Project ID, and App ID.
3. Publish the rules in the firestore.rules file in Firebase Console → Firestore Database → Rules.
4. Create an owner account, then sign in on this device and any other device that should sync.

The Firebase web configuration is stored in this browser. The account password is only used for sign-in and is not stored by the app. Use the same owner account on devices that should share this cashbook. The included rules limit cloud access to data owned by the signed-in account.

The app writes to local storage first and uploads records when connected. Income, expense, and reimbursement records use unique IDs. A lender payment has one editable daily record per lender, so avoid editing the same lender's payment from two offline devices at once; the latest synced edit wins. Configure Firebase and test a backup before using cloud sync as the only copy of important records.

## Publish the online version

Firebase Hosting serves the app over HTTPS so it can be opened and installed on other computers or phones. The included firebase.json points Hosting at the app files and includes the Firestore rules file.

Install Node.js and the Firebase CLI, then run these commands from this folder:

    npm install -g firebase-tools
    firebase login
    firebase use --add
    firebase deploy --only hosting,firestore:rules

Select the same Firebase project used for Authentication and Firestore. Open the Hosting address provided by Firebase, enter the Firebase Web app values under Setup on each browser profile, then sign in with the same cashbook account. Install the app from the browser menu if desired. Firebase's Hosting setup and deployment flow is documented at https://firebase.google.com/docs/hosting/quickstart. The app's local Windows launcher remains available for this computer.

## Notes

- This is a cashbook, not a full accounting or tax system.
- Lender payments are tracked by the amount paid each day; the app does not track loan balances.
- The cash movement summary and closing count compare entered records with the physical drawer; they do not replace careful cash handling.
- Unpaid daily checklist rows remain in Activity after the date changes, so missed payments are visible later.

The local Windows app and the hosted online app use different browser storage locations. If moving records from one to the other, connect and wait for the existing app to show Synced before signing in to the hosted app.
