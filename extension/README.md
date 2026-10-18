# OnePost Vinted Poster (Chrome extension)

Posts approved OnePost items to the Vinted account logged in to this Chrome profile.

## Install (MacBook, about 5 minutes)

1. Chrome → profile menu → **Add** → create a profile called **Jessica Vinted**. Everything below happens in that profile.
2. Log in to Vinted (vinted.co.uk) in that profile.
3. Go to `chrome://extensions` → turn on **Developer mode** (top right) → **Load unpacked** → pick this `extension` folder.
4. Click the extension's icon (pin it from the puzzle-piece menu) and fill in:
   ↳ **OnePost address**: already filled in
   ↳ **Worker token**: the `WORKER_TOKEN` value from Railway Variables
   ↳ **Posting mode**: start on **Review**
5. **Save**, then **Test connection**. It should say "Connected to OnePost".

## How it behaves

→ Every minute it checks OnePost for approved Vinted items.
→ **Review mode:** opens Vinted's sell page, fills everything in and waits for you to check it and press **Upload**. OnePost marks it Live automatically once uploaded.
→ **Automatic mode:** fills and uploads on its own, then closes the tab.
→ Posts are spaced 2 to 4 minutes apart.
→ If it can't match something (category, size), the item shows **Needs a hand** in OnePost with the reason. Fix it in Vinted or retry from the phone.
→ The badge shows `…` while posting, `✋` when a filled form is waiting for you, `!` on a problem, `II` when paused.

## Requirements

→ The Mac must be awake with Chrome open on this profile for items to post. Queued items wait safely until then.
→ Keep Vinted logged in on this profile.
