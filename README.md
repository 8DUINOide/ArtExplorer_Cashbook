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

## Local storage and cloud sync

The local-only database is IndexedDB in the browser on this computer. Records are saved there first, so daily use continues without internet. When cloud sync is configured and the shop account signs in, the app synchronizes records with Supabase PostgreSQL. The cloud sync uses Supabase's client API; it does not connect directly to PostgreSQL from the browser.

The app administrator sets up cloud sync once:

1. Create a Supabase project and open its SQL Editor.
2. Run the SQL in `supabase/schema.sql` to create the cashbook tables and owner-only access policies.
3. In Supabase Authentication, create the shop's email/password account.
4. Copy `supabase-config.example.js` to `supabase-config.local.js`, then enter the Project URL and a publishable (`sb_publishable_...`) key.
5. Serve the app from the same HTTPS address on each device, then sign in with the shop account.

`supabase-config.local.js` is ignored by Git so it will not be committed. This app is plain HTML and JavaScript with no build step, so it cannot read a `.env` file directly. The config file is loaded by the browser, so it must contain only the publishable key; never put an `sb_secret_...` or `service_role` key there. Publishable keys are designed for browser apps, and the database policies restrict signed-in accounts to their own records.

For deployments from a Git checkout, provide `supabase-config.local.js` as a deployment-only file or generate it during deployment from the host's environment settings. The same file can be deployed publicly because it contains only the publishable key, not a secret.

Income, expense, and reimbursement records use unique IDs. A lender payment has one editable daily record per lender, so avoid editing the same lender's payment from two offline devices at once; the most recently updated copy wins when they sync. Keep downloading local JSON backups under Activity or Setup.

## Publish the online version

The app needs an HTTPS static host so it can be installed and used on other computers or phones. Firebase Hosting can still serve the app files, but it is only the website host; Supabase is the database and sign-in service. You can also use another static hosting provider.

For Firebase Hosting, install Node.js and the Firebase CLI, then run these commands from this folder:

    npm install -g firebase-tools
    firebase login
    firebase use --add
    firebase deploy --only hosting

Select a Firebase project used for Hosting. No Firestore database or Firestore rules are needed. Open the Hosting address, sign in with the Supabase shop account, and install the app from the browser menu if desired. The app's local Windows launcher remains available for this computer.

## Notes

- This is a cashbook, not a full accounting or tax system.
- Lender payments are tracked by the amount paid each day; the app does not track loan balances.
- The cash movement summary and closing count compare entered records with the physical drawer; they do not replace careful cash handling.
- Unpaid daily checklist rows remain in Activity after the date changes, so missed payments are visible later.

The local Windows app and the hosted online app use different browser storage locations. Sign into the same Supabase shop account from both to synchronize records between them.
