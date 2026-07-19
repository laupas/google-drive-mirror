# Step-by-step: Set up Google so the plugin can access your Drive

This guide is for **everyone** — no technical background needed. Just follow
the steps in order. It takes about **10–15 minutes**, and you only do it
**once**.

## What are we doing, and why?

The plugin syncs files between your Obsidian vault and *your own* Google Drive.
For that, Google needs to know that **you** allow this specific plugin to touch
**your** files. Google's way of granting that permission is called an
**"OAuth client"** — think of it as a **key** that you create in your Google
account and then paste into the plugin.

You are not signing up for anything, not paying anything, and not sharing your
files with the plugin's author. Everything stays in **your** Google account and
on **your** devices.

> **Two keys if you use your phone too.** Google only lets one key work on
> computers *or* on phones, not both. So:
> - **Only using Obsidian on a computer?** Do **Part A** only.
> - **Also using Obsidian on a phone/tablet?** Do **Part A** *and* **Part B**.

---

## Before you start

- A Google account (the one whose Drive you want to sync).
- A web browser on a computer. (Even the phone setup is easiest done once on a
  computer.)

Keep this page open on one side and the Google Cloud Console on the other.

---

## One-time groundwork (do this first)

### 1. Open the Google Cloud Console

Go to **https://console.cloud.google.com/** and sign in with your Google
account.

Don't be intimidated by how it looks — you'll only touch a few pages.

### 2. Create a project

A "project" is just a container for your key.

1. At the **top-left**, click the project dropdown (it may say *"Select a
   project"*).
2. Click **"New Project"**.
3. Give it any name you like, e.g. **`Obsidian Sync`**. Leave everything else as
   is.
4. Click **"Create"** and wait a few seconds.
5. Make sure your new project is **selected** in that top-left dropdown before
   continuing.

### 3. Turn on the Google Drive connection

1. In the search bar at the top, type **`Google Drive API`** and click the
   result.
2. Click the blue **"Enable"** button.
3. Wait until it says it's enabled.

### 4. Fill in the consent screen (who's asking for permission)

This is the screen you'll see later when you click "Sign in" — it tells you
which app wants access.

1. In the left menu, go to **"APIs & Services" → "OAuth consent screen"**.
   (If it asks, choose to configure it / get started.)
2. For **User Type**, choose **"External"**, then **"Create"**.
3. Fill in the required fields:
   - **App name:** anything, e.g. `Obsidian Sync`
   - **User support email:** your own email
   - **Developer contact information:** your own email again
4. Click **"Save and Continue"** through the next pages. You can skip the
   optional stuff (scopes, etc.) — just keep clicking **"Save and Continue"**.
5. On the **"Test users"** step, click **"Add Users"** and enter **your own
   Google email address**. Click **"Save and Continue"**.

> **Why test users?** While your project is in "testing" mode, only the emails
> you list here may use the key. That's perfect — it means **no Google review
> or verification is needed**. You're the only test user, and that's fine.

You're now ready to create the actual key(s).

---

## Part A — The key for your computer (Desktop)

Do this if you use Obsidian on a Mac, Windows, or Linux computer.

1. In the left menu, go to **"APIs & Services" → "Credentials"**.
2. Click **"+ Create Credentials"** at the top, then **"OAuth client ID"**.
3. For **Application type**, choose **"Desktop app"**.
4. **Name:** anything, e.g. `Obsidian Desktop`.
5. Click **"Create"**.
6. A box pops up with a **Client ID** and a **Client secret**. **Keep this box
   open** — you'll copy both values.

Now put them into the plugin:

1. In Obsidian on your computer, open **Settings → Google Drive Mirror**.
2. Paste the **Client ID** into the **"Client ID"** field.
3. Paste the **Client secret** into the **"Client secret"** field.
4. Click **"Sign in with Google"**. Your browser opens — pick your account and
   click **"Allow"**.
   - If you see a warning like *"Google hasn't verified this app"*, that's
     expected (it's your own app). Click **"Continue"** / **"Advanced" → "Go to
     … (unsafe)"** — it's *your* app, so it's safe.
5. Back in Obsidian you should see **"✅ Signed in"**. Done!

If you only use a computer, **you can stop here.**

---

## Part B — The key for your phone or tablet (Mobile)

Do this **in addition to Part A** if you also use Obsidian on iPhone, iPad, or
Android. You can do these steps on your computer too — you'll just type the
result into the plugin on your phone at the end.

1. In the left menu, go to **"APIs & Services" → "Credentials"**.
2. Click **"+ Create Credentials"**, then **"OAuth client ID"**.
3. For **Application type**, choose **"Android"** or **"iOS"** — **either one is
   fine**, pick whichever the menu offers most easily. (This kind of key has no
   "secret", which is normal.)
4. **Name:** anything, e.g. `Obsidian Mobile`.
5. There will be a field for a **redirect URI** or **custom scheme / bundle**.
   Enter **exactly** this, with no spaces:

   ```
   obsidian://gdrive-auth
   ```

   > **This exact text matters.** It's how your phone hands control back to
   > Obsidian after you sign in. A typo here means sign-in won't return to the
   > app.

6. Click **"Create"**.
7. Copy the **Client ID** it gives you. (There is **no secret** for this type —
   that's correct.)

Now put it into the plugin **on your phone**:

1. On your phone, open Obsidian → **Settings → Google Drive Mirror**.
2. Paste the value into the **"Mobile client ID"** field.
3. Leave the "Client secret" empty on mobile.
4. Tap **"Sign in with Google"**. Your browser opens — pick your account and tap
   **"Allow"**. It should automatically bounce you back into Obsidian, now
   signed in.

---

## Troubleshooting

- **"Google hasn't verified this app" warning:** Expected — it's your own app.
  Choose **Continue / Advanced → proceed**. As long as your email is listed
  under **Test users**, this is safe.
- **"Access blocked" / "you don't have access":** Your Google email isn't in the
  **Test users** list. Go back to **OAuth consent screen → Test users** and add
  it.
- **Sign-in doesn't return to Obsidian on the phone:** The redirect URI on the
  mobile key is probably mistyped. It must be **exactly** `obsidian://gdrive-auth`.
- **`redirect_uri_mismatch` error on the phone:** You used the *Desktop* key on
  the phone. The phone needs the **Android/iOS** key (Part B) in the **"Mobile
  client ID"** field.
- **It worked yesterday, now it asks me to sign in again:** Normal from time to
  time. Just click **"Sign in with Google"** again.

---

## What you created (summary)

| Where | Key type | Fields to fill in the plugin |
|-------|----------|------------------------------|
| Computer | "Desktop app" | Client ID **+** Client secret |
| Phone / tablet | "Android" or "iOS" | Mobile client ID (**no** secret), redirect `obsidian://gdrive-auth` |

Both keys live in the **same Google project** and use the **same Drive** — you
just sign in once per device.
