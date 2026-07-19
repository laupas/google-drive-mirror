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

> **One key, works everywhere.** You create a single key on a computer (Part A).
> If you also use Obsidian on a phone or tablet, you don't create a second key —
> you sign in on the computer and then copy a "sign-in token" over to the phone
> (Part B). Google no longer allows phones to sign in directly.

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

## Part B — Getting signed in on your phone or tablet

Do this **after Part A** if you also use Obsidian on iPhone, iPad, or Android.
There is **no second key to create** — the phone can't sign in to Google
directly, so you carry the sign-in over from the computer.

**On the computer (already signed in from Part A):**

1. Open Obsidian → **Settings → Google Drive Mirror**.
2. Click **"Copy sign-in token"**. This copies a long text token to your
   clipboard.
3. Get that token onto your phone. Any way works — e.g. paste it into a note
   that syncs to your phone, email it to yourself, or put it in your password
   manager. (Treat it like a password.)

**On the phone:**

4. Open Obsidian → **Settings → Google Drive Mirror**.
5. Enter the **same Client ID and Client secret** as on the computer (from Part
   A). You can copy those over the same way.
6. Expand **"Sign in with a token from another device"**, paste the token into
   the field, and tap **"Sign in with token"**.
7. You should see **"✅ Signed in"**. Done — the phone now syncs like the
   computer.

> **Why not just sign in on the phone?** Google removed the sign-in methods that
> used to work inside apps like this on mobile. Copying the token from a
> computer is now the supported way — and it's a one-time step per device.

---

## Troubleshooting

- **"Google hasn't verified this app" warning (on the computer):** Expected —
  it's your own app. Choose **Continue / Advanced → proceed**. As long as your
  email is listed under **Test users**, this is safe.
- **"Access blocked" / "you don't have access":** Your Google email isn't in the
  **Test users** list. Go back to **OAuth consent screen → Test users** and add
  it.
- **Phone says sign-in failed after pasting the token:** Make sure you entered
  the **same Client ID and Client secret** on the phone as on the computer, and
  that you copied the **whole** token (they're long).
- **The button doesn't open a browser on the phone:** That's expected — the
  phone doesn't sign in through a browser. Use the **token** method above
  instead.
- **It worked yesterday, now it asks me to sign in again:** Normal from time to
  time. On the computer, just click **"Sign in with Google"** again; on the
  phone, copy a fresh token over.

---

## What you created (summary)

| Where | What you do | Fields to fill in the plugin |
|-------|-------------|------------------------------|
| Computer | Create one **"Desktop app"** key, sign in | Client ID **+** Client secret |
| Phone / tablet | **No new key** — paste the copied token | Client ID **+** Client secret **+** the sign-in token |

The one key lives in your Google project and uses your Drive on every device.
