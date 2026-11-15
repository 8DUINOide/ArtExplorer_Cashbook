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
- For manual recovery or moving records to another browser, use **Activity → Backup and restore**. Normal cross-device syncing uses the shop account.
- Use **Monthly** to compare income, expenses, lender payments, staff advances, and cash movement by week.

Amounts are displayed in Philippine pesos (₱).

## Local storage and cloud sync

The local-only database is IndexedDB in the browser on this computer. Records are saved there first, so daily use continues without internet. When cloud sync is configured and the shop account signs in, the app synchronizes records with Supabase PostgreSQL. The cloud sync uses Supabase's client API; it does not connect directly to PostgreSQL from the browser.

The app administrator sets up cloud sync once:

1. Create a Supabase project and open its SQL Editor.
2. Run the SQL in `supabase/schema.sql` to create the cashbook tables and owner-only access policies.
3. In Supabase Authentication, create the shop's email/password account.
4. Copy `supabase-config.example.js` to `supabase-config.local.js`, then enter the Project URL and a publishable (`sb_publishable_...`) key.
5. For local use, run the Windows launcher. For other computers, publish the app with the GitHub Pages instructions below and sign in with the same shop account.

`supabase-config.local.js` is ignored by Git so it will not be committed. This app is plain HTML and JavaScript with no build step, so it cannot read a `.env` file directly. The config file is loaded by the browser, so it must contain only the publishable key; never put an `sb_secret_...` or `service_role` key there. Publishable keys are designed for browser apps, and the database policies restrict signed-in accounts to their own records.

For deployments from a Git checkout, provide `supabase-config.local.js` as a deployment-only file or generate it during deployment from the host's environment settings. The same file can be deployed publicly because it contains only the publishable key, not a secret.

Income, expense, and reimbursement records use unique IDs. A lender payment has one editable daily record per lender, so avoid editing the same lender's payment from two offline devices at once; the most recently updated copy wins when they sync. Manual file recovery is available under **Activity → Backup and restore**.

## Publish the online version

The local Windows launcher only works on the computer running it. To let staff use the cashbook elsewhere, publish it once with GitHub Pages. The repository includes a workflow that builds the static app and adds the Supabase Project URL and publishable key during deployment; the key is not stored in the repository.

1. In the GitHub repository, open **Settings → Secrets and variables → Actions → Variables**.
2. Add `SUPABASE_URL` with the Supabase Project URL and `SUPABASE_PUBLISHABLE_KEY` with the `sb_publishable_...` key. Do not use an `sb_secret_...` key.
3. Open **Settings → Pages** and set the publishing source to **GitHub Actions**.
4. Push changes to the `main` branch, or run **Deploy ArtExplorer Cashbook** from the **Actions** tab.

When deployment succeeds, GitHub shows the app URL in the `github-pages` deployment. Open that same URL on each computer and install it from the browser menu if desired. Each computer keeps its own offline copy and syncs records through the same Supabase shop account. Downloading the repository ZIP is only for manually installing the app; it does not create a shared online address.

## Notes

- This is a cashbook, not a full accounting or tax system.
- Lender payments are tracked by the amount paid each day; the app does not track loan balances.
- The cash movement summary and closing count compare entered records with the physical drawer; they do not replace careful cash handling.
- Unpaid daily checklist rows remain in Activity after the date changes, so missed payments are visible later.

The local Windows app and hosted app use different browser storage locations. Sign into the same Supabase shop account from both to synchronize records between them.
