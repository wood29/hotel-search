# Hotel Search (private)

Michael's personal hotel search across his loyalty programmes.

- `webapp/` – runs on the NAS (Python standard library only). `VERSION` decides what ⚙︎ offers as an update.
- `webapp/readers.py` – reads hotel lists, prices, points and sign-in state from page text. Fixes for changed hotel sites go here.
- `addon/` – the small browser add-on: opens the hotel tabs and sends page text to the NAS. Rarely changes; a copy ships as `webapp/static/hotel-search-addon.zip`.
- `tests/samples.js` – saved page texts used to check the readers.

No passwords or keys are stored in this repository.
