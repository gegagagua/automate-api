# Bookwise API

სრული ბექი — ლაივზე გადაიტანე **მთელი `server/` ფოლდერი** (ან git clone-ის შემდეგ მხოლოდ ეს დირექტორია).

## ბრძანებები (მხოლოდ აქ)

```bash
cd server
npm install
npm run dev          # ლოკალური განვითარება (node --watch)
npm start            # პროდაქშენი (აყენებს NODE_ENV=production → config/prod.js)
npm run migrate:mysql
npm run pw:install   # Playwright Chromium
npm run pw:check
```

### MySQL სავალდებულოა

API იყენებს **MySQL**-ს. თუ ხედავ `ECONNREFUSED 127.0.0.1:3306` — MySQL არ გაქვს გაშვებული.

- **macOS (Homebrew):** `brew services start mysql` ან Docker-ით MySQL კონტეინერი.
- **კავშირი** იკითხება გარემოს ცვლადებიდან (იხილე ქვემოთ).

### ლოკალი vs პროდაქშენი (DB)

კონფიგი ორ ფაილშია: **`server/config/local.js`** და **`server/config/prod.js`**.

| რომელი ირჩევა | პირობა |
|----------------|--------|
| **local** | ნაგულისხმევი (`APP_ENV` არ არის prod და `NODE_ENV` ≠ `production`) |
| **prod** | `APP_ENV=prod` **ან** `NODE_ENV=production` |

**Plesk / ჰოსტი:** აუცილებლად გაუშვი **`npm start`** (არა მარტო `node index.js`), ან პანელში დაამატე გარემო: **`NODE_ENV=production`** — თორემ ირჩევა **local** (`root` / ცარიელი პაროლი) და მიიღებ `Access denied for user 'root'`.

პრიორიტეტი: გარემოს ცვლადები (`DB_*`) ყოველთვის უპირატესია ფაილის default-ებზე.

| სად | როგორ |
|-----|--------|
| **ლოკალურად** | `server/.env` → `APP_ENV=local` + `DB_*` (ან მხოლოდ `local.js` default-ები). |
| **ლაივზე** | `APP_ENV=prod` + საჭირო `DB_*` ჰოსტის გარემოში **ან** `config/prod.js` (`defaults` — user `root`, DB `finance`, პაროლის გარეშე). |

```bash
# პროდაქშენი (მაგ. Plesk / systemd)
export APP_ENV=prod
export DB_HOST=127.0.0.1
export DB_PORT=3306
export DB_USER=root
export DB_PASSWORD=
export DB_NAME=finance
```

`PORT` (ნაგულისხმევი 4000) — API პორტი.

### SMS / Verify API (Bookwise)

1. **ბალანსი** და **გააქტიურება**: sms.to → **Verify API** → [Request Activation](https://app.sms.to/app#/verifications/request-activation) — ოფიციალურად წერია, რომ **ბალანსი** სჭირდება და გააქტიურებს მხარდაჭერა.
2. **API Key**: `SMSTO_BEARER_TOKEN` = dashboard → **API Keys** → bookwise.
3. **Application GUID**: `SMSTO_APP_GUID` = იმ Verify აპის GUID, რომელიც გააქტიურების შემდეგ გაქვს (არა ძველი სხვა პროექტის GUID).

**სად ჩანს გაგზავნილი OTP:** არა **Reports → Messages Log**. იხილე **Verify API → Verifications** (და ხშირად Channel Details). [დოკუმენტაცია](https://support.sms.to/support/solutions/articles/43000758472-verify-api-solution-how-to-activate-verify-api-manage-your-settings-view-results).

**სწრაფი ტესტი (Verify GUID არ სჭირდება):** `cd server && npm run test:sms-direct` — ნაგულისხმევად `+995597887736`. სხვა ნომერი: `npm run test:sms-direct -- "+9955..." "ტექსტი"`. ეს არის **ჩვეულებრივი SMS API** (`api.sms.to/sms/send`); ლოგი: **Reports → Messages Log**.

**Verify OTP ტესტი:** `npm run test:smsto "+9955..."` — სჭირდება **`SMSTO_APP_GUID`**. დებაგი: `SMSTO_DEBUG=1`.

- **404 Application not found**: არასწორი `SMSTO_APP_GUID` ან აპი ჯერ არ არის გააქტიურებული.

ფრონტი ცალკეა რეპოს root-ში (`npm run build` → `dist/`).

### ლოგინი + SMS (sms.to Verify)

რეფერენსი (იგივე ნაკადი): `SmsToVerifyService.php` — მაგ. `htdocs/mykids/app/Services/SmsToVerifyService.php`. OAuth body Laravel-ში JSON-ია; Node იგივეს ცდის, თუ ვერა — `x-www-form-urlencoded`.

`server/.env` (არ იტვირთება git-ში):

- **`SMSTO_APP_GUID`** — Verify აპის `guid` (აუცილებელი)
- **`SMSTO_CLIENT_ID`** + **`SMSTO_SECRET`** — OAuth `client_credentials` (როგორც PHP-ში `client_id` / `secret`)
- ან **`SMSTO_BEARER_TOKEN`** — თუ უკვე გაქვს JWT და OAuth არ გჭირდება

**რეალური SMS:** `server/.env`-ში **`SMSTO_APP_GUID`**, **`SMSTO_CLIENT_ID`**, **`SMSTO_SECRET`** (ან **`SMSTO_BEARER_TOKEN`**) და **`SMSTO_DEV_BYPASS`** არ უნდა იყოს `1`. Dev-იმიტაცია მხოლოდ **`SMSTO_DEV_BYPASS=1`**-ზე — კოდი **`11111`**.
# automate-api
