# Nurvia Petcare — Phase 1 platform

| Folder | What it is |
|---|---|
| [backend/](backend/) | Shared API for the Pet Parent app, Vendor app and Admin panel. Node.js + Express 5 + MongoDB (Mongoose). |
| [admin-panel/](admin-panel/) | Admin panel for Nurvia staff. React 18 + Vite. Opens on the super admin overview: snapshot metrics and four triage queues (vendor applications, safety alerts, community dog badges, adoption sign-off). It has no screen for browsing or suspending pet parents; that is done through `/admin/users` in the API. |
| [vendor-panel/](vendor-panel/) | Partner panel for vets, groomers and other providers: today's schedule, booking requests, services and prices, reviews, earnings, business profile and KYC, plus the shop: products, orders, returns and wishlist counts. React 18 + Vite. A separate app from the admin panel, with its own login (mobile OTP). |

There is no pet parent website. The mobile apps (Pet Parent, Vendor) are not in this repo yet; they use the same `/api/v1` endpoints, including the customer side of the shop.

## Run it locally

You need Node.js 22 or newer.

### Try it with no database installed

```bash
cd backend && npm install && npm run dev:memory           # API on :4000 with demo data in memory
cd admin-panel && npm install && npm run dev              # admin panel on :5280
cd vendor-panel && npm install && npm run dev             # partner (vendor) panel on :5281
```

