# Share Goals through Google Sheets

This lets everyone in the family use Goals on their own phone or computer, with all data kept in **one Google Sheet that you own**. It takes about 5 minutes and only has to be done once, by one person.

## 1. Create the sheet and the script

1. Go to [sheets.new](https://sheets.new) and name the sheet, e.g. **Goals – Family**.
2. In the sheet, open **Extensions → Apps Script**.
3. Delete the sample code, paste in **all** of `Code.gs` from this folder, and click **Save** (💾).

## 2. Deploy it as a web app

1. Click **Deploy → New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Set:
   - **Execute as:** *Me*
   - **Who has access:** *Anyone*
4. Click **Deploy**. Google asks you to authorize the script. Choose your account; on the "Google hasn't verified this app" screen, click **Advanced → Go to … (unsafe)** (it's your own script), then **Allow**.
5. Copy the **Web app URL**. It looks like `https://script.google.com/macros/s/…/exec`.

## 3. Connect Goals

On each device: open Goals → **Change** next to "Data" on the sign-in screen (or **Settings → Where data is stored → Change…**). Choose **Google Sheets**, paste the URL, click **Test connection**, then **Save**.

Each person then clicks **Add person** and picks a passcode. After that, use **Sharing…** in your profile menu to choose, for each topic, who can see it and who can edit it with you.

## Editing together

In **Sharing…**, every person gets one choice for all your data: **No access**, **Can view everything** or **Can edit everything** (topics added later are included). Pick **Choose per topic…** to set Food and Monthly Balance separately. With **Can edit**, they see a ✎ pill with your name on that topic's input screen (e.g. Food → Plan). They plan meals, tick groceries or enter numbers right in your data, and it's saved to your rows in the sheet.

- If you both change things at about the same time, the app merges both sets of changes when saving. Only when you both changed the very same value does the later save win.
- While someone can edit your data (or while you look at someone else's), the app checks for their changes every 20 seconds and when you come back to the tab. It doesn't redraw while you're typing in a field.
- The readable tabs (e.g. **Groceries**) always list the data under its owner's name, whoever made the change.

Numbers you already entered on this device come with you: the first time you add yourself on Google Sheets **with the same name** you used on this device, the app copies them over. On another device, use **Settings → Export backup** there and **Import backup** after signing in.

## Good to know

- **The sheet owner can see everyone's raw data.** The app enforces view-only sharing between family members, but whoever owns the Google Sheet can open it and read every tab. Set it up from an account the whole family trusts.
- Anyone who has the web app URL can see the list of names and try to sign in. Passcodes are stored hashed, and 5 wrong tries lock that person out for 15 minutes. Share the URL only with family.
- Saving happens automatically a second or so after you stop typing. The header shows "Saved to Google Sheets" when it's done.
- The tabs **Monthly Balance**, **Income** (each income source), **Targets**, **Expenses** (entered by hand, direct or card), **Transactions** (imported card purchases), **Leftover Plan**, and from the Food tab **Groceries** and **Meal Plan** are readable copies that update on every save. Edit numbers in the app, not in the sheet; changes made in the sheet are overwritten.
- **Use the same app version on every device.** Readable tabs from an older copy of Goals are mapped to the new columns by name, but an older copy writing after a newer one can misplace columns until everyone updates.
- **After changing `Code.gs`**, go to **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.
- **Editing together needs the current `Code.gs`.** With an older script, sharing per topic and saving into someone else's data show "The Google Sheet script is an older version"; paste the new `Code.gs` and deploy a new version as above. Shares you made before keep working as "Can view" for every topic.