- **Admin panel** (http://localhost:5280): `admin@nurvia.local` / `nurvia-dev-password`
- **Partner panel** (http://localhost:5281): sign in with mobile `9845000003` (Dr. Kiran Patel, Happy Paws Veterinary Clinic). The OTP is shown on screen in development.
- Each app refuses to start if its port is taken, rather than moving to another port the API does not accept. To use a different port, change it in that app's `vite.config.js` and add it to the API's `CORS_ORIGINS` (default: 5280 and 5281).

All data is lost when the API stops.

### With a real MongoDB (local, or Atlas)

```bash
cd backend
cp .env.example .env          # set MONGODB_URI, JWT_ACCESS_SECRET, OTP_HASH_SECRET
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long password' npm run seed
npm run dev
```

`npm run seed` also builds the database indexes. In production the API does not build indexes by itself, so run `npm run db:indexes` after every deploy that adds one; existing indexes are left alone.

To try the apps against a real database with the same demo data as `dev:memory`, run `npm run seed:demo` on an empty database (`npm run seed:demo -- --reset` drops the database first).

API docs (Swagger) are at http://localhost:4000/api-docs outside production, generated from the routes and their validation schemas.

Tests: `cd backend && npm test`. They start their own in-memory MongoDB and run the main flows end to end: OTP login, tenant isolation, the KYC → approval → geo discovery path, booking clashes, payment and refund, reviews, moderation, permissions and announcements.

## Architecture

- **Modular, API-first.** Each domain lives in `backend/src/modules/<name>/` and owns its model and routes: auth, users, pets, vendors, bookings, payments, community-dogs, adoption, community, reviews, reports, notifications, files, ai, admin and tenants, plus nfc, sos, shop (with returns and reviews), operations (vendor workspace: staff, CRM, appointments, visit records), finance (seller onboarding, commission, settlements), loyalty and plans.
- **Multi-tenant from day one.** Every collection except `tenants` has a `tenant` field. A Mongoose plugin ([tenancy.js](backend/src/common/tenancy.js)) scopes every query to the request's tenant. A query that runs without a tenant context throws instead of returning another tenant's data. Phase 1 runs a single tenant, `nurvia`. Phase 2 white-label stores send `X-Tenant: <slug>`.
- **RBAC.** Roles are `pet_parent`, `vendor`, `caregiver`, `seller`, `staff`, `admin` and `super_admin`. Admin-panel endpoints check fine-grained permissions such as `vendors.review` or `content.moderate` ([roles.js](backend/src/common/roles.js)). Roles and account status are re-read on every request, so a suspension takes effect immediately.
- **Auth.** New users confirm their mobile number with a 6-digit code, then fill in the profile screen (name, photo, city and so on), which creates the account. Registered users log in with a code sent by SMS to their mobile number, or with Google or Apple (the app sends the provider's ID token; a verified email links to an existing account). Staff log in with email and password, and an account with a password cannot use an OTP instead. A code allows 5 attempts (counted atomically, so parallel guesses don't get extra tries), opens one session only, and a number or email gets at most 5 codes an hour. Access tokens are JWTs that last 15 minutes. Each sign-in is a session; its refresh token rotates on every use. A rotated token still works for 30 seconds (a second tab or a retried request), and is treated as stolen after that: that session ends, other devices stay signed in. Changing a password, deleting the account and suspension also reject access tokens already issued.
- **Money** is stored as integer paise. Each booking keeps a snapshot of the service's name, price and duration at the time it was booked.
- **Time.** Operating hours are interpreted in IST (`UTC_OFFSET_MINUTES=330`). Timestamps are stored in UTC.
- **Security.** Requests and uploads are validated with zod. Uploaded files are type-checked by their magic bytes. KYC documents and health records are private and are served only with an auth check. The API also uses Helmet, rate limits and a webhook signature check. Provider keys stay on the server, and every admin write is recorded in an audit log. Audit entries form a SHA-256 hash chain, so an edited or deleted entry shows up in `/admin/audit/verify` and in the exported dossier.

## Third-party integrations

Each provider sits behind an adapter in `backend/src/integrations/`. Switch providers with an env var.

| Need | Status | Env |
|---|---|---|
| OTP / SMS | **Console only.** Codes are printed to the log and returned in API responses in dev. An Indian SMS provider (MSG91, Gupshup, etc.) plus DLT template registration is needed before launch. | `OTP_PROVIDER` |
| Payments | **Razorpay implemented** (orders, signature verification, webhooks, refunds). A mock gateway is used for dev. Cashfree would be a sibling adapter. | `PAYMENT_GATEWAY`, `RAZORPAY_*` |
| Push | **FCM implemented** (needs `npm i firebase-admin` and a service account). The console adapter is used for dev. | `PUSH_PROVIDER` |
| Call relay (Explore → Call Store) | **Not masked yet.** The `direct` adapter gives customers the shop's own number. A masking provider (Exotel, Knowlarity) is needed before calls hide both numbers. | `CALL_RELAY_PROVIDER` |
| File storage | **Local disk.** Swap to S3, GCS or R2 for production. | `UPLOAD_DIR` |
| AI health summary | **Endpoint and data-minimisation in place; no provider yet.** Returns 503 until Nurvia approves a provider. | `AI_PROVIDER` |
| Maps | The API does the geo search itself (MongoDB `2dsphere`). The apps still need a Google Maps key for map display and geocoding. | — |
| Email | Not wired yet. Email codes and sign-in links use the same OTP adapter. | `MAGIC_LINK_URL` |
| Google / Apple sign-in | **Implemented** (ID tokens checked against the providers' published keys). Off until client IDs are set. | `GOOGLE_CLIENT_IDS`, `APPLE_CLIENT_IDS` |

## Decision to confirm with Nurvia: MongoDB vs PostgreSQL

The scope document prefers PostgreSQL and accepts MySQL. This build uses MongoDB, as requested. Things to know before Phase 2:

- Phase 1 data (pets with flexible health-record details, geo search, community content) fits documents well. The design also allows for the parts that don't: references between collections are explicit, indexes are declared, and there's a single place for tenant scoping.
- Phase 2 checkout, inventory, refunds and settlements need **multi-document transactions**. MongoDB supports these only on a replica set. Atlas is a replica set by default; a self-hosted single `mongod` is not. Plan for Atlas, or a 3-node replica set, in production.
- Finance reporting (GST, settlements) is easier in SQL. If that becomes painful, the settlement ledger can be split into PostgreSQL later without touching the rest.

## API overview (`/api/v1`)

| Area | Endpoints |
|---|---|
| Auth | New phone registration: `POST /auth/otp/request` (`phone`, optional `channel` / `appHash`) → `POST /auth/otp/verify` (`phone`, `code`; a new number gets `isNew: true` and no account is created yet) → `POST /auth/register` with the returned one-time `registrationToken` and profile details (`name` required; optional `email`, `city`, `locality`, `emergencyContact` {`name`, `phone`}, `whatsapp`, `acceptTerms`; JSON or multipart/form-data with optional `photo`). The verified phone is bound to the token; it expires after 10 minutes and can be used once. Registration creates the account and signs in. Existing numbers receive a sign-in code from `/auth/otp/request` and sign in through `/auth/otp/verify`. The email is kept as `pendingEmail` until verified through `/users/me/contact/request` + `/verify`. `POST /auth/google`, `/auth/apple` (ID token from the app's SDK; creates the account on first use). Sessions: `/auth/refresh`, `/auth/logout`. Staff (admin panel): `/auth/login`, `POST /auth/password` |
| Onboarding | Every sign-in returns `isNew` and `onboarding`: `nextStep` (`terms`, `profile`, `pet`, `done`), `missing` profile fields (name, phone, city), `hasLocation` and `notificationsAnswered`. `GET /users/me/onboarding`, `POST /users/me/terms` (`version`) |
| Profile | `GET/PATCH /users/me` (name, `avatarFileId`, `city`, `locality`, `emergencyContact`, `preferences.language` / `notifications` / `whatsapp`; `null` clears a field), `POST /users/me/contact/request` + `/contact/verify` (add or change the mobile number or email with a code), `PUT /users/me/location` (GPS or picked place, or a city's centre; answers the city and what is live there), `PUT /users/me/addresses`, `POST/DELETE /users/me/devices`, `DELETE /users/me`. `GET /config` lists the cities and languages for the pickers. A vendor sees the customer's emergency contact on `GET /bookings/:id` only for an accepted booking, from a day before the visit to a day after |
| Pets | `GET /pets/overview` (My Pets screen: `empty`, each pet's `nextReminder`, `emptyState.actions` add_pet / adopt, species for the add form), `GET/POST /pets`, `GET/PATCH/DELETE /pets/:id`, `…/:petId/records`, `…/:petId/reminders` |
| Files | `POST /files` (multipart `file` + `purpose`), `GET /files/:id` |
| Vendors | `GET /vendors?lat&lng&radiusKm&category&q`, `GET /vendors/:id`, `GET /vendors/:id/availability?serviceId&date&addOnIds&staffId`, `GET /vendors/:id/staff` (people a customer can choose: name, title, experience, rating); vendor self-service under `/vendors/me` (incl. `arrivalInstructions`), `/vendors/me/kyc`, `/vendors/me/services` (incl. `addOns`: name, price, extra minutes) |
| Bookings | `GET /bookings?as=user\|vendor`, `GET /bookings/:id`, `POST /bookings/:id/actions` (`accept`, `reject`, `reschedule`, `cancel`, `complete`, `no_show`; customers can reschedule up to 2 hours before, and the studio then confirms again) |
| Booking flow (pet parent app) | Summary: `POST /bookings/quote` (price lines with add-ons, total time, whether the slot is still free, payment modes, cancellation policy, what passport sharing would show). Securing: `POST /bookings/holds` keeps the slot for 5 minutes; if it was just taken, it holds the closest free time and lists nearby alternatives. `GET/DELETE /bookings/holds/:id`. Book: `POST /bookings` with `holdId` (or the vendor, service, `addOnIds`, pet, `staffId` and time), `sharePassport`, `notes`, `paymentMode` (`pay_at_provider` / `online`); a taken slot answers `409 SLOT_TAKEN` with alternatives. `GET /bookings/appointments?tab=upcoming\|past\|cancelled&pet` (cards, tab counts, pet chips, recent history). `GET /bookings/:id/details` (confirmation and details: progress, check-in QR code, staff, care notes, passport window, policy, reminder, calendar links). `GET /bookings/:id/calendar.ics`, `PUT /bookings/:id/passport-share`, `GET/POST /bookings/:id/messages`. An appointment reminder is pushed 2 hours before an accepted visit |
| Payments | `POST /payments/bookings/:id/order`, `POST /payments/verify`, `POST /payments/webhook` |
| Reviews | `GET /reviews?vendor`, `POST /reviews`, `POST /reviews/:id/reply` |
| Community dogs | `GET/POST /community-dogs`, `GET/PATCH /community-dogs/:id`, `…/caregivers`, `…/logs`. Registration: `POST /community-dogs/drafts` (save draft), `GET /:id/submit-check` (what is missing), `POST /:id/submit` (publish for review), `DELETE /:id/draft`; fields for life stage, size, ear notch, roaming radius, landmarks, feeding schedule and food tolerances. `GET /community-dogs/liaisons?lat&lng` (nearby SOS responders to pick as `emergencyLiaisonId`). Profile: health matrix (anti-rabies, combination vaccine, deworming, sterilisation) from the care log, badges, care team with titles, liaison, log counts. Team: `POST /:id/invites`, `GET /community-dogs/invites/:code`, `POST /community-dogs/invites/:code/accept`, `PATCH /:id/care-team/me` (title). Log: `GET /:id/logs?category=feeding\|medical\|sightings\|other&after`, `POST /:id/logs/:logId/thanks`, `POST /:id/logs/:logId/verify` (staff, official records). The public never sees where a dog lives: caregivers see an approximate centre and the radius, the primary caregiver and staff the exact pin |
| Adoption | `/adoption/listings` (+ `/status`, `/applications`), `/adoption/applications/mine`, `PATCH /adoption/applications/:id`. Browse: `GET /adoption/browse?lat&lng&radiusKm&city&q&group=all\|young\|adult_dogs\|cats\|special_needs` (cards with age label, health, foster, saved and my application; `rescuesNearby`; `emptyState` with indie rescues nearby and a wider radius). `PUT/DELETE /adoption/listings/:id/save`, `GET /adoption/saved`. Listings take `locality`, `dewormed` and `foster` |
| Explore | `GET /explore` (shops, community dogs and adoptions near you; marketplace state). Local pet shops: `GET /explore/shops?lat&lng\|locality&radiusKm&type&q&openNow&minRating&sort` (badge, one-line `description`, distance, hours with closing soon, tags, stock verified time; `popularLocalities` when no location), `POST /explore/shops/:id/call` (sign-in; returns `{ masked, dial }`, the number for `tel:`), pharmacy stock checks `POST /explore/shops/:id/stock-checks`, `GET /explore/stock-checks`. `GET /explore/localities?city&q`. Marketplace preview: `GET /explore/marketplace`, `PUT/DELETE /explore/marketplace/waitlist` (told when the marketplace goes live in their city), `GET /explore/marketplace/waitlist/summary` (staff). Shops: `PUT /vendors/me/store` (type pet_store / pharmacy / boutique, `note` for the card line, tags, pickup, cold chain, vet tech), `POST /vendors/me/store/stock-verified`, `GET /vendors/me/stock-checks`, `POST /vendors/me/stock-checks/:id/reply`. Admins set each city's `localities` |
| Home (pet parent app) | `GET /home/content?lat&lng\|locality&city&petId` (one call for the Home tab: `banners` for the pet's type and the user's city, top-level shop `categories` with an `icon` key, 3 `recommended` in-stock products for the pet's species, never naming one of its allergies and no puppy or kitten products for an adult, and up to 6 `localStores` within 5 km as in `GET /explore/shops`. Works signed out; `pet` is the chosen or first pet). Admin: `GET/POST /admin/banners`, `PATCH/DELETE /admin/banners/:id` (permission `marketing.manage`; image from `POST /files` with purpose `banner`; "{pet}" in the text becomes the pet's name) |
| Community | `/community/posts`, `…/reaction`, `…/comments`, `DELETE /community/comments/:id` |
| Shop | `GET /shop/home`, `/shop/categories`, `/shop/products?category&pet&q&minPrice&maxPrice&sort`, `/shop/products/:slug`, `POST /shop/quote`, `POST /shop/orders`, `GET /shop/orders`, `POST /shop/orders/:id/cancel`, `POST /payments/shop-orders/:id/order`; sellers: `/shop/seller/products`, `/shop/seller/orders?status&q` (only the seller's own lines, `sellerTotalPaise` and per-status `counts`), `POST /shop/seller/orders/:id/status`, `GET /shop/seller/wishlist` (how many customers saved each product, never who) |
| Notifications | `GET /notifications?unread`, `POST /notifications/read-all`, `/:id/read`. Permission screen: `GET /notifications/settings` (main switch, topics, and `prompt.show` = whether to show the screen now), `PUT /notifications/permission` (`status` granted / denied / later, `platform`, `token` when granted, `topics` left on; "Not now" asks again after 3, 7, then 30 days), `PATCH /notifications/settings` (`enabled`, `topics.<key>`). Topics: reminders, bookings, orders, safety, community, rewards. Switching one off stops the push only; the inbox keeps everything. A device token belongs to the account that registered it last |
| Other | `POST /reports`, `GET /categories?kind`, `POST /ai/pets/:petId/health-summary` |
| Partner panel | `GET /vendors/me/dashboard` (today, requests, earnings, setup checklist), `GET /vendors/me/earnings?from&to`, `GET /vendors/me/reviews?unreplied`, `GET /bookings?as=vendor&date=YYYY-MM-DD` |
| Admin overview | `GET /admin/overview?window=24h\|7d\|30d`, `/admin/queues/vendor-applications?sort=sla\|newest`, `/admin/queues/safety`, `/admin/queues/community-dogs`, `/admin/queues/adoption-audits`, `GET /admin/search?q`, `GET /admin/system/status` |
| Platform config | `GET /config?city&lat&lng` (public); `GET /config/cities?lat&lng&q&limit` (public: the "Select city" picker. Without `q`, Nurvia's cities; with `q`, search as you type over every Indian city and town, Nurvia's first, others with `status: unavailable`, and `matched` when found by another name such as Bombay. Also the city `detected` from the phone's location. An item's `slug` is the `city` for `/auth/register` and `PATCH /users/me`); admin: `GET /admin/platform`, `PATCH /admin/platform/features`, `POST /admin/cities`, `PATCH /admin/cities/:id` (permission `platform.configure`) |
| Vendor availability | `GET/POST /vendors/me/time-off`, `DELETE /vendors/me/time-off/:blockId`, `PUT /vendors/me/pause`, `GET /bookings?as=vendor&customer=<userId>` (visit history) |
| Admin actions | `POST /admin/vendors/:id/license-check`, `POST /admin/reports/:id/enforce`, `POST /admin/compliance/community-dogs/:id/verification`, `POST /admin/compliance/adoption/applications/:id/compliance` (`home_check`, `schedule_microchip`, `request_info`, `certify`), `GET /admin/audit/verify`, `GET /admin/audit/export` (CSV) |
| Admin | `/admin/session`, `/admin/dashboard`, `/admin/analytics`, `/admin/users`, `/admin/vendors` (+ `/review`), `/admin/categories`, `/admin/bookings`, `/admin/moderation/:type`, `/admin/reports`, `/admin/announcements`, `/admin/audit`, `/admin/tenants` |
| Passport & reminders | `PUT /pets/:id/lost`, `GET /pets/:id/timeline`, `GET /pets/:id/care-status` (recorded / due / missing core vaccines), `GET /pets/:petId/visits` (shared visit reports), `GET /reminders?kind&days` (all pets) |
| NFC / QR tags | Public: `GET /nfc/t/:code` (recovery profile), `POST /nfc/t/:code/found`. Owner: `GET /nfc/tags`, `POST /nfc/tags/activate`, `PATCH /nfc/tags/:id`, `/:id/deactivate`, `/:id/replace`, `/:id/reassign`, `/:id/scans`. Admin: `/admin/nfc/tags` (mint, list, lifecycle), `/admin/nfc/scans` |
| SOS / Lost & Found | Behind the `sos` switch: `POST/GET /sos/incidents`, `/:id/respond`, `/:id/withdraw`, `/:id/status` (`help_on_way`, `resolved`, `cancelled`), `/:id/updates`, `/:id/matches`; responder opt-in `GET/PUT/DELETE /sos/responder`. Admin: `/admin/sos/incidents`, `/admin/sos/responders` |
| Vendor workspace (owner + staff) | `GET /vendors/me/workspace`; `/staff`; `/customers` (+ `/:id/pets`, `/:id/notes`, `/:id/packages`); `/notes/:id`; `/follow-ups`; `/appointments` (+ recurrence, `/:id/status`); `/calendar`; `PUT /bookings/:id/staff`; `POST /bookings/check-in` (scanned QR `token` or booking `code`); `GET /bookings/:id/passport` (when the owner shared it, from a day before the visit until a day after); `/waitlist`; `/packages`; `/visits` (+ `/photos`, `/updates`, `/start`, `/end`, `/route`, `/complete`, `/share`); `/reports`; `/settlements`; `/subscription` |
| Record sync | `GET /record-shares`, `POST /record-shares/:id/accept`, `/decline` (owner approves clinic records before they reach the passport) |
| Marketplace aftercare | `POST /shop/orders/:id/returns`, `GET /shop/returns`, `/returns/:id/cancel`; `GET/POST /shop/products/:slug/reviews`; `GET /shop/wishlist`, `PUT/DELETE /shop/wishlist/items/:productId`; sellers: `GET/PUT /shop/seller/profile`, `/shop/seller/returns` (+ `/:id/decision`). Checkout accepts `redeemPoints` |
| Loyalty & referrals | `GET /loyalty/me`, `/loyalty/history`, `POST /loyalty/referrals/apply`. Admin: `/admin/loyalty/config`, `/adjust`, `/ledger`, `/referrals` |
| Plans & white-label | `GET /plans?audience`, `GET /storefront` (current tenant's branding, by `X-Tenant` or custom domain). Admin: `/admin/plans`, `PUT /admin/vendors/:id/subscription`, `PUT /admin/tenants/:id/subscription` |
| Admin operations | `/admin/pets` (no private health details), `/admin/payments`, `PATCH /admin/vendors/:id`, `/admin/vendors/:id/services`, `POST /admin/bookings/:id/actions` (cancel / refund), `/admin/shop/orders` (+ cancel), `/admin/shop/returns`, `/admin/coupons`, `/admin/sellers` (+ `/review`), `/admin/finance/commission`, `/admin/finance/settlements` (preview, run, approve, mark paid, void) |

Errors always have the shape `{ "error": { "code", "message", "details?" } }`.

## Cities, feature switches and vendor availability

- **Cities.** Staff add cities and set each one to Active, Coming soon or Disabled in the admin panel (Platform → Cities & features), with no code change. In an active city, service booking and the marketplace can each be set separately. `npm run seed` starts with Delhi NCR active and Mumbai, Bengaluru and Hyderabad coming soon. The in-memory demo also turns Bengaluru on, because all the demo vendors are there.
- **What a city controls.** Only local services: vendor search, availability, booking, and shop delivery (orders are checked against the delivery address). The pet passport, health records, reminders, adoption, community dogs, community and AI work for every user, in any city. Until at least one city exists, booking and the marketplace run everywhere.
- **Matching a place to a city.** A city matches by its name or any alias (for example, Gurugram and Noida count as Delhi NCR), or by location within its radius.
- **Home city outside Nurvia's cities.** A user can pick any Indian city or town as their city (`GET /config/cities?q=`). It is saved by name, with no `citySlug`, and local services there show as unavailable. The list is `backend/src/modules/platform/india-cities.json`, built from [GeoNames](https://www.geonames.org) data (CC BY 4.0, so GeoNames must be credited, e.g. in the app's licences screen) by `node scripts/build-india-cities.js`; the script says which files to download.
- **Feature switches.** Service booking, Marketplace, Adoption, Community dogs, Community feed, AI and SOS can be switched off platform-wide. A switched-off module's endpoints answer `403 FEATURE_DISABLED`. A module that isn't live in a city answers `409 MODULE_UNAVAILABLE` with its state (`coming_soon`, `disabled` or `unavailable`). Vendor categories are switched on and off on the same screen; a switched-off category disappears from search and sign-up.
- **For the apps.** `GET /config?city=` or `?lat=&lng=` returns the switches, the city list and whether booking and the marketplace are live for that place, so the apps can show "Coming soon" instead of an empty list. Vendor search includes the same `availability` block.
- **Vendor availability.** Vendors block whole days or a few hours (`/vendors/me/time-off`) and can pause new bookings, either until a date or until they resume (`PUT /vendors/me/pause`). Blocked time disappears from customers' free slots and is refused at booking. Existing bookings are never cancelled automatically; a new block returns the clashing bookings so the vendor can reschedule or cancel each one.

## Safety and compliance rules

- **Report severity.** Animal cruelty and unsafe health or medication advice are high severity. Fraud, harassment, abuse and misinformation are medium. Everything else is low. The safety queue shows high severity first.
- **Auto-quarantine.** A high-severity report on a post or comment hides it at once if it comes from staff or from the owner of a live vendor listing (for example, a vet). Dismissing the report puts the content back, unless another high-severity report on it is still open.
- **Trade licence.** A vendor's licence is in one of four states: not uploaded, manual check needed, verified or mismatch. There is no government verification API, so staff record each check by hand.
- **Community dog badge.** New profiles wait until staff verify the territory and caregivers. If a caregiver moves the territory, a verified profile goes back into the queue.
- **Adoption sign-off.** After the lister approves an adopter, staff record the home check and a microchip appointment (required for dogs and cats), then certify the adoption. Certifying marks the listing adopted. Nurvia never takes an adoption fee.

## Not done yet

- **Screens for the newer API modules.** NFC tags, SOS / Lost & Found, the vendor workspace (staff, CRM, calendar, packages, visit records), settlements, seller onboarding, returns, loyalty, plans and the new admin tools all work through the API (see Swagger at `/api-docs`), but the admin panel and partner panel do not have screens for them yet (the partner panel does cover seller returns). Tag scans need a `/t/:code` page somewhere public.
- **NFC admin per Annexure D.** Tag minting, lifecycle and scan visibility are built; anything extra Annexure D asks for is unknown until it is provided.
- **Payouts.** Settlements are generated, approved and marked paid by staff; money is not moved automatically (no split-payment provider, cadence or reserve period is specified).
- **Cross-tenant publishing.** A white-label tenant's `nurviaVisibility` flags are stored, but listing its business or products inside the Nurvia tenant is not synced yet.
- **Subscription billing.** Plans and limits are enforced; charging for them is not built.
- An SMS/OTP provider, cloud file storage, an email provider and an AI provider (they need Nurvia's accounts and decisions). `GET /pets/:id/care-status` is the authorised context an AI assistant would answer from.
- CI and deployment configuration (Docker, staging and production environments).
- A shared rate-limit store such as Redis. The current in-memory store only works for a single API instance.
- GST invoices for marketplace orders.
- The mobile apps.
